# deno_mokou

Mokou's built-in standard library: APIs that most apps need, available on the
`Deno` namespace with no import. Each one starts behind its own
`--unstable-<name>` flag (or `"unstable": ["<name>"]` in `deno.json`).

| Flag                    | API                                                                            | Implementation                                        |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `--unstable-assert`     | `Deno.assert*()`, `Deno.expect()`, `Deno.AssertionError`                       | `00_assert.js`                                        |
| `--unstable-sqlite`     | `Deno.openSqlite()`, `Deno.SqliteDatabase`                                     | `01_sqlite.js`, on the Rust code in `ext/node_sqlite` |
| `--unstable-password`   | `Deno.password.hash()` / `verify()` (Argon2id, bcrypt)                         | `02_password.js`, `password.rs`                       |
| `--unstable-hash`       | `Deno.hash.xxhash32/64()`, `xxhash3()`, `crc32()`, `digest()`                  | `03_hash.js`, `hash.rs`                               |
| `--unstable-formats`    | `Deno.toml`, `Deno.yaml`, `Deno.csv`, `Deno.json5`, `Deno.jsonc`, `Deno.jsonl` | `04_formats.js`, `formats.rs`, `13_json.js`           |
| `--unstable-glob`       | `Deno.glob()`, `Deno.globSync()`                                               | `05_glob.js`, `glob.rs`                               |
| `--unstable-router`     | `Deno.router()`                                                                | `06_router.js`                                        |
| `--unstable-semver`     | `Deno.semver`                                                                  | `07_semver.js`, `semver.rs`                           |
| `--unstable-uuid`       | `Deno.uuid.v4()`, `v7()`, `validate()`                                         | `08_uuid.js`, `uuid.rs`                               |
| `--unstable-parse-args` | `Deno.parseArgs()`                                                             | `09_parse_args.js`                                    |
| `--unstable-shell`      | `Deno.$`, `Deno.ShellError`                                                    | `10_shell.js`, `shell.rs`, on `deno_task_shell`       |
| `--unstable-ansi`       | `Deno.ansi.strip()`, `width()`, `style()`                                      | `11_ansi.js`, `ansi.rs`                               |
| `--unstable-cookies`    | `Deno.cookies`                                                                 | `12_cookies.js`                                       |

The JavaScript files are lazy-loaded scripts. `runtime/js/90_deno_ns.js` loads
each one the first time its API is accessed, so a program that doesn't use them
pays nothing at startup. Types live in `cli/tsc/dts/lib.deno.unstable.d.ts`, and
tests in `tests/unit/mokou_*_test.ts`.

```ts
// deno run --unstable-sqlite --unstable-password -RW app.ts
using db = Deno.openSqlite("app.db");
db.exec("CREATE TABLE IF NOT EXISTS users (name TEXT, hash TEXT)");
db.run(
  "INSERT INTO users VALUES (?, ?)",
  "ada",
  await Deno.password.hash("hunter2"),
);
```
