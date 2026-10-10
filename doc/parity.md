# Built-in API parity: Mokou, Bun and Node

The living matrix behind ROADMAP M4: what each runtime has built in, without
installing a package. Every gap Mokou has becomes an M2-style item (an API on
the `Deno` namespace, behind `--unstable-<name>`, with types and tests).

Checked against Bun 1.4.2 and Node 22.22 by probing their globals and built-in
modules, and Mokou 0.1.0 with every `--unstable-*` flag. Update the versions
when you update a row.

- ✅ built in
- 🟡 partial, or only through a lower-level API (noted)
- ❌ needs a package
- **Gap** marks rows where Mokou is behind both or the gap matters, with its
  priority in the gap list below

## Data and storage

| Feature                   | Bun                 | Node             | Mokou                                 | Gap |
| ------------------------- | ------------------- | ---------------- | ------------------------------------- | --- |
| SQLite                    | ✅ `bun:sqlite`     | ✅ `node:sqlite` | ✅ `Deno.openSqlite()`                |     |
| Key-value store           | ❌                  | ❌               | ✅ `Deno.openKv()`                    |     |
| Postgres / MySQL client   | ✅ `Bun.sql`        | ❌               | ❌                                    | P3  |
| Redis client              | ✅ `Bun.redis`      | ❌               | ❌                                    | P3  |
| S3 client                 | ✅ `Bun.s3`         | ❌               | ❌                                    | P1  |
| OS keychain secrets       | ✅ `Bun.secrets`    | ❌               | ❌                                    | P2  |
| Archives (tar)            | ✅ `Bun.Archive`    | ❌               | ❌                                    | P2  |
| Compression: gzip/deflate | ✅ sync and streams | ✅ `node:zlib`   | 🟡 `CompressionStream` only (no sync) |     |
| Compression: zstd         | ✅ `Bun.zstd*`      | ✅ `node:zlib`   | ❌                                    | P1  |

## Formats and text

| Feature                     | Bun                            | Node                            | Mokou                          | Gap |
| --------------------------- | ------------------------------ | ------------------------------- | ------------------------------ | --- |
| TOML                        | ✅ `Bun.TOML`                  | ❌                              | ✅ `Deno.toml`                 |     |
| YAML                        | ✅ `Bun.YAML`                  | ❌                              | ✅ `Deno.yaml`                 |     |
| CSV                         | ❌                             | ❌                              | ✅ `Deno.csv`                  |     |
| JSON5 / JSONC / JSONL       | ✅ `Bun.JSON5/JSONC/JSONL`     | ❌                              | ❌                             | P1  |
| XML                         | ✅ `Bun.XML`                   | ❌                              | ❌                             | P3  |
| Markdown to HTML            | ✅ `Bun.markdown`              | ❌                              | ❌                             | P2  |
| HTML escaping               | ✅ `Bun.escapeHTML`            | ❌                              | ❌                             | P2  |
| ANSI strip / width / colors | ✅ `stripANSI`, `stringWidth`… | ✅ `util.styleText`, `stripVT…` | ❌                             | P1  |
| Deep equality (boolean)     | ✅ `Bun.deepEquals`            | ✅ `util.isDeepStrictEqual`     | 🟡 only as `Deno.assertEquals` | P2  |
| Argument parsing            | ❌                             | ✅ `util.parseArgs`             | ✅ `Deno.parseArgs()`          |     |
| Semver                      | ✅ `Bun.semver`                | ❌                              | ✅ `Deno.semver`               |     |
| UUID v4 / v7                | ✅ `crypto`, `randomUUIDv7`    | 🟡 v4 only                      | ✅ `Deno.uuid`                 |     |

## Security and hashing

| Feature                          | Bun                       | Node              | Mokou                                | Gap |
| -------------------------------- | ------------------------- | ----------------- | ------------------------------------ | --- |
| Password hashing (Argon2/bcrypt) | ✅ `Bun.password`         | ❌                | ✅ `Deno.password`                   |     |
| Fast non-crypto hashes           | ✅ `Bun.hash`             | ❌                | ✅ `Deno.hash`                       |     |
| Sync SHA / MD5 digests           | ✅ `Bun.CryptoHasher`     | ✅ `crypto.hash`  | 🟡 async `crypto.subtle.digest` only | P1  |
| Cookies                          | ✅ `Bun.Cookie/CookieMap` | ❌                | ❌                                   | P1  |
| CSRF tokens                      | ✅ `Bun.CSRF`             | ❌                | ❌                                   | P2  |
| Permission sandbox               | ❌                        | 🟡 `--permission` | ✅ `--allow-*`                       |     |

