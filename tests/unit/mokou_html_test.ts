// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function escapeHTMLEscapesSpecialCharacters() {
  assertEquals(
    Deno.escapeHTML(`<a href="x" title='y'>Tom & Jerry</a>`),
    "&lt;a href=&quot;x&quot; title=&#x27;y&#x27;&gt;Tom &amp; Jerry&lt;/a&gt;",
  );
  assertEquals(Deno.escapeHTML("plain text"), "plain text");
  assertEquals(Deno.escapeHTML(""), "");
  assertEquals(Deno.escapeHTML("日本 & 🦕"), "日本 &amp; 🦕");
  // Already-escaped text is escaped again; escaping is not idempotent.
  assertEquals(Deno.escapeHTML("&amp;"), "&amp;amp;");
  assertEquals(Deno.escapeHTML(42), "42");
  assertEquals(Deno.escapeHTML(null), "null");
});

Deno.test(function markdownRendersCommonMark() {
  assertEquals(
    Deno.markdown.html("# Hello *world*\n\nSome `code`."),
    "<h1>Hello <em>world</em></h1>\n<p>Some <code>code</code>.</p>\n",
  );
  assertEquals(
    Deno.markdown.html("```ts\nconst a = 1 < 2;\n```"),
    '<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>\n',
  );
  assertThrows(
    () => Deno.markdown.html(1 as unknown as string),
    TypeError,
  );
});

Deno.test(function markdownRendersGfmByDefault() {
  const html = Deno.markdown.html(
    "| a | b |\n|---|--:|\n| 1 | 2 |\n\n~~old~~ https://deno.com\n\n- [x] done",
  );
  assert(html.includes("<table>"), html);
  assert(html.includes('<th align="right">b</th>'), html);
  assert(html.includes("<del>old</del>"), html);
  assert(
    html.includes('<a href="https://deno.com">https://deno.com</a>'),
    html,
  );
  assert(
    html.includes('<input type="checkbox" checked="" disabled="" />'),
    html,
  );
  const plain = Deno.markdown.html("~~old~~", { gfm: false });
  assertEquals(plain, "<p>~~old~~</p>\n");
});

Deno.test(function markdownDropsRawHtmlUnlessAllowed() {
  const source =
    '<script>alert(1)</script>\n\n<b>bold</b> [x](javascript:alert(1)) <img src="y" onerror="alert(1)">';
  const safe = Deno.markdown.html(source);
  assert(!safe.includes("<script"), safe);
  assert(!safe.includes("<b>"), safe);
  assert(!safe.includes("javascript:"), safe);
  assert(!safe.includes("onerror"), safe);
  assert(safe.includes("raw HTML omitted"), safe);

  const allowed = Deno.markdown.html(source, { allowHtml: true });
  assert(allowed.includes("<b>bold</b>"), allowed);
  assert(allowed.includes('href="javascript:alert(1)"'), allowed);
  // GFM's tag filter still neutralizes <script>.
  assert(allowed.includes("&lt;script>"), allowed);
});

Deno.test(function markdownOptions() {
  assertEquals(
    Deno.markdown.html("## Getting Started!", { headingIds: true }),
    '<h2><a href="#getting-started" aria-hidden="true" class="anchor" id="getting-started"></a>Getting Started!</h2>\n',
  );
  assertEquals(
    Deno.markdown.html("a\nb", { hardBreaks: true }),
    "<p>a<br />\nb</p>\n",
  );
  assertEquals(
    Deno.markdown.html(`"Hi" -- it's...`, { smartPunctuation: true }),
    "<p>“Hi” – it’s…</p>\n",
  );
  const footnotes = Deno.markdown.html("Text[^1].\n\n[^1]: Note.", {
    footnotes: true,
  });
  assert(footnotes.includes('class="footnotes"'), footnotes);
});
