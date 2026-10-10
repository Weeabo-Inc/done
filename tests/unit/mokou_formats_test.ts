// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function doneToml() {
  const value = Deno.toml.parse(`
title = "Mokou"
[owner]
name = "Weeabo"
born = 1979-05-27T07:32:00Z
[[servers]]
port = 8000
[[servers]]
port = 8001
`);
  assertEquals(value, {
    title: "Mokou",
    owner: { name: "Weeabo", born: "1979-05-27T07:32:00Z" },
    servers: [{ port: 8000 }, { port: 8001 }],
  });
  const text = Deno.toml.stringify({ a: 1, b: { c: "x" } });
  assertEquals(Deno.toml.parse(text), { a: 1, b: { c: "x" } });
  assertThrows(() => Deno.toml.parse("a = "), SyntaxError, "Invalid TOML");
  // @ts-expect-error top level must be an object
  assertThrows(() => Deno.toml.stringify([1]), TypeError);
});

Deno.test(function doneYaml() {
  assertEquals(Deno.yaml.parse("a: 1\nb:\n  - x\n  - true\n"), {
    a: 1,
    b: ["x", true],
  });
  assertEquals(Deno.yaml.parseAll("a: 1\n---\nb: 2\n"), [{ a: 1 }, { b: 2 }]);
  assertEquals(Deno.yaml.parse(""), null);
  const text = Deno.yaml.stringify({ list: [1, 2], nested: { ok: true } });
  assertEquals(Deno.yaml.parse(text), { list: [1, 2], nested: { ok: true } });
  assertThrows(() => Deno.yaml.parse("a: [1"), SyntaxError, "Invalid YAML");
});

Deno.test(function doneCsv() {
  const text = 'name,age\n"Lovelace, Ada",36\nHopper,85\n';
  assertEquals(Deno.csv.parse(text), [
    ["name", "age"],
    ["Lovelace, Ada", "36"],
    ["Hopper", "85"],
  ]);
  assertEquals(Deno.csv.parse(text, { header: true }), [
    { name: "Lovelace, Ada", age: "36" },
    { name: "Hopper", age: "85" },
  ]);
  assertEquals(Deno.csv.parse("a;b\n1;2", { separator: ";" }), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assertEquals(
    Deno.csv.stringify([["a", "b,c"], ["1", 'say "hi"']]),
    'a,"b,c"\n1,"say ""hi"""\n',
  );
  assertEquals(
    Deno.csv.stringify([{ a: 1, b: 2 }, { b: 3, c: null }]),
    "a,b,c\n1,2,\n,3,\n",
  );
  assertEquals(
    Deno.csv.stringify([{ a: 1, b: 2 }], { columns: ["b"] }),
    "b\n2\n",
  );
  assertThrows(
    () => Deno.csv.parse("a", { separator: "ab" }),
    TypeError,
  );
});

Deno.test(function doneJson5Parse() {
  const value = Deno.json5.parse(`// A comment
{
  unquoted: 'single',
  "double": "x",
  hex: 0xFF,
  numbers: [+1, -2, .5, 5., 1e3, Infinity, -Infinity],
  /* block */ trailing: [1, 2,],
  escapes: 'a\\x41\\u0042\\'\\
c',
  $id_1: null,
}`);
  assertEquals(value, {
    unquoted: "single",
    double: "x",
    hex: 255,
    numbers: [1, -2, 0.5, 5, 1000, Infinity, -Infinity],
    trailing: [1, 2],
    escapes: "aAB'c",
    $id_1: null,
  });
  assertEquals(Number.isNaN(Deno.json5.parse("NaN")), true);
  // "__proto__" is an own key, not the prototype.
  const proto = Deno.json5.parse('{"__proto__": {"polluted": true}}');
  assertEquals(Object.hasOwn(proto, "__proto__"), true);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test(function doneJson5Errors() {
  assertThrows(
    () => Deno.json5.parse("{a: 1,\n  b: }"),
    SyntaxError,
    "line 2, column 6",
  );
  assertThrows(() => Deno.json5.parse("01"), SyntaxError);
  assertThrows(() => Deno.json5.parse("'unterminated"), SyntaxError);
  assertThrows(() => Deno.json5.parse("[1] 2"), SyntaxError);
  assertThrows(() => Deno.json5.parse("/* open"), SyntaxError);
});

Deno.test(function doneJson5Stringify() {
  assertEquals(
    Deno.json5.stringify({ a: 1, "b-c": [NaN, -Infinity, "s"], d: undefined }),
    '{a:1,"b-c":[NaN,-Infinity,"s"]}',
  );
  assertEquals(
    Deno.json5.stringify({ a: [1, { b: 2 }], e: {} }, 2),
    "{\n  a: [\n    1,\n    {\n      b: 2,\n    },\n  ],\n  e: {},\n}",
  );
  const value = { list: [1, "two", { three: 3 }], date: new Date(0) };
  assertEquals(
    Deno.json5.parse(Deno.json5.stringify(value)!),
    JSON.parse(JSON.stringify(value)),
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertThrows(() => Deno.json5.stringify(cycle), TypeError);
});

Deno.test(function doneJsonc() {
  assertEquals(
    Deno.jsonc.parse(`{
  // line comment
  "url": "http://example.com // not a comment",
  /* block */ "list": [1, 2, /* x */],
  "quote": "a \\" // still a string",
}`),
    {
      url: "http://example.com // not a comment",
      list: [1, 2],
      quote: 'a " // still a string',
    },
  );
  // Only comments and trailing commas: other JSON5 syntax is still an error.
  assertThrows(() => Deno.jsonc.parse("{a: 1}"), SyntaxError);
  assertThrows(() => Deno.jsonc.parse('{"a": 1 /* open'), SyntaxError);
});

Deno.test(function doneJsonl() {
  assertEquals(Deno.jsonl.parse('{"a":1}\n\n[2]\r\n"x"\n'), [
    { a: 1 },
    [2],
    "x",
  ]);
  assertThrows(() => Deno.jsonl.parse("1\n{bad"), SyntaxError, "line 2");
  assertEquals(Deno.jsonl.stringify([{ a: 1 }, 2, "s"]), '{"a":1}\n2\n"s"\n');
  assertEquals(Deno.jsonl.stringify(new Set([1, 2])), "1\n2\n");
  assertThrows(() => Deno.jsonl.stringify([undefined]), TypeError);
});