## HTTP, networking and processes

| Feature                     | Bun                        | Node               | Mokou                     | Gap |
| --------------------------- | -------------------------- | ------------------ | ------------------------- | --- |
| HTTP server                 | ✅ `Bun.serve`             | ✅ `node:http`     | ✅ `Deno.serve`           |     |
| Routing                     | ✅ `Bun.serve({ routes })` | ❌                 | ✅ `Deno.router()`        |     |
| File-system router          | ✅ `FileSystemRouter`      | ❌                 | ❌                        | P3  |
| WebSocket server and client | ✅                         | ✅ (client global) | ✅                        |     |
| Shell scripting             | ✅ `Bun.$`                 | ❌                 | ✅ `Deno.$`               |     |
| Subprocesses                | ✅ `Bun.spawn`             | ✅ `child_process` | ✅ `Deno.Command`         |     |
| Pseudo-terminals (PTY)      | ✅ `Bun.Terminal`          | ❌                 | ❌                        | P2  |
| Cron jobs                   | ✅ `Bun.cron`              | ❌                 | 🟡 `Deno.cron` (unstable) |     |
| Glob                        | ✅ `Bun.Glob`              | ✅ `fs.glob`       | ✅ `Deno.glob()`          |     |
| FFI                         | ✅ `bun:ffi`               | ❌                 | ✅ `Deno.dlopen()`        |     |

## Tooling

| Feature                       | Bun                 | Node                             | Mokou                            | Gap |
| ----------------------------- | ------------------- | -------------------------------- | -------------------------------- | --- |
| TypeScript execution          | ✅                  | 🟡 type stripping                | ✅ with type checking            |     |
| Test runner and assertions    | ✅ `bun test`       | ✅ `node:test`                   | ✅ `Deno.test`, `Deno.assert*`   |     |
| Test mocks and snapshots      | ✅                  | ✅ `node:test`                   | ❌                               | P2  |
| Bundler API                   | ✅ `Bun.build`      | ❌                               | 🟡 `Deno.bundle()` (unstable)    |     |
| Transpiler API                | ✅ `Bun.Transpiler` | 🟡 `module.stripTypeScriptTypes` | ❌                               | P2  |
| Formatter, linter, doc, bench | ❌                  | ❌                               | ✅ `fmt`, `lint`, `doc`, `bench` |     |
| Single-file executables       | ✅ `--compile`      | 🟡 SEA                           | ✅ `compile`                     |     |
| Desktop apps / webview        | ✅ `Bun.WebView`    | ❌                               | 🟡 `deno desktop` (unstable)     |     |

## Gaps, by priority

Each becomes an `ext/mokou` API, in order:

**P1: common needs, small and well specified**

1. **Cookies.** Parse and serialize `Cookie` / `Set-Cookie`, and a cookie map
   for a request and response.
2. **ANSI text utilities.** Strip escape codes, terminal width of a string, and
   styling that respects `NO_COLOR`.
3. **Sync digests.** SHA-1/256/384/512 and MD5 without `await`, for cache keys
   and ETags (`unicode-width`, `sha1`, `sha2` and `md-5` are already
   dependencies).
4. **zstd.** `"zstd"` in `CompressionStream` / `DecompressionStream` (`zstd` is
   already a dependency).
5. **JSON5, JSONC and JSONL** in `Deno.json5` / `Deno.jsonc` / `Deno.jsonl`.
6. **S3 client.** Get, put, delete, list and presigned URLs over `fetch`, with
   SigV4 signing.

**P2: worth having**

Markdown to HTML (`pulldown-cmark`), HTML escaping, a boolean deep equality,
CSRF tokens, tar archives (`tar`), OS keychain secrets (`keyring`), test mocks
and snapshots, a transpiler API, and pseudo-terminals.

**P3: large surfaces**

SQL clients (Postgres, MySQL) and Redis, after the SQLite API settles (M2), XML
(`quick-xml`), and a file-system router, which belongs with the M5 web
framework.
