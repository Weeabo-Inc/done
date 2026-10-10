# Mokou Roadmap

This file turns the five goals in the [README](README.md) into milestones you
can ship. Each milestone lists concrete work items and what "done" means for it.
Facts about the starting tree, such as sizes, file paths and upstream links, are
in [doc/mokou-audit.md](doc/mokou-audit.md).

Milestones are ordered by dependency, not by size. M0 blocks shipping a release.
M1 to M4 can run in parallel once M0 has landed.

---

## M0: Independence (hard-fork hygiene)

_Goal: a Mokou binary that never talks to, updates from, or reports bugs to
upstream Deno by accident._

| # | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                                               |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1 | ✅ **Decided: the binary is `mokou`, with a `deno` alias.** The working name `done` was rejected because it is a POSIX shell reserved word (`done run main.ts` is a syntax error in bash, zsh and sh). `mokou` is shell-safe. Releases also ship `deno` as an alias so existing scripts keep working                                                                                                                                                                                  | `.github/workflows/ci.ts`, `cli/tools/upgrade.rs`                                   |
| 2 | ✅ Own version scheme. `cli/lib/mokou_version.txt` holds Mokou's version, which `--version` (`mokou 0.1.0 (deno 2.9.7 base, …)`), `upgrade`, panics and the REPL banner use. `Deno.version.deno` still reports the Deno base so feature detection keeps working                                                                                                                                                                                                                       | `cli/lib/mokou_version.txt`, `cli/lib/version.rs` (`MOKOU_VERSION`)                 |
| 3 | ✅ Point `upgrade` at Mokou releases. Stable and pre-release builds come from `weeabo-inc/done` GitHub releases, and the canary channel is refused until Mokou builds canaries. Release jobs must upload `mokou-<target>.zip` and `release-latest.txt` as assets                                                                                                                                                                                                                      | `cli/tools/upgrade.rs`, `cli/lib/version.rs` (`MOKOU_RELEASES_URL`)                 |
| 4 | ✅ Send panic and bug reports to `weeabo-inc/done`. The `panic.deno.com` trace link is gone, because that service only symbolizes upstream builds                                                                                                                                                                                                                                                                                                                                     | `cli/lib/version.rs` (`MOKOU_NEW_ISSUE_URL`), `cli/lib.rs`, `cli/rt_desktop/lib.rs` |
| 5 | ✅ CI and release workflows run on this repo. Packaging, release builds and tests, delta patches (now from Mokou's own previous release) and the GitHub release upload, including `release-latest.txt`, run on `weeabo-inc/done`. Larger runners, code signing, dl.deno.land, wpt.fyi and benchmark data stay gated to `denoland/deno` because they need upstream secrets. Still open: `tools/release/` bumps only the Deno version, so it must also bump `cli/lib/mokou_version.txt` | `.github/workflows/ci.ts` (`isReleaseRepo`), `ci.generated.yml`                     |
| 6 | ✅ Outbound defaults reviewed, see the table below                                                                                                                                                                                                                                                                                                                                                                                                                                    | `cli/lib.rs`, `cli/standalone/binary.rs`, `cli/schemas/`                            |
| 7 | ✅ The user agent and `navigator.userAgent` are `Mokou/<ver> Deno/<base>`. The `Deno/` token stays so servers and libraries that detect Deno keep working. `navigator.userAgentData.brands` lists both. `Deno.build`/`Deno.version` are unchanged                                                                                                                                                                                                                                     | `cli/lib/version.rs`, `runtime/js/97_navigator_user_agent_data.js`                  |

### Outbound defaults (M0 #6)

| Default                                                                                                 | Decision                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deno deploy`, `deno sandbox`, `--tunnel`, `DENO_CONNECTED`                                             | **Disabled.** They download Deno Deploy's CLI and run it with all permissions, or connect to Deno's tunnel servers. `MOKOU_ENABLE_DENO_DEPLOY=1` opts back in                                                                              |
| `deno compile` runtime (`denort`) download                                                              | **Renamed** from `dl.deno.land` to Mokou's GitHub release for the same Mokou version. `DENORT_DOWNLOAD_URL` sets a mirror, and `DENORT_BIN` still uses a local build. Release jobs must upload `denort-<target>.zip`                       |
| `panic.deno.com` stack trace link                                                                       | **Removed**                                                                                                                                                                                                                                |
| `deno.json` schema `$id`s, DevTools favicon, `deno desktop` user agent                                  | **Renamed** to `weeabo-inc/done`                                                                                                                                                                                                           |
| `deno desktop` backends (`laufey`, built upstream at `github.com/littledivy`)                           | **Mirrored.** Downloaded from the `laufey-v<version>` release on `weeabo-inc/done`, which `.github/workflows/laufey_mirror.ts` publishes from `cli/laufey_sums.lock`. Downloads stay SHA-pinned. `LAUFEY_DOWNLOAD_URL` sets another mirror |
| `jsr.io`, `registry.npmjs.org`, `npm.jsr.io`, sigstore (`deno publish`), Socket (`deno audit --socket`) | **Kept.** Ecosystem endpoints, and all can be overridden (`JSR_URL`, `NPM_CONFIG_REGISTRY`, `.npmrc`, `JSR_NPM_URL`, `FULCIO_URL`/`REKOR_URL`)                                                                                             |
| OpenTelemetry                                                                                           | **Kept.** Off unless `OTEL_DENO=1`, and it defaults to localhost                                                                                                                                                                           |
| LSP import completions (`/.well-known/deno-import-intellisense.json`)                                   | **Kept.** Only probes origins the user types                                                                                                                                                                                               |
| Links to `docs.deno.com` in help and error text                                                         | **Kept for now.** Cosmetic. Replace them once Mokou has its own docs                                                                                                                                                                       |

**Done when:** `deno --version`, `deno upgrade`, a forced panic, and a CI run on
`weeabo-inc/done` all point at Mokou and never at upstream Deno.

### Rebrand: Done → Mokou

The product is now **Mokou: A Frictionless & Modern TypeScript Runtime**. Done
was the working name, and nothing was ever released under it, so its identifiers
were renamed outright. The GitHub repository stays `weeabo-inc/done`.

1. ✅ Product name. `--version` (`mokou 0.1.0 (deno 2.9.7 base, …)`), the user
   agent (`Mokou/<ver> Deno/<base>`), `navigator.userAgentData.brands`, panic,
   upgrade and Deno Deploy messages, the REPL banner, `--help`, the logos in
   `doc/assets/` and the docs. Internal names follow: `MOKOU_VERSION`,
   `cli/lib/mokou_version.txt`, `ext/mokou` (`deno_mokou`) and
   `MOKOU_ENABLE_DENO_DEPLOY`.
2. ✅ Binary and global. Releases ship `mokou-<target>.zip`, which holds the
   `mokou` executable plus a `deno` alias (a symlink, or `deno.cmd` on Windows),
   and `upgrade` and the delta patches use the same names. `--help` and usage
   lines say `mokou`, and shell completions are registered for both names.
   `globalThis.Mokou` is an alias of `Deno`, with types (`import Mokou = Deno`
   in `lib.deno.ns.d.ts`). Development builds are still `target/debug/deno`, and
   messages that suggest a command (for example `` run `deno task` ``) still say
   `deno`, which the alias keeps correct.
3. ✅ Config and environment. `mokou.json` and `mokou.jsonc` are discovered
   before `deno.json` and `deno.jsonc` (including workspace members, links, the
   LSP and `deno compile`d programs). `init`, `add` without a config and pnpm
   workspace import create `mokou.json`. A `mokou.json` defaults to a
   `mokou.lock`, but an existing `deno.lock` keeps being used, and a
   `package.json`-only project picks up an existing `mokou.lock`. Every `DENO_*`
   environment variable can also be set as `MOKOU_*`, which wins
   (`cli/lib/util/env_aliases.rs` copies them over at startup, in both the CLI
   and `denort`).

### Decided: the `Deno` global

**`Deno.*` stays the canonical namespace, and `globalThis.Mokou` is an alias of
it** (`Mokou === Deno`, and `Mokou.Conn` works as a type). Renaming it would
break every Deno program, JSR package and type definition for no gain. The
binary and branding change, but the API surface stays.

---

## M1: Deno-native mode

_Goal: Node compatibility is something you opt into, not something that is
always on underneath._

Node compatibility is about 255k lines (around 42% of everything under `ext/`,
`runtime/` and `libs/`), and parts of it are now on by default. The global
`setTimeout`/`setInterval` are loaded from `node:timers`
(`runtime/js/98_global_scope_shared.js`), and the `node-globals` flag is a no-op
because that behavior can no longer be turned off.

1. ✅ Add a **`--no-node` flag and a `"node": false` setting in `deno.json`**
   that:
   - reject `npm:` and `node:` specifiers, static or dynamic, with a clear
     error,
   - skip `package.json` / `node_modules` discovery (`--no-node` implies
     `--no-npm`),
   - restore web-standard timer globals (`setTimeout` returns a number), and
     remove `process`, `Buffer`, `global`, `setImmediate` and `clearImmediate`.
2. 🟡 **Do not load `ext/node` at all** in that mode. The Node bootstrap is now
   skipped and no `ext/node` module is ever evaluated. The extension is still
   registered and still in the startup snapshot, where it is already lazily
   deserialized, so the measured gain is small: about 1% on `002_hello.ts`
   (median 42.4 ms against 42.8 ms, debug build) and none on worker startup.
   Taking it out of the snapshot needs a second snapshot built without
   `ext/node`. That would add several MB to the binary, so measure it against
   the startup win before doing it.
3. ✅ Spec tests in `tests/specs/native_mode/`.
   `DENO_UNIT_NO_NODE=1 cargo test
   -p unit_tests --test unit` runs the whole
   unit suite in native mode.
4. Later, decide whether `deno init` scaffolds should default to native mode.

**Status:** with `--no-node`, 109 of 113 `tests/unit` files pass. Two import
`node:` modules and are skipped (`serve_test`, `umask_test`). Two need a GPU
(`webgpu_test`, `canvas_test`) and fail the same way in default mode on machines
without one. Native mode starts slightly faster than default mode, see item 2.

**Done when:** `deno run --no-node` passes the full `tests/unit` suite and
starts faster than the default mode on `tests/bench`.

---

## M2: The built-in standard library

_Goal: the common needs of an app or CLI are covered without any import._

Selection rule: an API belongs in the runtime if most apps need it, if a native
implementation is meaningfully faster, or if it exists only in Node or a
competitor today. Everything ships as `Deno.*`, typed in
`cli/tsc/dts/lib.deno.ns.d.ts`, guarded by permissions, and starts behind
`--unstable-<name>`.

| Priority | API                                                    | Why / starting point                                                                                                  |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| P0       | `Deno.openSqlite()` / `Database`                       | Exists today only as `node:sqlite`. Wrap the Rust code in `ext/node_sqlite` behind a native API.                      |
| P0       | `Deno.password.hash/verify` (argon2id, bcrypt)         | Every web app needs it. Today it takes WASM or npm. The `argon2` crate is already in `Cargo.lock`. Run it off-thread. |
| P0       | Built-in `assert` / `expect` for `Deno.test`           | `deno init` currently scaffolds `jsr:@std/assert` just to write a test (`cli/tools/init/mod.rs`).                     |
| P1       | `Deno.serve` routing (`URLPattern`-based route table)  | `URLPattern` is already global. Adding route tables removes the need for a router dependency.                         |
| P1       | `Deno.hash` (fast non-crypto: xxhash, plus crc32)      | Sync and fast, unlike `crypto.subtle`. `xxhash-rust` and `crc32fast` are already in `Cargo.lock`.                     |
| P1       | Data formats: `Deno.parseToml/Yaml`, `stringify*`, CSV | Config files and data. `toml` is already in `Cargo.lock`. YAML and CSV need new crates.                               |
| P1       | `Deno.glob()`                                          | Native filesystem globbing that respects permissions. `glob` and `globset` are already in `Cargo.lock`.               |
| P2       | `Deno.$` shell (built on the `deno task` shell)        | The task shell already exists in Rust. Expose it as a tagged template.                                                |
| P2       | `Deno.semver`, `Deno.uuid.v7()`                        | Small, but common reasons to add a dependency.                                                                        |
| P2       | CLI argument parsing (`Deno.parseArgs`)                | Built-in for scripts.                                                                                                 |
| P3       | Built-in SQL clients (Postgres, Redis)                 | A large surface. Design it after the SQLite API settles.                                                              |

**Done when:** every P0 and P1 item has shipped behind a flag with docs and spec
tests, and `deno init` produces a project with zero dependencies.

**Status:** done. Every P0 and P1 item, plus `Deno.semver`, `Deno.uuid`,
`Deno.parseArgs` and `Deno.$` from P2, ships in `ext/mokou`, each behind its own
`--unstable-<name>` flag. They are documented in
`cli/tsc/dts/lib.deno.unstable.d.ts` and `ext/mokou/README.md`, with unit tests
(`tests/unit/done_*_test.ts`) and spec tests (`tests/specs/mokou_std/`).
`Deno.serve` routing is `Deno.router()`, which builds a handler for
`Deno.serve`. `Deno.$` (P2) runs commands through the `deno task` shell, with
quoted interpolation and `.text()`, `.json()`, `.lines()`, `.quiet()`,
`.nothrow()`, `.cwd()`, `.env()`, `.stdin()` and `.signal()`. It needs
unrestricted `--allow-run`, because the shell's built-ins and any program it
starts are not limited by the other permissions. `deno init` (the default,
`--lib` and `--serve` templates) now writes `"unstable": ["assert"]` (plus
`"router"` for `--serve`) instead of importing `jsr:@std/assert` and
`jsr:@std/http`, so new projects have no dependencies. Still open: SQL clients
(P3).

---

## M3: Performance

_Goal: numbers we publish and defend._

1. ✅ **Baseline benchmark suite.** `tests/bench/compare/run.ts` compares Mokou
   with upstream Deno, Node and Bun on startup, JSON, fs read/write, SQLite,
   `fetch` and `Deno.serve` req/s (with `wrk`), and prints a Markdown table or
   JSON. `--baseline` fails when Mokou is slower than an earlier result, which
   item 2 builds on. No numbers are published yet: they need a release build on
   a fixed machine.
2. Run it in CI on every merge to `main` and fail on regressions.
3. Go after the targets M1 opens up: snapshot size and startup time without
   `ext/node`.
4. Profile the `Deno.serve` hot path (`ext/http`, `libs/http_h1`).

**Done when:** a public benchmark page tracks every release.

---

## M4: Competitive native APIs

_Goal: anything a competing runtime has built-in, Mokou has built-in._

Keep a living parity matrix (feature → Bun / Node / Mokou status). Each gap
becomes an M2-style item. Gaps we already know about include password hashing,
SQLite, a shell API, glob, semver, fast hashing, an S3 client, and a stable
public bundler API (`Deno.bundle` exists but is unstable).

---

## M5: Products

_Goal: build the products that make Mokou a platform._

- **Mokou Desktop.** `deno desktop` already exists (`cli/tools/desktop.rs`,
  `doc/desktop-architecture.md`, `cli/tsc/dts/lib.deno.desktop.d.ts`). It
  downloads pinned `laufey` backends, which we now mirror on our own releases
  (M0 #6). Next, finish and stabilize the API.
- **First-party web framework.** A Fresh-style framework built on M2 routing and
  `Deno.bundle`, with zero npm dependencies. `deno compile .` already detects
  frameworks (`cli/tools/framework.rs`).
- **Templates.** `mokou init --web | --desktop | --cli`, each with zero
  dependencies.

---

## How to pick up work

1. Pick an item and open an issue titled `[M<n>] <item>`.
2. Keep each PR to a single item (see CLAUDE.md: no drive-by changes).
3. A new API starts behind `--unstable-<name>`, with types, spec tests in
   `tests/specs/`, and unit tests in `tests/unit/`.
