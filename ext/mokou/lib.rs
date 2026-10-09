// Copyright 2018-2026 the Deno authors. MIT license.

//! Mokou's built-in standard library.
//!
//! Each API here is exposed on the `Deno` namespace behind its own
//! `--unstable-<name>` flag (see `runtime/features/data.rs`). The JavaScript
//! side lives next to this file and is loaded lazily, so a program that never
//! touches these APIs does not pay for them at startup.

mod formats;
mod glob;
mod hash;
mod password;
mod semver;
mod shell;
mod uuid;

deno_core::extension!(
  deno_mokou,
  deps = [deno_web],
  ops = [
    formats::op_done_toml_parse,
    formats::op_done_toml_stringify,
    formats::op_done_yaml_parse,
    formats::op_done_yaml_stringify,
    formats::op_done_csv_parse,
    formats::op_done_csv_stringify,
    glob::op_done_glob,
    hash::op_done_hash_xxh32,
    hash::op_done_hash_xxh64,
    hash::op_done_hash_xxh3,
    hash::op_done_hash_crc32,
    password::op_done_password_hash,
    password::op_done_password_verify,
    semver::op_done_semver_parse,
    semver::op_done_semver_compare,
    semver::op_done_semver_satisfies,
    semver::op_done_semver_max_satisfying,
    shell::op_done_shell_spawn,
    shell::op_done_shell_wait,
    shell::op_done_shell_kill,
    uuid::op_done_uuid_v4,
    uuid::op_done_uuid_v7,
  ],
  lazy_loaded_js = [
    "00_assert.js",
    "01_sqlite.js",
    "02_password.js",
    "03_hash.js",
    "04_formats.js",
    "05_glob.js",
    "06_router.js",
    "07_semver.js",
    "08_uuid.js",
    "09_parse_args.js",
    "10_shell.js",
  ],
);
