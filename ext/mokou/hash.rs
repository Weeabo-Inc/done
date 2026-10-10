// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.hash`: fast non-cryptographic hashes, and synchronous digests.

use deno_core::op2;
use deno_error::JsErrorBox;

#[op2(fast)]
pub fn op_done_hash_xxh32(#[buffer] data: &[u8], seed: u32) -> u32 {
  xxhash_rust::xxh32::xxh32(data, seed)
}

#[op2(fast)]
#[bigint]
pub fn op_done_hash_xxh64(#[buffer] data: &[u8], #[bigint] seed: u64) -> u64 {
  xxhash_rust::xxh64::xxh64(data, seed)
}

#[op2(fast)]
#[bigint]
pub fn op_done_hash_xxh3(#[buffer] data: &[u8], #[bigint] seed: u64) -> u64 {
  xxhash_rust::xxh3::xxh3_64_with_seed(data, seed)
}

/// CRC-32 (IEEE). `initial` is the CRC of the preceding data, so a stream can
/// be hashed in chunks.
#[op2(fast)]
pub fn op_done_hash_crc32(#[buffer] data: &[u8], initial: u32) -> u32 {
  let mut hasher = crc32fast::Hasher::new_with_initial(initial);
  hasher.update(data);
  hasher.finalize()
}

fn digest_bytes(algorithm: &str, data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
  use sha2::Digest;
  Ok(match algorithm {
    "md5" => md5::Md5::digest(data).to_vec(),
    "sha1" => sha1::Sha1::digest(data).to_vec(),
    "sha256" => sha2::Sha256::digest(data).to_vec(),
    "sha384" => sha2::Sha384::digest(data).to_vec(),
    "sha512" => sha2::Sha512::digest(data).to_vec(),
    _ => {
      return Err(JsErrorBox::type_error(format!(
        "Unsupported digest algorithm \"{algorithm}\": use md5, sha1, sha256, sha384 or sha512"
      )));
    }
  })
}

/// A cryptographic digest, computed synchronously (`crypto.subtle.digest()`
/// is async only).
#[op2]
#[buffer]
pub fn op_done_hash_digest(
  #[string] algorithm: &str,
  #[buffer] data: &[u8],
) -> Result<Vec<u8>, JsErrorBox> {
  digest_bytes(algorithm, data)
}

/// Like `op_done_hash_digest`, encoded as `"hex"` or `"base64"`.
#[op2]
#[string]
pub fn op_done_hash_digest_string(
  #[string] algorithm: &str,
  #[buffer] data: &[u8],
  #[string] encoding: &str,
) -> Result<String, JsErrorBox> {
  let bytes = digest_bytes(algorithm, data)?;
  match encoding {
    "hex" => {
      use std::fmt::Write;
      let mut out = String::with_capacity(bytes.len() * 2);
      for byte in bytes {
        let _ = write!(out, "{byte:02x}");
      }
      Ok(out)
    }
    "base64" => {
      use base64::Engine;
      Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    _ => Err(JsErrorBox::type_error(format!(
      "Unsupported digest encoding \"{encoding}\": use hex or base64"
    ))),
  }
}

#[cfg(test)]
mod tests {
  use super::digest_bytes;

  fn hex(bytes: Vec<u8>) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
  }

  #[test]
  fn known_digests() {
    assert_eq!(
      hex(digest_bytes("md5", b"abc").unwrap()),
      "900150983cd24fb0d6963f7d28e17f72"
    );
    assert_eq!(
      hex(digest_bytes("sha1", b"abc").unwrap()),
      "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    assert_eq!(
      hex(digest_bytes("sha256", b"abc").unwrap()),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert!(digest_bytes("sha3", b"abc").is_err());
  }
}
