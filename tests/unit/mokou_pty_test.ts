// Copyright 2018-2026 the Deno authors. MIT license.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./test_util.ts";

const ignore = Deno.build.os === "windows";

async function output(pty: Deno.PtyProcess): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pty.readable) chunks.push(chunk);
  return new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
  );
}

/** Reads until the output includes `marker`; the terminal echoes typed input
 * as soon as it arrives, so tests wait for a prompt before typing. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

Deno.test(
  { ignore, permissions: { run: ["sh"] } },
  async function spawnPtyRunsInATerminal() {
    const pty = Deno.spawnPty("sh", {
      args: [
        "-c",
        'test -t 0 && test -t 1 && echo tty; stty size; echo "$TERM"; read line; echo "got:$line"; exit 3',
      ],
      cols: 100,
      rows: 30,
    });
    assert(pty instanceof Deno.PtyProcess);
    assertEquals(typeof pty.pid, "number");
    const reader = pty.readable.getReader();
    let text = await readUntil(reader, "xterm-256color\r\n");
    await pty.write("hello\n");
    text += await readUntil(reader, "got:hello\r\n");
    assertEquals(await pty.status, { success: false, code: 3, signal: null });
    assertEquals((await reader.read()).done, true);
    // The terminal echoes input and turns "\n" into "\r\n".
    assertEquals(
      text,
      "tty\r\n30 100\r\nxterm-256color\r\nhello\r\ngot:hello\r\n",
    );
  },
);

Deno.test(
  { ignore, permissions: { run: ["sh"] } },
  async function spawnPtyWritableStreamAndResize() {
    const pty = Deno.spawnPty("sh", { args: ["-c", "read x; stty size"] });
    const text = output(pty);
    pty.resize(120, 40);
    const writer = pty.writable.getWriter();
    await writer.write(new TextEncoder().encode("go\n"));
    writer.releaseLock();
    assertEquals((await pty.status).success, true);
    assertStringIncludes(await text, "40 120");
    // Resizing after exit does nothing.
    pty.resize(10, 10);
  },
);

Deno.test(
  { ignore, permissions: { run: ["sleep"] } },
  async function spawnPtyKill() {
    const pty = Deno.spawnPty("sleep", { args: ["30"] });
    const text = output(pty);
    pty.kill("SIGKILL");
    assertEquals(await pty.status, {
      success: false,
      code: 137,
      signal: "SIGKILL",
    });
    await text;
    assertThrows(() => pty.kill(), TypeError, "already terminated");
  },
);

Deno.test(
  { ignore, permissions: { run: ["sh"], read: true, write: true } },
  async function spawnPtyEnvAndCwd() {
    const dir = await Deno.realPath(await Deno.makeTempDir());
    try {
      const pty = Deno.spawnPty("sh", {
        args: ["-c", 'echo "$FOO $TERM $HOME"; pwd'],
        env: { FOO: "bar", TERM: "dumb" },
        cwd: dir,
        clearEnv: true,
      });
      const text = await output(pty);
      await pty.status;
      // `clearEnv` leaves only what was passed, so HOME is empty.
      assertEquals(text, `bar dumb \r\n${dir}\r\n`);
    } finally {
      await Deno.remove(dir);
    }
  },
);

Deno.test(
  { ignore, permissions: { run: ["sh"] } },
  function spawnPtyChecksPermissions() {
    assertThrows(
      () => Deno.spawnPty("sleep", { args: ["1"] }),
      Deno.errors.NotCapable,
    );
    // As with `Deno.Command`, LD_* variables need unrestricted --allow-run.
    assertThrows(
      () => Deno.spawnPty("sh", { env: { LD_PRELOAD: "/tmp/evil.so" } }),
      Deno.errors.NotCapable,
      "LD_PRELOAD",
    );
  },
);

Deno.test(
  { ignore, permissions: { run: true } },
  function spawnPtyValidatesArguments() {
    assertThrows(() => Deno.spawnPty("sh", { cols: 0 }), TypeError, "cols");
    assertThrows(() => Deno.spawnPty("sh", { rows: 1.5 }), TypeError, "rows");
    assertThrows(
      () => Deno.spawnPty("definitely-not-a-command-mokou"),
      Deno.errors.NotFound,
    );
    assertThrows(
      // deno-lint-ignore no-explicit-any
      () => new (Deno.PtyProcess as any)(),
      TypeError,
      "Illegal constructor",
    );
  },
);
