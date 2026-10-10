// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.ansi.width()`: how many terminal columns a string takes.

use deno_core::op2;
use unicode_width::UnicodeWidthStr;

/// Columns `text` takes in a terminal: wide East Asian characters and emoji
/// take two, combining marks and zero-width characters none. Escape codes
/// are stripped in JavaScript before this is called.
#[op2(fast)]
pub fn op_done_ansi_width(#[string] text: &str) -> u32 {
  text.width() as u32
}

#[cfg(test)]
mod tests {
  use unicode_width::UnicodeWidthStr;

  #[test]
  fn widths() {
    assert_eq!("abc".width(), 3);
    assert_eq!("日本".width(), 4);
    assert_eq!("e\u{301}".width(), 1);
  }
}
