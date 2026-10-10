// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.escapeHTML()` and `Deno.markdown`: safe text for HTML, and Markdown
// rendered to HTML.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_markdown_html } = core.ops;
const {
  ObjectFreeze,
  RegExpPrototypeTest,
  SafeRegExp,
  String,
  StringPrototypeReplace,
  TypeError,
} = primordials;

const SPECIAL = new SafeRegExp("[&<>\"']");
const SPECIAL_ALL = new SafeRegExp("[&<>\"']", "g");
const ENTITIES = {
  __proto__: null,
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

/** Escapes `& < > " '`, so the result is safe in element content and in
 * quoted attribute values. */
function escapeHTML(value) {
  const text = typeof value === "string" ? value : String(value);
  // Most strings need no escaping; skip the copy for them.
  if (!RegExpPrototypeTest(SPECIAL, text)) return text;
  return StringPrototypeReplace(text, SPECIAL_ALL, (c) => ENTITIES[c]);
}

function html(source, options = { __proto__: null }) {
  if (typeof source !== "string") {
    throw new TypeError("Markdown source must be a string");
  }
  return op_done_markdown_html(source, {
    gfm: options.gfm ?? true,
    footnotes: !!options.footnotes,
    headingIds: !!options.headingIds,
    hardBreaks: !!options.hardBreaks,
    smartPunctuation: !!options.smartPunctuation,
    allowHtml: !!options.allowHtml,
  });
}

const markdown = ObjectFreeze({ html });

return { escapeHTML, markdown };
})();
