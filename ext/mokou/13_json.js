// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.json5`, `Deno.jsonc` and `Deno.jsonl`: the JSON variants used for
// config files and logs.

(function () {
const { primordials } = __bootstrap;
const {
  ArrayFrom,
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  JSONParse,
  JSONStringify,
  MathMin,
  NumberIsFinite,
  NumberIsNaN,
  NumberParseInt,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectHasOwn,
  ObjectKeys,
  ReflectApply,
  RegExpPrototypeExec,
  RegExpPrototypeTest,
  SafeRegExp,
  SafeSet,
  SetPrototypeAdd,
  SetPrototypeDelete,
  SetPrototypeHas,
  String,
  StringFromCharCode,
  StringFromCodePoint,
  StringPrototypeCodePointAt,
  StringPrototypeIndexOf,
  StringPrototypeRepeat,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  StringPrototypeTrim,
  SyntaxError,
  TypeError,
} = primordials;

function assertString(text, api) {
  if (typeof text !== "string") {
    throw new TypeError(`${api} expects a string`);
  }
}

function position(text, index) {
  const lines = StringPrototypeSplit(
    StringPrototypeSlice(text, 0, index),
    "\n",
  );
  return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
}

// --- JSON5 (https://spec.json5.org) ------------------------------------------

const WHITESPACE = new SafeRegExp("[\\s\\uFEFF]", "u");
const ID_START = new SafeRegExp("[\\p{ID_Start}$_]", "u");
const ID_PART = new SafeRegExp("[\\p{ID_Continue}$\\u200C\\u200D]", "u");
const IDENTIFIER = new SafeRegExp(
  "^[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200C\\u200D]*$",
  "u",
);
const HEX_DIGITS = new SafeRegExp("^[0-9a-fA-F]+$");
const NUMBER = new SafeRegExp(
  "(?:0[xX][0-9a-fA-F]+|(?:(?:0|[1-9][0-9]*)(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)",
  "y",
);
const ESCAPES = {
  __proto__: null,
  "b": "\b",
  "f": "\f",
  "n": "\n",
  "r": "\r",
  "t": "\t",
  "v": "\v",
  "'": "'",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

function json5Parse(text) {
  assertString(text, "Deno.json5.parse()");
  let pos = 0;

  function fail(message) {
    throw new SyntaxError(`JSON5: ${message} at ${position(text, pos)}`);
  }

  function unexpected() {
    fail(
      pos >= text.length
        ? "Unexpected end of input"
        : `Unexpected character ${JSONStringify(text[pos])}`,
    );
  }

  function skip() {
    while (pos < text.length) {
      const c = text[pos];
      if (RegExpPrototypeTest(WHITESPACE, c)) {
        pos++;
      } else if (c === "/" && text[pos + 1] === "/") {
        while (pos < text.length && text[pos] !== "\n" && text[pos] !== "\r") {
          pos++;
        }
      } else if (c === "/" && text[pos + 1] === "*") {
        const end = StringPrototypeIndexOf(text, "*/", pos + 2);
        if (end === -1) fail("Unterminated comment");
        pos = end + 2;
      } else {
        break;
      }
    }
  }

  function hex(length) {
    const digits = StringPrototypeSlice(text, pos, pos + length);
    if (digits.length !== length || !RegExpPrototypeTest(HEX_DIGITS, digits)) {
      fail("Invalid escape");
    }
    pos += length;
    return NumberParseInt(digits, 16);
  }

  function string() {
    const quote = text[pos++];
    let out = "";
    while (true) {
      if (pos >= text.length) fail("Unterminated string");
      const c = text[pos++];
      if (c === quote) return out;
      if (c === "\n" || c === "\r") fail("Unescaped line break in string");
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = text[pos++];
      if (ObjectHasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
      } else if (e === "0" && !(text[pos] >= "0" && text[pos] <= "9")) {
        out += "\0";
      } else if (e === "x") {
        out += StringFromCharCode(hex(2));
      } else if (e === "u") {
        out += StringFromCharCode(hex(4));
      } else if (e === "\r") {
        // A line continuation.
        if (text[pos] === "\n") pos++;
      } else if (e === "\n" || e === "\u2028" || e === "\u2029") {
        // A line continuation.
      } else if (e === undefined || (e >= "1" && e <= "9")) {
        pos--;
        fail("Invalid escape");
      } else {
        out += e;
      }
    }
  }

  function identifier() {
    let out = "";
    while (pos < text.length) {
      let c;
      let length;
      if (text[pos] === "\\") {
        // A `\uXXXX` escape stands for the character it encodes.
        if (text[pos + 1] !== "u") fail("Invalid identifier escape");
        const start = pos;
        pos += 2;
        c = StringFromCharCode(hex(4));
        length = pos - start;
        pos = start;
      } else {
        c = StringFromCodePoint(StringPrototypeCodePointAt(text, pos));
        length = c.length;
      }
      const valid = out === ""
        ? RegExpPrototypeTest(ID_START, c)
        : RegExpPrototypeTest(ID_PART, c);
      if (!valid) break;
      out += c;
      pos += length;
    }
    if (out === "") unexpected();
    return out;
  }

  function word(literal) {
    if (!StringPrototypeStartsWith(text, literal, pos)) return false;
    const next = text[pos + literal.length];
    if (next !== undefined && RegExpPrototypeTest(ID_PART, next)) {
      return false;
    }
    pos += literal.length;
    return true;
  }

  function number() {
    let sign = 1;
    if (text[pos] === "+" || text[pos] === "-") {
      if (text[pos] === "-") sign = -1;
      pos++;
    }
    if (word("Infinity")) return sign * Infinity;
    if (word("NaN")) return NaN;
    NUMBER.lastIndex = pos;
    const match = RegExpPrototypeExec(NUMBER, text);
    if (!match) unexpected();
    pos += match[0].length;
    const next = text[pos];
    if (next !== undefined && RegExpPrototypeTest(ID_PART, next)) unexpected();
    const body = match[0];
    const value = body[0] === "0" && (body[1] === "x" || body[1] === "X")
      ? NumberParseInt(StringPrototypeSlice(body, 2), 16)
      : +body;
    return sign * value;
  }

  function set(object, key, value) {
    // Define rather than assign, so a "__proto__" key is an own property.
    ObjectDefineProperty(object, key, {
      __proto__: null,
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  function value(depth) {
    if (depth > 10_000) fail("Nesting too deep");
    skip();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const object = {};
      skip();
      if (text[pos] === "}") {
        pos++;
        return object;
      }
      while (true) {
        skip();
        const key = text[pos] === '"' || text[pos] === "'"
          ? string()
          : identifier();
        skip();
        if (text[pos] !== ":") unexpected();
        pos++;
        set(object, key, value(depth + 1));
        skip();
        if (text[pos] === ",") {
          pos++;
          skip();
          if (text[pos] === "}") {
            pos++;
            return object;
          }
        } else if (text[pos] === "}") {
          pos++;
          return object;
        } else {
          unexpected();
        }
      }
    }
    if (c === "[") {
      pos++;
      const array = [];
      skip();
      if (text[pos] === "]") {
        pos++;
        return array;
      }
      while (true) {
        ArrayPrototypePush(array, value(depth + 1));
        skip();
        if (text[pos] === ",") {
          pos++;
          skip();
          if (text[pos] === "]") {
            pos++;
            return array;
          }
        } else if (text[pos] === "]") {
          pos++;
          return array;
        } else {
          unexpected();
        }
      }
    }
    if (c === '"' || c === "'") return string();
    if (word("null")) return null;
    if (word("true")) return true;
    if (word("false")) return false;
    return number();
  }

  const result = value(0);
  skip();
  if (pos < text.length) unexpected();
  return result;
}

function indentation(space) {
  if (typeof space === "number") {
    return StringPrototypeRepeat(" ", MathMin(10, space > 0 ? space : 0));
  }
  if (typeof space === "string") return StringPrototypeSlice(space, 0, 10);
  return "";
}

/** Serializes to JSON5: like `JSON.stringify()`, but keeps `NaN` and
 * `Infinity` and leaves keys that are identifiers unquoted. */
function json5Stringify(value, space) {
  const indent = indentation(space);
  const stack = new SafeSet();

  function serialize(value, current) {
    if (value !== null && typeof value?.toJSON === "function") {
      value = ReflectApply(value.toJSON, value, []);
    }
    switch (typeof value) {
      case "string":
        return JSONStringify(value);
      case "boolean":
        return value ? "true" : "false";
      case "number":
        if (NumberIsNaN(value)) return "NaN";
        if (!NumberIsFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
        return String(value);
      case "bigint":
        throw new TypeError("Do not know how to serialize a BigInt");
      case "undefined":
      case "function":
      case "symbol":
        return undefined;
    }
    if (value === null) return "null";
    if (SetPrototypeHas(stack, value)) {
      throw new TypeError("Converting circular structure to JSON5");
    }
    SetPrototypeAdd(stack, value);
    const inner = current + indent;
    const parts = [];
    let open = "{";
    let close = "}";
    if (ArrayIsArray(value)) {
      open = "[";
      close = "]";
      for (let i = 0; i < value.length; i++) {
        ArrayPrototypePush(parts, serialize(value[i], inner) ?? "null");
      }
    } else {
      const keys = ObjectKeys(value);
      for (let i = 0; i < keys.length; i++) {
        const item = serialize(value[keys[i]], inner);
        if (item === undefined) continue;
        const key = RegExpPrototypeTest(IDENTIFIER, keys[i])
          ? keys[i]
          : JSONStringify(keys[i]);
        ArrayPrototypePush(parts, `${key}:${indent ? " " : ""}${item}`);
      }
    }
    SetPrototypeDelete(stack, value);
    if (parts.length === 0) return open + close;
    if (!indent) return open + ArrayPrototypeJoin(parts, ",") + close;
    return `${open}\n${inner}${
      ArrayPrototypeJoin(parts, `,\n${inner}`)
    },\n${current}${close}`;
  }

  return serialize(value, "");
}

const json5 = ObjectFreeze({ parse: json5Parse, stringify: json5Stringify });

// --- JSONC: JSON with comments and trailing commas ---------------------------

/** Returns the index of the next character that isn't whitespace or part of
 * a comment. */
function nextSignificant(text, i) {
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = StringPrototypeIndexOf(text, "*/", i + 2);
      if (end === -1) return text.length;
      i = end + 2;
    } else {
      break;
    }
  }
  return i;
}

function jsoncParse(text) {
  assertString(text, "Deno.jsonc.parse()");
  let out = "";
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      if (
        text[i + 1] === "*" &&
        StringPrototypeIndexOf(text, "*/", i + 2) === -1
      ) {
        throw new SyntaxError(
          `JSONC: Unterminated comment at ${position(text, i)}`,
        );
      }
      // Replace the comment with a space so tokens on either side stay apart.
      out += StringPrototypeSlice(text, start, i) + " ";
      i = text[i + 1] === "/"
        ? nextSignificant(text, i) // stops at the line break
        : StringPrototypeIndexOf(text, "*/", i + 2) + 2;
      start = i;
    } else if (c === ",") {
      const next = text[nextSignificant(text, i + 1)];
      if (next === "}" || next === "]") {
        out += StringPrototypeSlice(text, start, i);
        start = i + 1;
      }
      i++;
    } else {
      i++;
    }
  }
  out += StringPrototypeSlice(text, start);
  return JSONParse(out);
}

const jsonc = ObjectFreeze({ parse: jsoncParse });

// --- JSONL: one JSON value per line ------------------------------------------

const LINE_BREAK = new SafeRegExp("\\r?\\n");

function jsonlParse(text) {
  assertString(text, "Deno.jsonl.parse()");
  const lines = StringPrototypeSplit(text, LINE_BREAK);
  const values = [];
  for (let i = 0; i < lines.length; i++) {
    const line = StringPrototypeTrim(lines[i]);
    if (line === "") continue;
    try {
      ArrayPrototypePush(values, JSONParse(line));
    } catch (error) {
      throw new SyntaxError(`JSONL: line ${i + 1}: ${error.message}`);
    }
  }
  return values;
}

function jsonlStringify(values) {
  let out = "";
  const list = ArrayFrom(values);
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    const line = JSONStringify(value);
    if (line === undefined) {
      throw new TypeError(`Cannot serialize ${typeof value} as a JSONL line`);
    }
    out += line + "\n";
  }
  return out;
}

const jsonl = ObjectFreeze({ parse: jsonlParse, stringify: jsonlStringify });

return { json5, jsonc, jsonl };
})();
