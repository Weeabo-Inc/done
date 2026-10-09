// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.password.hash()` / `Deno.password.verify()`.
//!
//! Hashes are stored in the standard self-describing formats, so they can be
//! verified by other tools: PHC strings for Argon2
//! (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) and modular crypt strings
//! for bcrypt (`$2b$10$...`). Hashing is deliberately slow, so it runs on the
//! blocking thread pool instead of the JavaScript thread.

use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use deno_core::op2;
use deno_core::unsync::spawn_blocking;
use deno_error::JsErrorBox;
use rand::RngCore;
use serde::Deserialize;

/// OWASP's recommended Argon2id baseline.
const DEFAULT_ARGON2_MEMORY_COST: u32 = 19 * 1024;
const DEFAULT_ARGON2_TIME_COST: u32 = 2;
const DEFAULT_ARGON2_PARALLELISM: u32 = 1;
const ARGON2_SALT_LEN: usize = 16;
const ARGON2_HASH_LEN: usize = 32;
const DEFAULT_BCRYPT_COST: u32 = 10;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HashOptions {
  algorithm: Option<String>,
  memory_cost: Option<u32>,
  time_cost: Option<u32>,
  parallelism: Option<u32>,
  cost: Option<u32>,
}

#[op2]
#[string]
pub async fn op_done_password_hash(
  #[string] password: String,
  #[serde] options: Option<HashOptions>,
) -> Result<String, JsErrorBox> {
  let options = options.unwrap_or_default();
  spawn_blocking(move || hash(&password, options))
    .await
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
}

#[op2]
pub async fn op_done_password_verify(
  #[string] password: String,
  #[string] hash: String,
) -> Result<bool, JsErrorBox> {
  spawn_blocking(move || verify(&password, &hash))
    .await
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
}

fn hash(password: &str, options: HashOptions) -> Result<String, JsErrorBox> {
  match options.algorithm.as_deref().unwrap_or("argon2id") {
    algorithm @ ("argon2id" | "argon2i" | "argon2d") => {
      let params = argon2::Params::new(
        options.memory_cost.unwrap_or(DEFAULT_ARGON2_MEMORY_COST),
        options.time_cost.unwrap_or(DEFAULT_ARGON2_TIME_COST),
        options.parallelism.unwrap_or(DEFAULT_ARGON2_PARALLELISM),
        Some(ARGON2_HASH_LEN),
      )
      .map_err(|e| JsErrorBox::range_error(e.to_string()))?;
      let mut salt = [0u8; ARGON2_SALT_LEN];
      rand::thread_rng().fill_bytes(&mut salt);
      let out = argon2_hash(algorithm, &params, password.as_bytes(), &salt)?;
      Ok(format!(
        "${}$v=19$m={},t={},p={}${}${}",
        algorithm,
        params.m_cost(),
        params.t_cost(),
        params.p_cost(),
        STANDARD_NO_PAD.encode(salt),
        STANDARD_NO_PAD.encode(out),
      ))
    }
    "bcrypt" => {
      let cost = options.cost.unwrap_or(DEFAULT_BCRYPT_COST);
      if !(4..=31).contains(&cost) {
        return Err(JsErrorBox::range_error(
          "bcrypt cost must be between 4 and 31",
        ));
      }
      // bcrypt only uses the first 72 bytes of the password. Refuse longer
      // passwords instead of silently ignoring the rest.
      if password.len() > 72 {
        return Err(JsErrorBox::range_error(
          "bcrypt passwords must be at most 72 bytes; use argon2id instead",
        ));
      }
      bcrypt::hash(password, cost)
        .map_err(|e| JsErrorBox::generic(e.to_string()))
    }
    other => Err(JsErrorBox::type_error(format!(
      "Unsupported password hashing algorithm \"{other}\". Expected \"argon2id\", \"argon2i\", \"argon2d\" or \"bcrypt\"."
    ))),
  }
}

