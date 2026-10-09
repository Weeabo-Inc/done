// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, parseArgs as stdParseArgs } from "./test_util.ts";

// Deno.parseArgs is meant to be a drop-in replacement for @std/cli parseArgs,
// so each case is checked against it.
const cases: [string[], Deno.ParseArgsOptions?][] = [
  [["a", "b"]],
  [["--name", "x", "-v", "file.ts"]],
  [["--name=x", "--count", "3", "-abc"]],
  [["-n5", "--no-color"], { negatable: ["color"], boolean: ["color"] }],
  [["--help", "x"], { boolean: ["help"] }],
  [["-h"], { boolean: ["help"], alias: { h: "help" } }],
  [["--port", "8000"], { string: ["port"] }],
  [["--tag", "a", "--tag", "b"], { collect: ["tag"], string: ["tag"] }],
  [[], { default: { name: "world" }, boolean: ["debug"] }],
  [["--a.b", "1"]],
  [["x", "--flag", "y"], { stopEarly: true }],
  [["x", "--", "--not-a-flag"], { "--": true }],
  [["x", "--", "--not-a-flag"]],
  [["--verbose", "false"], { boolean: ["verbose"] }],
  [["-"]],
];

Deno.test(function doneParseArgsMatchesStd() {
  for (const [args, options] of cases) {
    assertEquals(
      Deno.parseArgs(args, options),
      // deno-lint-ignore no-explicit-any
      stdParseArgs(args, options as any),
      `parseArgs(${JSON.stringify(args)}, ${JSON.stringify(options)})`,
    );
  }
});

Deno.test(function doneParseArgsUnknown() {
  const unknown: string[] = [];
  const result = Deno.parseArgs(["--known", "--other", "pos"], {
    boolean: ["known"],
    unknown: (arg) => {
      unknown.push(arg);
      return false;
    },
  });
  // `pos` is taken as the value of `--other`, so both are dropped together.
  assertEquals(result, { _: [], known: true });
  assertEquals(unknown, ["--other"]);
});

Deno.test(function doneParseArgsIgnoresProto() {
  const result = Deno.parseArgs(["--__proto__.polluted", "1"]);
  // deno-lint-ignore no-explicit-any
  assertEquals(({} as any).polluted, undefined);
  assertEquals(result._, []);
});
