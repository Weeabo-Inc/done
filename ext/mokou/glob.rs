// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.glob()`: native filesystem globbing that respects `--allow-read`.

use std::borrow::Cow;
use std::path::Path;
use std::path::PathBuf;

use deno_core::OpState;
use deno_core::op2;
use deno_error::JsErrorBox;
use deno_permissions::OpenAccessKind;
use deno_permissions::PermissionsContainer;
use globset::GlobBuilder;
use globset::GlobSet;
use globset::GlobSetBuilder;
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobOptions {
  root: String,
  patterns: Vec<String>,
  #[serde(default)]
  exclude: Vec<String>,
  #[serde(default)]
  include_dirs: bool,
  #[serde(default)]
  include_hidden: bool,
  #[serde(default)]
  follow_symlinks: bool,
  #[serde(default)]
  case_insensitive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobEntry {
  /// Path relative to the root, always with `/` separators.
  path: String,
  is_file: bool,
  is_directory: bool,
  is_symlink: bool,
}

fn build_set(
  patterns: &[String],
  case_insensitive: bool,
) -> Result<GlobSet, JsErrorBox> {
  let mut builder = GlobSetBuilder::new();
  for pattern in patterns {
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let glob = GlobBuilder::new(pattern)
      .literal_separator(true)
      .backslash_escape(true)
      .case_insensitive(case_insensitive)
      .build()
      .map_err(|e| {
        JsErrorBox::type_error(format!("Invalid glob \"{pattern}\": {e}"))
      })?;
    builder.add(glob);
  }
  builder
    .build()
    .map_err(|e| JsErrorBox::type_error(e.to_string()))
}

/// The directory a pattern starts in, taken from its leading components that
/// contain no glob syntax. Walking starts there instead of at the root, so
/// `src/**/*.ts` does not walk `node_modules`.
fn literal_prefix(pattern: &str) -> PathBuf {
  let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
  let mut prefix = PathBuf::new();
  let mut components = pattern.split('/').peekable();
  while let Some(component) = components.next() {
    // The last component is always matched, never walked into.
    if components.peek().is_none()
      || component.contains(['*', '?', '[', '{', '\\'])
    {
      break;
    }
    prefix.push(component);
  }
  prefix
}

fn is_hidden(relative: &Path) -> bool {
  relative.components().any(|c| {
    c.as_os_str()
      .to_str()
      .is_some_and(|s| s.starts_with('.') && s != "." && s != "..")
  })
}

#[op2(stack_trace)]
#[serde]
pub fn op_done_glob(
  state: &mut OpState,
  #[serde] options: GlobOptions,
) -> Result<Vec<GlobEntry>, JsErrorBox> {
  let root = state
    .borrow::<PermissionsContainer>()
    .check_open(
      Cow::Owned(PathBuf::from(&options.root)),
      OpenAccessKind::Read,
      Some("Deno.glob()"),
    )
    .map_err(JsErrorBox::from_err)?
    .into_owned_path();

  let include = build_set(&options.patterns, options.case_insensitive)?;
  let exclude = build_set(&options.exclude, options.case_insensitive)?;
  let explicitly_hidden = options
    .patterns
    .iter()
    .any(|p| p.starts_with('.') && !p.starts_with("./") || p.contains("/."));

  // Walk each distinct starting directory once, skipping ones nested in
  // another.
  let mut starts: Vec<PathBuf> =
    options.patterns.iter().map(|p| literal_prefix(p)).collect();
  starts.sort();
  starts.dedup_by(|b, a| b.starts_with(&*a));

  let mut entries = Vec::new();
  for start in starts {
    let walk_root = root.join(&start);
    if !walk_root.exists() {
      continue;
    }
    let walker = walkdir::WalkDir::new(&walk_root)
      .follow_links(options.follow_symlinks)
      .sort_by_file_name()
      .into_iter()
      .filter_entry(|entry| {
        let Ok(relative) = entry.path().strip_prefix(&root) else {
          return true;
        };
        if relative.as_os_str().is_empty() {
          return true;
        }
        if !options.include_hidden && !explicitly_hidden && is_hidden(relative)
        {
          return false;
        }
        !exclude.is_match(relative)
      });
    for entry in walker {
      let entry = entry.map_err(|e| JsErrorBox::generic(e.to_string()))?;
      let Ok(relative) = entry.path().strip_prefix(&root) else {
        continue;
      };
      if relative.as_os_str().is_empty() || !include.is_match(relative) {
        continue;
      }
      let file_type = entry.file_type();
      if file_type.is_dir() && !options.include_dirs {
        continue;
      }
      let path = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
      entries.push(GlobEntry {
        path,
        is_file: file_type.is_file(),
        is_directory: file_type.is_dir(),
        is_symlink: entry.path_is_symlink(),
      });
    }
  }
  Ok(entries)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn prefix() {
    assert_eq!(literal_prefix("src/**/*.ts"), PathBuf::from("src"));
    assert_eq!(literal_prefix("./a/b/*.ts"), PathBuf::from("a/b"));
    assert_eq!(literal_prefix("*.ts"), PathBuf::new());
    assert_eq!(literal_prefix("a/b/c.ts"), PathBuf::from("a/b"));
    assert_eq!(literal_prefix("a/{b,c}/d"), PathBuf::from("a"));
  }
}