fn verify(password: &str, hash: &str) -> Result<bool, JsErrorBox> {
  if hash.starts_with("$2a$")
    || hash.starts_with("$2b$")
    || hash.starts_with("$2y$")
  {
    return bcrypt::verify(password, hash).map_err(|e| {
      JsErrorBox::type_error(format!("Invalid bcrypt hash: {e}"))
    });
  }
  let phc = parse_phc(hash).ok_or_else(|| {
    JsErrorBox::type_error("Unrecognized password hash format")
  })?;
  let params = argon2::Params::new(phc.m, phc.t, phc.p, Some(phc.hash.len()))
    .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
  let out =
    argon2_hash(phc.algorithm, &params, password.as_bytes(), &phc.salt)?;
  Ok(constant_time_eq(&out, &phc.hash))
}

fn argon2_hash(
  algorithm: &str,
  params: &argon2::Params,
  password: &[u8],
  salt: &[u8],
) -> Result<Vec<u8>, JsErrorBox> {
  let algorithm = match algorithm {
    "argon2i" => argon2::Algorithm::Argon2i,
    "argon2d" => argon2::Algorithm::Argon2d,
    _ => argon2::Algorithm::Argon2id,
  };
  let argon2 =
    argon2::Argon2::new(algorithm, argon2::Version::V0x13, params.clone());
  let mut out = vec![0u8; params.output_len().unwrap_or(ARGON2_HASH_LEN)];
  argon2
    .hash_password_into(password, salt, &mut out)
    .map_err(|e| JsErrorBox::generic(e.to_string()))?;
  Ok(out)
}

struct Phc<'a> {
  algorithm: &'a str,
  m: u32,
  t: u32,
  p: u32,
  salt: Vec<u8>,
  hash: Vec<u8>,
}

/// Parses `$argon2id$v=19$m=..,t=..,p=..$<salt>$<hash>`.
fn parse_phc(s: &str) -> Option<Phc<'_>> {
  let mut parts = s.strip_prefix('$')?.split('$');
  let algorithm = parts.next()?;
  if !matches!(algorithm, "argon2id" | "argon2i" | "argon2d") {
    return None;
  }
  let mut next = parts.next()?;
  if let Some(version) = next.strip_prefix("v=") {
    if version != "19" {
      return None;
    }
    next = parts.next()?;
  }
  let (mut m, mut t, mut p) = (None, None, None);
  for param in next.split(',') {
    let (key, value) = param.split_once('=')?;
    let value: u32 = value.parse().ok()?;
    match key {
      "m" => m = Some(value),
      "t" => t = Some(value),
      "p" => p = Some(value),
      _ => return None,
    }
  }
  let salt = STANDARD_NO_PAD.decode(parts.next()?).ok()?;
  let hash = STANDARD_NO_PAD.decode(parts.next()?).ok()?;
  if parts.next().is_some() || hash.is_empty() {
    return None;
  }
  Some(Phc {
    algorithm,
    m: m?,
    t: t?,
    p: p?,
    salt,
    hash,
  })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fast() -> HashOptions {
    HashOptions {
      memory_cost: Some(64),
      time_cost: Some(1),
      ..Default::default()
    }
  }

  #[test]
  fn argon2_round_trip() {
    let h = hash("hunter2", fast()).unwrap();
    assert!(h.starts_with("$argon2id$v=19$m=64,t=1,p=1$"));
    assert!(verify("hunter2", &h).unwrap());
    assert!(!verify("hunter3", &h).unwrap());
  }

  #[test]
  fn argon2_known_vector() {
    // From the reference implementation's README:
    // echo -n "password" | ./argon2 somesalt -t 2 -m 16 -p 4 -l 24
    let h = "$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";
    assert!(verify("password", h).unwrap());
    assert!(!verify("passwore", h).unwrap());
  }

  #[test]
  fn bcrypt_round_trip() {
    let h = hash(
      "hunter2",
      HashOptions {
        algorithm: Some("bcrypt".into()),
        cost: Some(4),
        ..Default::default()
      },
    )
    .unwrap();
    assert!(h.starts_with("$2b$04$"));
    assert!(verify("hunter2", &h).unwrap());
    assert!(!verify("hunter3", &h).unwrap());
  }

  #[test]
  fn rejects_garbage() {
    assert!(verify("x", "not a hash").is_err());
    assert!(verify("x", "$argon2id$v=19$m=1$AA$AA").is_err());
  }
}
