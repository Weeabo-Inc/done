// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.spawnPty()`: run a program in a pseudo-terminal. See `pty.rs`.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_pty_kill,
  op_done_pty_resize,
  op_done_pty_spawn,
  op_done_pty_wait,
} = core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeMap,
  NumberIsInteger,
  ObjectEntries,
  PromisePrototypeThen,
  String,
  Symbol,
  TypeError,
} = primordials;
const { readableStreamForRid, writableStreamForRid } = core.loadExtScript(
  "ext:deno_web/06_streams.js",
);
const { pathFromURL } = core.loadExtScript("ext:deno_web/00_infra.js");

const constructorKey = Symbol("PtyProcess");

function size(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!NumberIsInteger(value) || value < 1 || value > 0xffff) {
    throw new TypeError(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

class PtyProcess {
  #rid;
  #writeRid;
  #pid;
  #readable;
  #writable;
  #status;
  #exited = false;

  constructor(key, spawned) {
    if (key !== constructorKey) throw new TypeError("Illegal constructor");
    this.#rid = spawned.rid;
    this.#writeRid = spawned.writeRid;
    this.#pid = spawned.pid;
    this.#readable = readableStreamForRid(spawned.readRid);
    this.#writable = writableStreamForRid(spawned.writeRid, false);
    this.#status = PromisePrototypeThen(op_done_pty_wait(this.#rid), (s) => {
      this.#exited = true;
      // Nothing can read input any more; the output closes itself once
      // drained.
      core.tryClose(this.#rid);
      core.tryClose(this.#writeRid);
      return {
        success: s.code === 0 && s.signal === null,
        code: s.code,
        signal: s.signal ?? null,
      };
    });
  }

  get pid() {
    return this.#pid;
  }

  /** Everything the program writes to the terminal. */
  get readable() {
    return this.#readable;
  }

  /** What the program reads from the terminal, as if typed. */
  get writable() {
    return this.#writable;
  }

  get status() {
    return this.#status;
  }

  /** Types `data` into the terminal. */
  async write(data) {
    const bytes = typeof data === "string" ? core.encode(data) : data;
    await core.writeAll(this.#writeRid, bytes);
  }

  resize(cols, rows) {
    if (this.#exited) return;
    op_done_pty_resize(
      this.#rid,
      size(cols, undefined, "cols"),
      size(rows, undefined, "rows"),
    );
  }

  kill(signal = "SIGTERM") {
    if (this.#exited) {
      throw new TypeError("Child process has already terminated");
    }
    op_done_pty_kill(this.#rid, signal);
  }
}

function spawnPty(command, options = { __proto__: null }) {
  const cmd = pathFromURL(command);
  if (typeof cmd !== "string") {
    throw new TypeError("Command must be a string or a file: URL");
  }
  const args = options.args ?? [];
  if (!ArrayIsArray(args)) throw new TypeError("args must be an array");
  const spawned = op_done_pty_spawn({
    cmd,
    args: ArrayPrototypeMap(args, String),
    cwd: options.cwd === undefined ? undefined : pathFromURL(options.cwd),
    env: options.env === undefined ? [] : ArrayPrototypeMap(
      ObjectEntries(options.env),
      ({ 0: key, 1: value }) => [key, String(value)],
    ),
    clearEnv: !!options.clearEnv,
    cols: size(options.cols, 80, "cols"),
    rows: size(options.rows, 24, "rows"),
  });
  return new PtyProcess(constructorKey, spawned);
}

return { spawnPty, PtyProcess };
})();
