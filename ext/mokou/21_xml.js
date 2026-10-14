// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.xml`: parse XML into elements and text, and write it back. See
// `xml.rs`.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_xml_parse } = core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ObjectEntries,
  ObjectFreeze,
  ObjectFromEntries,
  RegExpPrototypeTest,
  SafeArrayIterator,
  SafeRegExp,
  String,
  StringPrototypeRepeat,
  StringPrototypeReplace,
  TypeError,
} = primordials;

const NAME = new SafeRegExp("^[A-Za-z_:][A-Za-z0-9_:.\\-]*$");
// Characters XML 1.0 can't carry at all, even escaped.
const ILLEGAL = new SafeRegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]",
);
const TEXT_SPECIAL = new SafeRegExp("[&<>]", "g");
const ATTR_SPECIAL = new SafeRegExp('[&<>"\\t\\n\\r]', "g");
const TEXT_ESCAPES = {
  __proto__: null,
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
const ATTR_ESCAPES = {
  __proto__: null,
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\t": "&#9;",
  "\n": "&#10;",
  "\r": "&#13;",
};

function build(raw) {
  const children = [];
  for (let i = 0; i < raw.children.length; i++) {
    const child = raw.children[i];
    children[i] = typeof child === "string" ? child : build(child);
  }
  return {
    name: raw.name,
    attributes: ObjectFromEntries(raw.attributes),
    children,
  };
}

/** Parses a document into its root element. */
function parse(text, options = { __proto__: null }) {
  if (typeof text !== "string") {
    throw new TypeError("Deno.xml.parse() expects a string");
  }
  return build(op_done_xml_parse(text, !!options.keepWhitespace));
}

function checkText(text, what) {
  if (RegExpPrototypeTest(ILLEGAL, text)) {
    throw new TypeError(`${what} contains a character XML can't represent`);
  }
}

function write(element, indent, level, out) {
  if (element === null || typeof element !== "object") {
    throw new TypeError("Expected an element object with a name");
  }
  const { name } = element;
  if (typeof name !== "string" || !RegExpPrototypeTest(NAME, name)) {
    throw new TypeError(`Invalid element name: ${String(name)}`);
  }
  const pad = indent ? StringPrototypeRepeat(indent, level) : "";
  let open = `<${name}`;
  for (
    const { 0: key, 1: value } of new SafeArrayIterator(
      ObjectEntries(element.attributes ?? {}),
    )
  ) {
    if (!RegExpPrototypeTest(NAME, key)) {
      throw new TypeError(`Invalid attribute name: ${key}`);
    }
    const text = String(value);
    checkText(text, `Attribute ${key}`);
    open += ` ${key}="${
      StringPrototypeReplace(text, ATTR_SPECIAL, (c) => ATTR_ESCAPES[c])
    }"`;
  }
  const children = element.children ?? [];
  if (!ArrayIsArray(children)) {
    throw new TypeError("children must be an array");
  }
  if (children.length === 0) {
    ArrayPrototypePush(out, `${pad}${open}/>`);
    return;
  }
  // Mixed content is written inline, so indentation doesn't add text.
  let hasElement = false;
  let hasText = false;
  for (let i = 0; i < children.length; i++) {
    if (typeof children[i] === "object") hasElement = true;
    else hasText = true;
  }
  if (!hasElement || hasText || !indent) {
    let inner = "";
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (typeof child === "object") {
        const parts = [];
        write(child, "", 0, parts);
        inner += ArrayPrototypeJoin(parts, "");
      } else {
        const text = String(child);
        checkText(text, "Text");
        inner += StringPrototypeReplace(
          text,
          TEXT_SPECIAL,
          (c) => TEXT_ESCAPES[c],
        );
      }
    }
    ArrayPrototypePush(out, `${pad}${open}>${inner}</${name}>`);
    return;
  }
  ArrayPrototypePush(out, `${pad}${open}>`);
  for (let i = 0; i < children.length; i++) {
    write(children[i], indent, level + 1, out);
  }
  ArrayPrototypePush(out, `${pad}</${name}>`);
}

/** Writes an element as XML. */
function stringify(element, options = { __proto__: null }) {
  let indent = options.indent;
  if (typeof indent === "number") {
    indent = StringPrototypeRepeat(" ", indent);
  } else if (indent !== undefined && typeof indent !== "string") {
    throw new TypeError("indent must be a string or a number of spaces");
  }
  const lines = [];
  if (options.declaration) {
    lines[0] = '<?xml version="1.0" encoding="UTF-8"?>';
  }
  write(element, indent ?? "", 0, lines);
  return ArrayPrototypeJoin(lines, indent ? "\n" : "");
}

const xml = ObjectFreeze({ parse, stringify });

return { xml };
})();
