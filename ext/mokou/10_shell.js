// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.$`: a tagged template that runs a command through the cross-platform
// shell `deno task` uses. Interpolated values are always quoted, so they are
// passed as single arguments and never parsed as shell syntax.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_shell_spawn, op_done_shell_wait, op_done_shell_kill } =
  core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  Error,
  JSONParse,
  ObjectEntries,
  ObjectPrototypeIsPrototypeOf,
  SafePromisePrototypeFinally,
  PromisePrototypeThen,
  PromiseReject,
  SafeRegExp,
  StringPrototypeReplace,
  StringPrototypeReplaceAll,
  StringPrototypeSplit,
  String,
  TypeError,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint8Array,
} = primordials;
const { pathFromURL } = core.loadExtScript("ext:deno_web/00_infra.js");
const { URLPrototype } = core.loadExtScript("ext:deno_web/00_url.js");

const EMPTY = new Uint8Array(0);
const TRAILING_NEWLINES = new SafeRegExp("(\\r?\\n)+$");
const NEWLINE = new SafeRegExp("\\r?\\n");

function isUint8Array(value) {
  return TypedArrayPrototypeGetSymbolToStringTag(value) === "Uint8Array";
}

/** Quotes `value` so the shell reads it as exactly one argument. */
function escape(value) {
  value = String(value);
  return "'" + StringPrototypeReplaceAll(value, "'", `'"'"'`) + "'";
}

class ShellRaw {
  constructor(text) {
    this.text = text;
  }
}

/** Inserts `text` into a `Deno.$` command without quoting it. */
function raw(text) {
  if (typeof text !== "string") {
    throw new TypeError("Deno.$.raw() expects a string");
  }
  return new ShellRaw(text);
}

function interpolate(value) {
  if (ObjectPrototypeIsPrototypeOf(ShellRaw.prototype, value)) {
    return value.text;
  }
  if (ArrayIsArray(value)) {
    return ArrayPrototypeJoin(ArrayPrototypeMap(value, interpolate), " ");
  }
  if (ObjectPrototypeIsPrototypeOf(URLPrototype, value)) {
    return escape(value.protocol === "file:" ? pathFromURL(value) : value.href);
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return escape(value);
    default:
      throw new TypeError(
        `Unsupported value in a Deno.$ command: ${
          value === null ? "null" : typeof value
        }. Pass a string, number, boolean, URL or array.`,
      );
  }
}

function buildScript(strings, values) {
  const parts = strings.raw ?? strings;
  let script = parts[0];
  for (let i = 0; i < values.length; i++) {
    script += interpolate(values[i]) + parts[i + 1];
  }
  return script;
}

function decode(bytes) {
  return core.decode(bytes);
}

/** Removes the trailing newline(s) a command usually prints. */
function trimTrailingNewlines(text) {
  return StringPrototypeReplace(text, TRAILING_NEWLINES, "");
}

class ShellOutput {
  /** The exit code. */
  code;
  /** Whether the exit code is 0. */
  success;
  /** Captured stdout. Empty when stdout wasn't captured. */
  stdout;
  /** Captured stderr. Empty when stderr wasn't captured. */
  stderr;

  constructor(code, stdout, stderr) {
    this.code = code;
    this.success = code === 0;
    this.stdout = stdout ?? EMPTY;
    this.stderr = stderr ?? EMPTY;
  }

  /** Stdout as text, without trailing newlines. */
  text() {
    return trimTrailingNewlines(decode(this.stdout));
  }

  /** Stdout parsed as JSON. */
  json() {
    return JSONParse(decode(this.stdout));
  }

  /** Stdout split into lines, without the final empty line. */
  lines() {
    const text = trimTrailingNewlines(decode(this.stdout));
    return text === "" ? [] : StringPrototypeSplit(text, NEWLINE);
  }
}

class ShellError extends Error {
  /** The exit code. */
  code;
  /** The command's output. */
  output;

  constructor(command, output) {
    super(`Command failed with exit code ${output.code}: ${command}`);
    this.name = "ShellError";
    this.code = output.code;
    this.output = output;
  }

  get stdout() {
    return this.output.stdout;
  }

  get stderr() {
    return this.output.stderr;
  }
}

const SIGNALS = ["SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT", "SIGABRT"];

class ShellCommand {
  #script;
  #cwd = undefined;
  #env = [];
  #stdin = "null";
  #stdinBytes = EMPTY;
  #stdout = "tee";
  #stderr = "tee";
  #noThrow = false;
  #signal = undefined;
  #rid = undefined;
  #promise = undefined;

  constructor(script) {
    this.#script = script;
  }

