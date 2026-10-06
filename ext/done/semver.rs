// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.semver`, backed by the same `deno_semver` crate that resolves npm and
//! JSR dependencies, so ranges behave exactly as they do in `deno.json`.

use deno_core::op2;
use deno_error::JsErrorBox;
use deno_semver::Version;
use deno_semver::VersionReq;
use serde::Serialize;

#[derive(Serialize)]
pub struct ParsedVersion {
  major: u64,
  minor: u64,
  patch: u64,
  prerelease: Vec<String>,
  build: Vec<String>,
}

fn parse_version(text: &str) -> Result<Version, JsErrorBox> {
  Version::parse_standard(text.trim().trim_start_matches(['v', '=']))
    .map_err(|e| JsErrorBox::type_error(format!("Invalid version: {e}")))
}

fn parse_range(text: &str) -> Result<VersionReq, JsErrorBox> {
  VersionReq::parse_from_npm(text)
    .map_err(|e| JsErrorBox::type_error(format!("Invalid version range: {e}")))
}

#[op2]
#[serde]
pub fn op_done_semver_parse(
  #[string] version: &str,
) -> Result<ParsedVersion, JsErrorBox> {
  let v = parse_version(version)?;
  Ok(ParsedVersion {
    major: v.major,
    minor: v.minor,
    patch: v.patch,
    prerelease: v.pre.iter().map(|s| s.to_string()).collect(),
    build: v.build.iter().map(|s| s.to_string()).collect(),
  })
}

/// Returns -1, 0 or 1.
#[op2(fast)]
pub fn op_done_semver_compare(
  #[string] a: &str,
  #[string] b: &str,
) -> Result<i32, JsErrorBox> {
  Ok(parse_version(a)?.cmp(&parse_version(b)?) as i32)
}

#[op2(fast)]
pub fn op_done_semver_satisfies(
  #[string] version: &str,
  #[string] range: &str,
) -> Result<bool, JsErrorBox> {
  Ok(parse_range(range)?.matches(&parse_version(version)?))
}

#[op2]
#[string]
pub fn op_done_semver_max_satisfying(
  #[serde] versions: Vec<String>,
  #[string] range: &str,
) -> Result<Option<String>, JsErrorBox> {
  let range = parse_range(range)?;
  let mut best: Option<(Version, String)> = None;
  for text in versions {
    let version = parse_version(&text)?;
    if range.matches(&version)
      && best.as_ref().is_none_or(|(b, _)| version > *b)
    {
      best = Some((version, text));
    }
  }
  Ok(best.map(|(_, text)| text))
}
