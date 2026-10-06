// Copyright 2018-2026 the Deno authors. MIT license.

//! Fast, non-cryptographic hashes for `Deno.hash`.

use deno_core::op2;

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
