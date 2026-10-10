// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.ansi`: strip ANSI escape codes, measure the terminal width of text,
// and style text in a way that respects `NO_COLOR`.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_ansi_width } = core.ops;
const {
  ArrayIsArray,
  ObjectFreeze,
  ObjectHasOwn,
  ObjectKeys,
  SafeRegExp,
  String,
  StringPrototypeReplace,
  TypeError,
} = primordials;
const { getStdoutNoColor, getStderrNoColor } = core.loadExtScript(
  "ext:deno_web/01_console.js",
);

// ECMA-48 control sequences: CSI (`ESC [` or the C1 byte 0x9B) with
// parameter, intermediate and final bytes; OSC (`ESC ]` up to BEL or ST),
// which hyperlinks use; and the other two-byte `ESC` sequences.
const ANSI_PATTERN = new SafeRegExp(
  "(?:\\x1b\\[|\\x9b)[0-?]*[ -/]*[@-~]" +
    "|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)" +
    "|\\x1b[@-Z\\\\-_]",
  "g",
);

function assertString(text, api) {
  if (typeof text !== "string") {
    throw new TypeError(`${api} expects a string`);
  }
}

/** Removes ANSI escape codes (colors, cursor movement, hyperlinks). */
function strip(text) {
  assertString(text, "Deno.ansi.strip()");
  return StringPrototypeReplace(text, ANSI_PATTERN, "");
}

/**
 * How many columns `text` takes in a terminal, ignoring escape codes. Wide
 * East Asian characters and emoji count as two.
 */
function width(text) {
  assertString(text, "Deno.ansi.width()");
  return op_done_ansi_width(strip(text));
}

// [open, close] SGR codes, matching the names `util.styleText()` uses.
const STYLES = {
  __proto__: null,
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  grey: [90, 39],
  brightRed: [91, 39],
  brightGreen: [92, 39],
  brightYellow: [93, 39],
  brightBlue: [94, 39],
  brightMagenta: [95, 39],
  brightCyan: [96, 39],
  brightWhite: [97, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  bgGray: [100, 49],
  bgBrightRed: [101, 49],
  bgBrightGreen: [102, 49],
  bgBrightYellow: [103, 49],
  bgBrightBlue: [104, 49],
  bgBrightMagenta: [105, 49],
  bgBrightCyan: [106, 49],
  bgBrightWhite: [107, 49],
};

/**
 * Wraps `text` in the escape codes for `format` (a style name or a list of
 * them). Returns `text` unchanged when colors are off for the target stream,
 * because of `NO_COLOR` or because it isn't a terminal, unless `force` is set.
 */
function style(format, text, options = { __proto__: null }) {
  assertString(text, "Deno.ansi.style()");
  const formats = ArrayIsArray(format) ? format : [format];
  let open = "";
  let close = "";
  for (let i = 0; i < formats.length; i++) {
    const name = formats[i];
    if (typeof name !== "string" || !ObjectHasOwn(STYLES, name)) {
      throw new TypeError(`Unknown style: ${String(name)}`);
    }
    open += `\x1b[${STYLES[name][0]}m`;
    close = `\x1b[${STYLES[name][1]}m` + close;
  }
  const stream = options.stream ?? "stdout";
  if (stream !== "stdout" && stream !== "stderr") {
    throw new TypeError('stream must be "stdout" or "stderr"');
  }
  const noColor = stream === "stderr" ? getStderrNoColor() : getStdoutNoColor();
  if (noColor && !options.force) return text;
  return open + text + close;
}

const ansi = ObjectFreeze({
  strip,
  style,
  /** The style names `style()` accepts. */
  styles: ObjectFreeze(ObjectKeys(STYLES)),
  width,
});

return { ansi };
})();
