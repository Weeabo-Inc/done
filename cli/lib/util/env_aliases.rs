// Copyright 2018-2026 the Deno authors. MIT license.

//! `MOKOU_*` environment variables.
//!
//! Every `DENO_*` environment variable can also be set as `MOKOU_*`, and the
//! `MOKOU_*` name wins when both are set. Each `MOKOU_<NAME>` is copied into
//! `DENO_<NAME>` once at startup, so the rest of the runtime, and every
//! subprocess that inherits the environment, only reads the `DENO_*` names.

use std::ffi::OsString;

const MOKOU_PREFIX: &str = "MOKOU_";
const DENO_PREFIX: &str = "DENO_";

/// Returns the `DENO_*` variables to set for the `MOKOU_*` variables in `vars`.
pub fn mokou_env_aliases(
  vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
  vars
    .into_iter()
    .filter_map(|(key, value)| {
      let name = key.to_str()?.strip_prefix(MOKOU_PREFIX)?;
      if name.is_empty() {
        return None;
      }
      Some((OsString::from(format!("{DENO_PREFIX}{name}")), value))
    })
    .collect()
}

/// Copies every `MOKOU_<NAME>` environment variable to `DENO_<NAME>`. Call it
/// first thing in `main`, before any thread is spawned, because it modifies
/// the process environment.
pub fn apply_mokou_env_aliases() {
  for (key, value) in mokou_env_aliases(std::env::vars_os()) {
    // SAFETY: called before any threads are spawned.
    unsafe { std::env::set_var(key, value) };
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
      .iter()
      .map(|(k, v)| (OsString::from(k), OsString::from(v)))
      .collect()
  }

  #[test]
  fn maps_mokou_vars_to_deno_vars() {
    assert_eq!(
      mokou_env_aliases(vars(&[
        ("MOKOU_DIR", "/cache"),
        ("MOKOU_NO_UPDATE_CHECK", "1"),
        ("DENO_DIR", "/other"),
        ("PATH", "/bin"),
      ])),
      vars(&[("DENO_DIR", "/cache"), ("DENO_NO_UPDATE_CHECK", "1")]),
    );
  }

  #[test]
  fn ignores_the_bare_prefix_and_other_names() {
    assert!(
      mokou_env_aliases(vars(&[
        ("MOKOU_", "x"),
        ("MOKOU", "x"),
        ("XMOKOU_DIR", "x"),
      ]))
      .is_empty()
    );
  }
}
