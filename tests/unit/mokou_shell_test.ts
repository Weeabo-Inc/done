// Copyright 2018-2026 the Deno authors. MIT license.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./test_util.ts";

const $ = Deno.$;
const decoder = new TextDecoder();

Deno.test(
  { permissions: { run: true } },
  async function shellInterpolationIsQuoted() {
    const value = `it's; echo injected $HOME *`;
    assertEquals(await $`echo ${value}`.quiet().text(), value);
    assertEquals(
      await $`printf '%s|' ${["a b", "c"]} ${42} ${""}`.quiet().text(),
      "a b|c|42||",
    );
    // A quoted assignment is a command name, not an environment variable.
    const output = await $`${"FOO=bar"} echo hi`.quiet().nothrow();
    assert(!output.success);
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellRawAndEscape() {
    assertEquals(await $`echo ${$.raw("a    b")}`.quiet().text(), "a b");
    assertEquals($.escape("it's"), `'it'"'"'s'`);
    assertThrows(() => $`echo ${null as unknown as string}`, TypeError);
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellOutputHelpers() {
    assertEquals(await $`echo '{"a":[1,2]}'`.json(), { a: [1, 2] });
    assertEquals(await $`echo a && echo b`.lines(), ["a", "b"]);
    assertEquals(await $`echo nothing > /dev/null`.lines(), []);
    assertEquals(decoder.decode(await $`echo hi`.bytes()), "hi\n");

    const output = await $`echo out; echo err >&2`.quiet();
    assertEquals(output.code, 0);
    assert(output.success);
    assertEquals(decoder.decode(output.stdout), "out\n");
    assertEquals(decoder.decode(output.stderr), "err\n");
    assertEquals(output.text(), "out");
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellNonZeroExit() {
    const error = await assertRejects(
      () => $`echo bad >&2; exit 3`.quiet(),
      Deno.ShellError,
      "Command failed with exit code 3",
    );
    assertEquals(error.code, 3);
    assertEquals(decoder.decode(error.stderr), "bad\n");

    const output = await $`exit 4`.nothrow();
    assertEquals(output.code, 4);
    assert(!output.success);
  },
);

Deno.test(
  { permissions: { run: true, read: true, write: true } },
  async function shellOptions() {
    const dir = await Deno.makeTempDir();
    try {
      assertEquals(
        await $`pwd`.cwd(dir).text(),
        await Deno.realPath(dir),
      );
      assertEquals(await $`echo $NAME`.env({ NAME: "mokou" }).text(), "mokou");
      assertEquals(await $`cat`.stdinText("piped").text(), "piped");
      assertEquals(
        await $`cat`.stdin(new TextEncoder().encode("bytes")).text(),
        "bytes",
      );
      // stdin is empty by default.
      assertEquals(await $`cat`.text(), "");
      await $`echo written > out.txt`.cwd(dir);
      assertEquals(await Deno.readTextFile(`${dir}/out.txt`), "written\n");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellLargeStdin() {
    const input = "x".repeat(1 << 20);
    assertEquals((await $`cat`.stdinText(input).bytes()).length, 1 << 20);
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellAbortAndKill() {
    const controller = new AbortController();
    const command = $`sleep 30`.quiet().signal(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assertRejects(() => command.then(), DOMException);

    const killed = $`sleep 30`.quiet().nothrow();
    const result = killed.then((output) => output.code);
    setTimeout(() => killed.kill("SIGKILL"), 50);
    assert((await result) !== 0);
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellOptionsAreFrozenOnceStarted() {
    const command = $`echo once`.quiet();
    await command;
    assertThrows(() => command.quiet(), TypeError, "after the command");
    // Awaiting again returns the same result instead of running again.
    assertEquals((await command).text(), "once");
  },
);

Deno.test(
  { permissions: { run: true } },
  async function shellSyntaxError() {
    await assertRejects(
      () => $`echo "unterminated`.then(),
      SyntaxError,
      "Invalid shell command",
    );
  },
);

Deno.test(
  { permissions: { run: ["echo"] } },
  async function shellRequiresUnrestrictedRun() {
    await assertRejects(
      () => $`echo hi`.then(),
      Deno.errors.NotCapable,
    );
  },
);
