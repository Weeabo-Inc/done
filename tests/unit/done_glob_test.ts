// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertRejects, assertThrows } from "./test_util.ts";

function setup(): string {
  const root = Deno.makeTempDirSync();
  for (
    const file of [
      "a.ts",
      "b.js",
      "src/c.ts",
      "src/c_test.ts",
      "src/deep/d.ts",
      ".hidden/e.ts",
      "src/.f.ts",
      "node_modules/pkg/g.ts",
    ]
  ) {
    const path = `${root}/${file}`;
    Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(path, "");
  }
  return root;
}

Deno.test(
  { permissions: { read: true, write: true } },
  async function doneGlob() {
    const root = setup();
    try {
      assertEquals(Deno.globSync("*.ts", { root }), ["a.ts"]);
      assertEquals(Deno.globSync("src/**/*.ts", { root }), [
        "src/c.ts",
        "src/c_test.ts",
        "src/deep/d.ts",
      ]);
      assertEquals(
        Deno.globSync("**/*.ts", {
          root,
          exclude: ["**/*_test.ts", "node_modules/**"],
        }),
        ["a.ts", "src/c.ts", "src/deep/d.ts"],
      );
      assertEquals(
        Deno.globSync("src/*.ts", { root, includeHidden: true }),
        ["src/.f.ts", "src/c.ts", "src/c_test.ts"],
      );
      assertEquals(Deno.globSync(".hidden/*.ts", { root }), [".hidden/e.ts"]);
      assertEquals(Deno.globSync(["*.ts", "*.js"], { root }), ["a.ts", "b.js"]);
      assertEquals(Deno.globSync("*.{ts,js}", { root }), ["a.ts", "b.js"]);
      assertEquals(
        Deno.globSync("src/*", { root, includeDirs: true, withFileTypes: true })
          .filter((e) => e.isDirectory)
          .map((e) => e.path),
        ["src/deep"],
      );
      assertEquals(await Deno.glob("src/deep/*", { root }), ["src/deep/d.ts"]);
      assertEquals(Deno.globSync("missing/**", { root }), []);
      assertThrows(() => Deno.globSync("[", { root }), TypeError);
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  },
);

Deno.test(
  { permissions: { read: false } },
  async function doneGlobRequiresRead() {
    assertThrows(() => Deno.globSync("*"), Deno.errors.NotCapable);
    await assertRejects(() => Deno.glob("*"), Deno.errors.NotCapable);
  },
);
