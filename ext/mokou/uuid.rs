// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.uuid`.

use deno_core::op2;

#[op2]
#[string]
pub fn op_done_uuid_v4() -> String {
  uuid::Uuid::new_v4().to_string()
}

/// A time-ordered UUID (RFC 9562 version 7), which sorts by creation time and
/// so makes a good database key.
#[op2]
#[string]
pub fn op_done_uuid_v7() -> String {
  uuid::Uuid::now_v7().to_string()
}
