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
| S3 client                 | ✅ `Bun.s3`         | ❌               | ✅ `Deno.S3Client`                    |     |
| OS keychain secrets       | ✅ `Bun.secrets`    | ❌               | ❌                                    | P2  |
| Archives (tar)            | ✅ `Bun.Archive`    | ❌               | ✅ `Deno.tar`                         |     |
| Compression: gzip/deflate | ✅ sync and streams | ✅ `node:zlib`   | 🟡 `CompressionStream` only (no sync) |     |
| Compression: zstd         | ✅ `Bun.zstd*`      | ✅ `node:zlib`   | ✅ `CompressionStream("zstd")`        |     |

## Formats and text

| Feature                     | Bun                            | Node                            | Mokou                       | Gap |
| --------------------------- | ------------------------------ | ------------------------------- | --------------------------- | --- |
| TOML                        | ✅ `Bun.TOML`                  | ❌                              | ✅ `Deno.toml`              |     |
| YAML                        | ✅ `Bun.YAML`                  | ❌                              | ✅ `Deno.yaml`              |     |
| CSV                         | ❌                             | ❌                              | ✅ `Deno.csv`               |     |
| JSON5 / JSONC / JSONL       | ✅ `Bun.JSON5/JSONC/JSONL`     | ❌                              | ✅ `Deno.json5/jsonc/jsonl` |     |
| XML                         | ✅ `Bun.XML`                   | ❌                              | ❌                          | P3  |
| Markdown to HTML            | ✅ `Bun.markdown`              | ❌                              | ✅ `Deno.markdown`          |     |
| HTML escaping               | ✅ `Bun.escapeHTML`            | ❌                              | ✅ `Deno.escapeHTML`        |     |
| ANSI strip / width / colors | ✅ `stripANSI`, `stringWidth`… | ✅ `util.styleText`, `stripVT…` | ✅ `Deno.ansi`              |     |
| Deep equality (boolean)     | ✅ `Bun.deepEquals`            | ✅ `util.isDeepStrictEqual`     | ✅ `Deno.deepEquals`        |     |
| Argument parsing            | ❌                             | ✅ `util.parseArgs`             | ✅ `Deno.parseArgs()`       |     |
| Semver                      | ✅ `Bun.semver`                | ❌                              | ✅ `Deno.semver`            |     |
| UUID v4 / v7                | ✅ `crypto`, `randomUUIDv7`    | 🟡 v4 only                      | ✅ `Deno.uuid`              |     |

## Security and hashing

| Feature                          | Bun                       | Node              | Mokou                   | Gap |
| -------------------------------- | ------------------------- | ----------------- | ----------------------- | --- |
| Password hashing (Argon2/bcrypt) | ✅ `Bun.password`         | ❌                | ✅ `Deno.password`      |     |
| Fast non-crypto hashes           | ✅ `Bun.hash`             | ❌                | ✅ `Deno.hash`          |     |
| Sync SHA / MD5 digests           | ✅ `Bun.CryptoHasher`     | ✅ `crypto.hash`  | ✅ `Deno.hash.digest()` |     |
| Cookies                          | ✅ `Bun.Cookie/CookieMap` | ❌                | ✅ `Deno.cookies`       |     |
| CSRF tokens                      | ✅ `Bun.CSRF`             | ❌                | ✅ `Deno.csrf`          |     |
| Permission sandbox               | ❌                        | 🟡 `--permission` | ✅ `--allow-*`          |     |

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

| Feature                       | Bun                 | Node                             | Mokou                                | Gap |
| ----------------------------- | ------------------- | -------------------------------- | ------------------------------------ | --- |
| TypeScript execution          | ✅                  | 🟡 type stripping                | ✅ with type checking                |     |
| Test runner and assertions    | ✅ `bun test`       | ✅ `node:test`                   | ✅ `Deno.test`, `Deno.assert*`       |     |
| Test mocks and snapshots      | ✅                  | ✅ `node:test`                   | ✅ `Deno.mock`, `t.assertSnapshot()` |     |
| Bundler API                   | ✅ `Bun.build`      | ❌                               | 🟡 `Deno.bundle()` (unstable)        |     |
| Transpiler API                | ✅ `Bun.Transpiler` | 🟡 `module.stripTypeScriptTypes` | ✅ `Deno.transpile()`                |     |
| Formatter, linter, doc, bench | ❌                  | ❌                               | ✅ `fmt`, `lint`, `doc`, `bench`     |     |
| Single-file executables       | ✅ `--compile`      | 🟡 SEA                           | ✅ `compile`                         |     |
| Desktop apps / webview        | ✅ `Bun.WebView`    | ❌                               | 🟡 `deno desktop` (unstable)         |     |

## Gaps, by priority

Each becomes an `ext/mokou` API, in order:

**P1: common needs, small and well specified**

Shipped: cookies (`Deno.cookies`), ANSI text utilities (`Deno.ansi`), sync
digests (`Deno.hash.digest()`), zstd in `CompressionStream` and
`DecompressionStream`, and `Deno.json5` / `Deno.jsonc` / `Deno.jsonl`. zstd is
not behind a flag, like `"brotli"`, because it is only a new format name for an
existing web API.

`Deno.S3Client` covers get (streaming and ranges), put, delete, exists, stat,
list (ListObjectsV2) and presigned URLs over `fetch`, with SigV4 signing, for
AWS and S3-compatible stores. Multipart uploads are not done yet, so one upload
is limited to what S3 accepts in a single `PUT` (5 GB) and is buffered in
memory.

**P2: worth having**

Shipped: `Deno.escapeHTML()` and `Deno.markdown.html()` (comrak, already in the
binary for `deno doc`, with raw HTML dropped unless allowed), the boolean
`Deno.deepEquals()`, and `Deno.csrf` (stateless HMAC tokens that can be bound to
a session). `Deno.tar` creates, reads, packs and extracts tar and `.tar.gz`
archives in memory; extraction refuses anything that would land outside the
target directory, including through chains of symlinks. `Deno.transpile()` turns
TypeScript and JSX into JavaScript with the compiler that runs Mokou's own
modules (no import/export scanning yet, unlike `Bun.Transpiler.scan`).
`Deno.mock` adds Jest-style mock functions and spies with the
`toHaveBeenCalled*` / `toHaveReturned*` matchers on `Deno.expect`. Snapshots
were already there and this table missed them: `t.assertSnapshot()` with
`deno test --update-snapshots`, compatible with `@std/testing/snapshot`. Fake
timers are not done.

Still open: OS keychain secrets (`keyring`) and pseudo-terminals.

**P3: large surfaces**

SQL clients (Postgres, MySQL) and Redis, after the SQLite API settles (M2), XML
(`quick-xml`), and a file-system router, which belongs with the M5 web
framework.
