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
