// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function transpileStripsTypes() {
  const { code, map } = Deno.transpile(`
import type { A } from "./a.ts";
import { b, type C } from "./b.ts";
interface I { x: number }
enum E { One = 1 }
export function f(x: number, y?: A): C { return b(x as number) satisfies C; }
`);
  assert(!code.includes("interface"), code);
  assert(!code.includes("./a.ts"), code);
  assert(code.includes('import { b } from "./b.ts";'), code);
  assert(code.includes('E[E["One"] = 1]'), code);
  assert(code.includes("export function f(x, y) {"), code);
  assertEquals(map, undefined);
});

Deno.test(function transpileJsx() {
  const source = "export const el = <div class={1}><>hi</></div>;";
  const classic = Deno.transpile(source, { loader: "tsx" }).code;
  assert(classic.includes('React.createElement("div"'), classic);
  assert(classic.includes("React.Fragment"), classic);

  const custom = Deno.transpile(source, {
    loader: "jsx",
    jsx: { factory: "h", fragmentFactory: "Fragment" },
  }).code;
  assert(custom.includes('h("div"'), custom);

  const automatic = Deno.transpile(source, {
    filename: "component.tsx",
    jsx: { runtime: "automatic", importSource: "preact" },
  }).code;
  assert(automatic.includes('from "preact/jsx-runtime"'), automatic);

  const dev = Deno.transpile(source, {
    loader: "tsx",
    jsx: { runtime: "automatic", development: true },
  }).code;
  assert(dev.includes('from "react/jsx-dev-runtime"'), dev);

  const precompiled = Deno.transpile("export const el = <p>static</p>;", {
    loader: "tsx",
    jsx: { runtime: "precompile" },
  }).code;
  assert(precompiled.includes("<p>static</p>"), precompiled);
  assert(precompiled.includes("jsxTemplate"), precompiled);
});

Deno.test(function transpileLoaderFromFilename() {
  // A .js file can't contain types.
  assertThrows(
    () => Deno.transpile("const a: number = 1;", { filename: "a.js" }),
    SyntaxError,
  );
  assertEquals(
    Deno.transpile("const a: number = 1;", {
      filename: new URL("file:///src/a.ts"),
    }).code.trim(),
    "const a = 1;",
  );
});

Deno.test(function transpileSourceMaps() {
  const source = "const a: number = 1;\nconsole.log(a);\n";
  const inline = Deno.transpile(source, { sourceMap: "inline" }).code;
  assert(
    inline.includes("//# sourceMappingURL=data:application/json;base64,"),
    inline,
  );
  const external = Deno.transpile(source, {
    sourceMap: "external",
    filename: "file:///src/main.ts",
  });
  assert(!external.code.includes("sourceMappingURL=data:"), external.code);
  const map = JSON.parse(external.map!);
  assertEquals(map.version, 3);
  assertEquals(map.sources, ["file:///src/main.ts"]);
  assertEquals(map.sourcesContent, [source]);
});

Deno.test(function transpileOptions() {
  const commented = "// note\nconst a = 1; /* x */";
  assert(Deno.transpile(commented).code.includes("// note"));
  assert(
    !Deno.transpile(commented, { removeComments: true }).code.includes("note"),
  );

  const decorated = "@dec class A { @dec m() {} }";
  const legacy = Deno.transpile(decorated, { decorators: "legacy" }).code;
  assert(legacy.includes("_ts_decorate"), legacy);
  const tc39 = Deno.transpile(decorated).code;
  assert(!tc39.includes("_ts_decorate"), tc39);

  const verbatim = Deno.transpile('import { A } from "./a.ts";', {
    verbatimModuleSyntax: true,
  }).code;
  assert(verbatim.includes("./a.ts"), verbatim);
  assertEquals(
    Deno.transpile('import { A } from "./a.ts";').code.trim(),
    "",
  );
});

Deno.test(function transpileErrors() {
  const error = assertThrows(
    () => Deno.transpile("const = ;", { filename: "bad.ts" }),
    SyntaxError,
  );
  assert(error.message.includes("bad.ts:1:"), error.message);
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => Deno.transpile("", { loader: "py" as any }),
    TypeError,
    "Unsupported loader",
  );
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => Deno.transpile("", { sourceMap: "yes" as any }),
    TypeError,
  );
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => Deno.transpile("", { jsx: { runtime: "solid" as any } }),
    TypeError,
  );
  // deno-lint-ignore no-explicit-any
  assertThrows(() => Deno.transpile(1 as any), TypeError);
});