  #assertNotStarted(method) {
    if (this.#promise !== undefined) {
      throw new TypeError(
        `Cannot call ${method}() after the command has started`,
      );
    }
  }

  /** The working directory, relative to the current one. */
  cwd(path) {
    this.#assertNotStarted("cwd");
    this.#cwd = ObjectPrototypeIsPrototypeOf(URLPrototype, path)
      ? pathFromURL(path)
      : String(path);
    return this;
  }

  /** Sets environment variables on top of the inherited environment. */
  env(vars) {
    this.#assertNotStarted("env");
    const entries = ObjectEntries(vars);
    for (let i = 0; i < entries.length; i++) {
      ArrayPrototypePush(this.#env, [entries[i][0], String(entries[i][1])]);
    }
    return this;
  }

  /**
   * Where stdin comes from: bytes, `"inherit"` to share this program's stdin,
   * or `"null"` (the default) for no input.
   */
  stdin(input) {
    this.#assertNotStarted("stdin");
    if (input === "inherit" || input === "null") {
      this.#stdin = input;
      this.#stdinBytes = EMPTY;
    } else if (isUint8Array(input)) {
      this.#stdin = "piped";
      this.#stdinBytes = input;
    } else {
      throw new TypeError(
        'stdin() expects a Uint8Array, "inherit" or "null". Use stdinText() for a string.',
      );
    }
    return this;
  }

  /** Writes `text` to the command's stdin. */
  stdinText(text) {
    this.#assertNotStarted("stdinText");
    this.#stdin = "piped";
    this.#stdinBytes = core.encode(String(text));
    return this;
  }

  /** Captures stdout and stderr without printing them. */
  quiet() {
    this.#assertNotStarted("quiet");
    this.#stdout = "piped";
    this.#stderr = "piped";
    return this;
  }

  /** Resolves instead of rejecting when the exit code isn't 0. */
  nothrow() {
    this.#assertNotStarted("nothrow");
    this.#noThrow = true;
    return this;
  }

  /** Kills the command with SIGTERM when `signal` aborts. */
  signal(signal) {
    this.#assertNotStarted("signal");
    this.#signal = signal;
    return this;
  }

  /** Sends a signal to the running command. */
  kill(signal = "SIGTERM") {
    if (!ArrayPrototypeIncludes(SIGNALS, signal)) {
      throw new TypeError(`Unsupported signal for Deno.$: ${signal}`);
    }
    if (this.#rid !== undefined) {
      op_done_shell_kill(this.#rid, signal);
    }
  }

  #run() {
    if (this.#promise !== undefined) return this.#promise;
    try {
      this.#promise = this.#start();
    } catch (error) {
      this.#promise = PromiseReject(error);
    }
    return this.#promise;
  }

  async #start() {
    const signal = this.#signal;
    signal?.throwIfAborted();
    this.#rid = op_done_shell_spawn({
      script: this.#script,
      cwd: this.#cwd,
      env: this.#env,
      stdin: this.#stdin,
      stdout: this.#stdout,
      stderr: this.#stderr,
    }, this.#stdinBytes);
    const onAbort = () => this.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    let result;
    try {
      result = await op_done_shell_wait(this.#rid);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#rid = undefined;
    }
    signal?.throwIfAborted();
    const output = new ShellOutput(result.code, result.stdout, result.stderr);
    if (output.code !== 0 && !this.#noThrow) {
      throw new ShellError(this.#script, output);
    }
    return output;
  }

  // Captures stdout without printing it, unless the command already started.
  #captureStdout() {
    if (this.#promise === undefined && this.#stdout !== "null") {
      this.#stdout = "piped";
    }
    return this.#run();
  }

  /** Runs the command and resolves with stdout as text, trimmed of
   * trailing newlines. */
  text() {
    return PromisePrototypeThen(this.#captureStdout(), (o) => o.text());
  }

  /** Runs the command and resolves with stdout parsed as JSON. */
  json() {
    return PromisePrototypeThen(this.#captureStdout(), (o) => o.json());
  }

  /** Runs the command and resolves with the lines of stdout. */
  lines() {
    return PromisePrototypeThen(this.#captureStdout(), (o) => o.lines());
  }

  /** Runs the command and resolves with stdout as bytes. */
  bytes() {
    return PromisePrototypeThen(this.#captureStdout(), (o) => o.stdout);
  }

  then(onFulfilled, onRejected) {
    return PromisePrototypeThen(this.#run(), onFulfilled, onRejected);
  }

  catch(onRejected) {
    return PromisePrototypeThen(this.#run(), undefined, onRejected);
  }

  finally(onFinally) {
    return SafePromisePrototypeFinally(this.#run(), onFinally);
  }
}

/**
 * Runs a shell command:
 *
 *     const branch = await Deno.$`git branch --show-current`.text();
 *     await Deno.$`deno fmt ${files}`;
 */
function $(strings, ...values) {
  if (!ArrayIsArray(strings)) {
    throw new TypeError(
      "Deno.$ must be used as a tagged template: Deno.$`cmd`",
    );
  }
  return new ShellCommand(buildScript(strings, values));
}
$.raw = raw;
$.escape = escape;

return { $, ShellError, ShellOutput };
})();
