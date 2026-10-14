// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function xmlParsesADocument() {
  const root = Deno.xml.parse(`<?xml version="1.0" encoding="UTF-8"?>
<!-- feed -->
<feed xmlns:a="urn:a" id="f&amp;1">
  <a:entry n='1'>Tom &amp; Jerry &lt;3 &#x41;&#66;</a:entry>
  <entry><![CDATA[<raw> & text]]></entry>
  <empty/>
  <mixed>one <b>two</b> three</mixed>
</feed>`);
  assertEquals(root, {
    name: "feed",
    attributes: { "xmlns:a": "urn:a", id: "f&1" },
    children: [
      {
        name: "a:entry",
        attributes: { n: "1" },
        children: ["Tom & Jerry <3 AB"],
      },
      { name: "entry", attributes: {}, children: ["<raw> & text"] },
      { name: "empty", attributes: {}, children: [] },
      {
        name: "mixed",
        attributes: {},
        children: [
          "one ",
          { name: "b", attributes: {}, children: ["two"] },
          " three",
        ],
      },
    ],
  });
});

Deno.test(function xmlWhitespace() {
  const source = "<a>\n  <b> x </b>\n</a>";
  assertEquals(Deno.xml.parse(source).children.length, 1);
  assertEquals(Deno.xml.parse(source, { keepWhitespace: true }).children, [
    "\n  ",
    { name: "b", attributes: {}, children: [" x "] },
    "\n",
  ]);
  // Text-only elements are never touched.
  assertEquals(Deno.xml.parse("<a>  </a>").children, ["  "]);
});

Deno.test(function xmlRejectsMalformedAndHostileDocuments() {
  for (
    const bad of [
      "",
      "<a>",
      "<a></b>",
      "<a/><b/>",
      "plain text",
      "<a>&undefined;</a>",
      '<a x="1" x="2"/>',
      '<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>',
    ]
  ) {
    assertThrows(() => Deno.xml.parse(bad), SyntaxError, "Invalid XML", bad);
  }
  assertThrows(
    () => Deno.xml.parse("<a>".repeat(300) + "</a>".repeat(300)),
    SyntaxError,
    "nested too deeply",
  );
  assertThrows(() => Deno.xml.parse(1 as unknown as string), TypeError);
  // Attribute names like __proto__ stay plain data.
  const root = Deno.xml.parse('<a __proto__="x"/>');
  assertEquals(Object.getPrototypeOf(root.attributes), Object.prototype);
  assertEquals(Object.keys(root.attributes), ["__proto__"]);
});

Deno.test(function xmlStringify() {
  const element = {
    name: "feed",
    attributes: { id: 'a"b&c<d>', note: "line\nbreak" },
    children: [
      { name: "entry", attributes: { n: 1 }, children: ["Tom & Jerry <3"] },
      { name: "empty" },
    ],
  };
  assertEquals(
    Deno.xml.stringify(element),
    '<feed id="a&quot;b&amp;c&lt;d&gt;" note="line&#10;break">' +
      '<entry n="1">Tom &amp; Jerry &lt;3</entry><empty/></feed>',
  );
  assertEquals(
    Deno.xml.stringify(element, { indent: 2, declaration: true }),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<feed id="a&quot;b&amp;c&lt;d&gt;" note="line&#10;break">\n' +
      '  <entry n="1">Tom &amp; Jerry &lt;3</entry>\n' +
      "  <empty/>\n" +
      "</feed>",
  );
  // Mixed content stays inline, so indentation adds no text.
  assertEquals(
    Deno.xml.stringify(
      { name: "p", children: ["a ", { name: "b", children: ["c"] }, " d"] },
      { indent: "\t" },
    ),
    "<p>a <b>c</b> d</p>",
  );
});

Deno.test(function xmlStringifyRoundTrips() {
  const source = {
    name: "doc",
    attributes: { a: '1 < 2 & "3"\t' },
    children: [
      { name: "x:y", attributes: {}, children: ["]]> & <![CDATA[ é\u{1F995}"] },
      { name: "z", attributes: {}, children: [] },
    ],
  };
  assertEquals(Deno.xml.parse(Deno.xml.stringify(source)), source);
  assertEquals(
    Deno.xml.parse(Deno.xml.stringify(source, { indent: 2 })),
    source,
  );
});

Deno.test(function xmlStringifyValidatesInput() {
  assertThrows(() => Deno.xml.stringify({ name: "1bad" }), TypeError, "name");
  assertThrows(() => Deno.xml.stringify({ name: "a b" }), TypeError, "name");
  assertThrows(
    () => Deno.xml.stringify({ name: "a", attributes: { "x y": "1" } }),
    TypeError,
    "attribute name",
  );
  assertThrows(
    () => Deno.xml.stringify({ name: "a", children: ["bad \u0001 char"] }),
    TypeError,
    "can't represent",
  );
  assertThrows(
    () => Deno.xml.stringify({ name: "a", attributes: { x: "\u0000" } }),
    TypeError,
    "can't represent",
  );
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => Deno.xml.stringify({ name: "a", children: "text" as any }),
    TypeError,
    "array",
  );
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => Deno.xml.stringify(null as any),
    TypeError,
  );
  assert(true);
});
