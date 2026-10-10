// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.markdown.html()`: CommonMark and GitHub Flavored Markdown to HTML,
//! with comrak (already part of the binary for `deno doc --html`).

use deno_core::op2;
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MarkdownOptions {
  /// Tables, strikethrough, autolinks and task lists. Default on.
  gfm: Option<bool>,
  footnotes: bool,
  /// Adds `id` attributes to headings, made from their text.
  heading_ids: bool,
  /// Renders soft line breaks as `<br>`.
  hard_breaks: bool,
  /// Curly quotes, en and em dashes and ellipses.
  smart_punctuation: bool,
  /// Keeps raw HTML and links with any scheme. Off by default, so untrusted
  /// Markdown can't inject scripts.
  allow_html: bool,
}

pub fn render(source: &str, options: &MarkdownOptions) -> String {
  let gfm = options.gfm.unwrap_or(true);
  let mut comrak = comrak::Options::default();
  comrak.extension.table = gfm;
  comrak.extension.strikethrough = gfm;
  comrak.extension.autolink = gfm;
  comrak.extension.tasklist = gfm;
  // GFM disallows a few dangerous tags even when raw HTML is allowed.
  comrak.extension.tagfilter = gfm;
  comrak.extension.footnotes = options.footnotes;
  comrak.extension.header_ids = options.heading_ids.then(String::new);
  comrak.parse.smart = options.smart_punctuation;
  comrak.render.hardbreaks = options.hard_breaks;
  comrak.render.unsafe_ = options.allow_html;
  comrak::markdown_to_html(source, &comrak)
}

#[op2]
#[string]
pub fn op_done_markdown_html(
  #[string] source: &str,
  #[serde] options: MarkdownOptions,
) -> String {
  render(source, &options)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn renders() {
    let options = MarkdownOptions::default();
    assert_eq!(
      render("# Hi *there*", &options),
      "<h1>Hi <em>there</em></h1>\n"
    );
    assert!(render("| a |\n|---|\n| b |", &options).contains("<table>"));
    // Raw HTML and script URLs are dropped unless allowed.
    let unsafe_md = "<script>x</script>\n\n[a](javascript:alert(1))";
    let html = render(unsafe_md, &options);
    assert!(!html.contains("<script>") && !html.contains("javascript:"));
  }
}
