// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.csrf`: stateless, signed CSRF tokens.
//!
//! A token is base64url(nonce[16] | issued_at[8] | expires_at[8] | mac[32]),
//! with the times in milliseconds since the epoch (big-endian) and the MAC an
//! HMAC-SHA256 over everything before it followed by the optional context,
//! such as a session ID. Binding a token to the session stops an attacker
//! from submitting a token they obtained for their own session.

use std::sync::OnceLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use deno_core::op2;
use hmac::Mac;
use rand::RngCore;

type HmacSha256 = hmac::Hmac<sha2::Sha256>;

const NONCE_LEN: usize = 16;
const BODY_LEN: usize = NONCE_LEN + 16;
const TOKEN_LEN: usize = BODY_LEN + 32;

/// Used when no secret is passed. It is random per process, so tokens don't
/// survive a restart and aren't valid on other instances.
fn default_secret() -> &'static [u8; 32] {
  static SECRET: OnceLock<[u8; 32]> = OnceLock::new();
  SECRET.get_or_init(|| {
    let mut secret = [0; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    secret
  })
}

fn mac(secret: Option<&[u8]>, body: &[u8], context: &[u8]) -> HmacSha256 {
  let key = secret.unwrap_or(default_secret());
  let mut mac =
    HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
  mac.update(body);
  mac.update(context);
  mac
}

pub fn generate(
  secret: Option<&[u8]>,
  context: &[u8],
  issued_at: u64,
  expires_at: u64,
) -> String {
  let mut token = [0u8; TOKEN_LEN];
  rand::thread_rng().fill_bytes(&mut token[..NONCE_LEN]);
  token[NONCE_LEN..NONCE_LEN + 8].copy_from_slice(&issued_at.to_be_bytes());
  token[NONCE_LEN + 8..BODY_LEN].copy_from_slice(&expires_at.to_be_bytes());
  let tag = mac(secret, &token[..BODY_LEN], context)
    .finalize()
    .into_bytes();
  token[BODY_LEN..].copy_from_slice(&tag);
  URL_SAFE_NO_PAD.encode(token)
}

/// `max_age` of 0 means only the expiry written into the token counts.
pub fn verify(
  token: &str,
  secret: Option<&[u8]>,
  context: &[u8],
  now: u64,
  max_age: u64,
) -> bool {
  let Ok(bytes) = URL_SAFE_NO_PAD.decode(token) else {
    return false;
  };
  if bytes.len() != TOKEN_LEN {
    return false;
  }
  let (body, tag) = bytes.split_at(BODY_LEN);
  // Constant-time comparison.
  if mac(secret, body, context).verify_slice(tag).is_err() {
    return false;
  }
  let issued_at =
    u64::from_be_bytes(body[NONCE_LEN..NONCE_LEN + 8].try_into().unwrap());
  let expires_at =
    u64::from_be_bytes(body[NONCE_LEN + 8..].try_into().unwrap());
  if now >= expires_at {
    return false;
  }
  max_age == 0 || now.saturating_sub(issued_at) < max_age
}

#[op2]
#[string]
pub fn op_done_csrf_generate(
  #[buffer] secret: Option<&[u8]>,
  #[buffer] context: &[u8],
  #[number] issued_at: u64,
  #[number] expires_at: u64,
) -> String {
  generate(secret, context, issued_at, expires_at)
}

#[op2]
pub fn op_done_csrf_verify(
  #[string] token: &str,
  #[buffer] secret: Option<&[u8]>,
  #[buffer] context: &[u8],
  #[number] now: u64,
  #[number] max_age: u64,
) -> bool {
  verify(token, secret, context, now, max_age)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn round_trip() {
    let secret = Some(&b"secret"[..]);
    let token = generate(secret, b"session-1", 1000, 2000);
    assert_eq!(token.len(), 86);
    assert!(verify(&token, secret, b"session-1", 1500, 0));
    // Expired, too old, another session, another secret.
    assert!(!verify(&token, secret, b"session-1", 2000, 0));
    assert!(!verify(&token, secret, b"session-1", 1500, 500));
    assert!(!verify(&token, secret, b"session-2", 1500, 0));
    assert!(!verify(&token, Some(b"other"), b"session-1", 1500, 0));
    assert!(!verify(&token, None, b"session-1", 1500, 0));
    assert!(!verify("not a token", secret, b"", 1500, 0));
    // Any flipped bit in the body invalidates it.
    let mut bytes = URL_SAFE_NO_PAD.decode(&token).unwrap();
    bytes[NONCE_LEN + 15] ^= 1;
    let tampered = URL_SAFE_NO_PAD.encode(bytes);
    assert!(!verify(&tampered, secret, b"session-1", 1500, 0));
  }
}
