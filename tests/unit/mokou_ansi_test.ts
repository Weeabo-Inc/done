// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function ansiStrip() {
  assertEquals(Deno.ansi.strip("\x1b[1m\x1b[31mred\x1b[39m\x1b[22m"), "red");
  // Hyperlinks (OSC 8), cursor movement and C1 CSI.
  assertEquals(
    Deno.ansi.strip("\x1b]8;;https://mokou.dev\x07link\x1b]8;;\x1b\\"),
    "link",
  );
  assertEquals(Deno.ansi.strip("a\x1b[2Kb\x1b[1;5Hc\x9b31md"), "abcd");
  assertEquals(Deno.ansi.strip("plain"), "plain");
});

Deno.test(function ansiWidth() {
  assertEquals(Deno.ansi.width("abc"), 3);
  assertEquals(Deno.ansi.width("日本語"), 6);
  assertEquals(Deno.ansi.width("\x1b[31mab\x1b[0m"), 2);
  assertEquals(Deno.ansi.width("é"), 1);
  assertEquals(Deno.ansi.width(""), 0);
});

Deno.test(function ansiStyle() {
  assertEquals(
    Deno.ansi.style(["bold", "green"], "ok", { force: true }),
    "\x1b[1m\x1b[32mok\x1b[39m\x1b[22m",
  );
  assertEquals(
    Deno.ansi.style("bgRed", "x", { force: true }),
    "\x1b[41mx\x1b[49m",
  );
  // The test runner's stdout is not a terminal, so colors are off.
  assertEquals(Deno.ansi.style("red", "x"), "x");
  assertEquals(Deno.ansi.styles.includes("brightCyan"), true);
  // @ts-expect-error unknown style
  assertThrows(() => Deno.ansi.style("purple", "x"), TypeError, "purple");
});
