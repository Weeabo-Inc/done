# Done Roadmap

This file turns the five goals in the [README](README.md) into milestones you
can ship. Each milestone lists concrete work items and what "done" means for
it. Facts about the starting tree, such as sizes, file paths and upstream
links, are in [doc/done-audit.md](doc/done-audit.md).

Milestones are ordered by dependency, not by size. M0 blocks shipping a release.
M1 to M4 can run in parallel once M0 has landed.

---

## M0: Independence (hard-fork hygiene)

_Goal: a Done binary that never talks to, updates from, or reports bugs to
upstream Deno by accident._

| # | Work item                                                                                                                       | Where                                                       |
| - | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1 | Rename the binary to `done`, and decide whether to ship a `deno` alias for drop-in compatibility                                  | `cli/Cargo.toml`, `cli/main.rs`, packaging, spec tests      |
| 2 | Give Done its own version scheme (suggestion: `done 0.1.0 (deno 2.9.7 base)` in `--version`)                                     | `cli/lib/version.rs`, `runtime/js/01_version.ts`                |
| 3 | Point `upgrade` at Done releases, or disable it until Done has releases. **It currently replaces the binary with upstream Deno.** | `cli/tools/upgrade.rs` (`RELEASE_URL`, `DL_RELEASE_URL`, `CANARY_URL`) |
| 4 | Send panic and bug reports to `weeabo-inc/done`                                                                                  | `cli/lib.rs:634`, `cli/tools/upgrade.rs`                    |
| 5 | Make CI and release workflows run on this repo. 21 places are gated on `isRepository("denoland/deno")`                             | `.github/workflows/ci.ts`, then regenerate `*.generated.yml` |
| 6 | Review every outbound default, including telemetry, `deploy` (which fetches the Deno Deploy CLI from JSR) and default registries, and keep, rename or remove each one | `cli/tools/deploy.rs`, `libs/npmrc`, `libs/resolver/factory.rs` |
| 7 | Change the user agent and `navigator.userAgent` to `Done/<ver>`. Keep `Deno.build`/`Deno.version` so feature detection still works | `runtime/js/97_navigator_user_agent_data.js`, `ext/fetch`    |

**Done when:** `done --version`, `done upgrade`, a forced panic, and a CI run on
`weeabo-inc/done` all point at Done and never at upstream Deno.

### Decision needed: the `Deno` global

Recommendation: **keep `Deno.*` as the canonical namespace**, and optionally
add `globalThis.Done` as an alias. If we rename it, every Deno program, JSR
package and type definition stops working, and we gain nothing in return. The
binary and branding can change, but the API surface stays.

---

## M1: Deno-native mode

_Goal: Node compatibility is something you opt into, not something that is
always on underneath._

Node compatibility is about 255k lines (around 42% of everything under `ext/`,
`runtime/` and `libs/`), and parts of it are now on by default. The global
`setTimeout`/`setInterval` are loaded from `node:timers`
(`runtime/js/98_global_scope_shared.js`), and the `node-globals` flag is a no-op
because that behavior can no longer be turned off.

1. Add a **`--no-node` flag and a `"node": false` setting in `deno.json`** that:
   - reject `npm:` and `node:` specifiers with a clear error,
   - skip `package.json` / `node_modules` discovery,
   - restore web-standard timer globals (`setTimeout` returns a number).
2. **Do not load `ext/node` at all** in that mode (it should not be in the
   snapshot and not be initialized), then measure the startup and memory
   savings.
3. Add a spec test suite under `tests/specs/native_mode/`.
4. Later, decide whether `deno init` scaffolds should default to native mode.

**Done when:** `done run --no-node` passes the full `tests/unit` suite and
starts faster than the default mode on `tests/bench`.

---

## M2: The built-in standard library

_Goal: the common needs of an app or CLI are covered without any import._

Selection rule: an API belongs in the runtime if most apps need it, if a native
implementation is meaningfully faster, or if it exists only in Node or a
competitor today. Everything ships as `Deno.*`, typed in
`cli/tsc/dts/lib.deno.ns.d.ts`, guarded by permissions, and starts behind
`--unstable-<name>`.

| Priority | API                                                     | Why / starting point                                                                                         |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| P0       | `Deno.openSqlite()` / `Database`                        | Exists today only as `node:sqlite`. Wrap the Rust code in `ext/node_sqlite` behind a native API.             |
| P0       | `Deno.password.hash/verify` (argon2id, bcrypt)          | Every web app needs it. Today it takes WASM or npm. The `argon2` crate is already in `Cargo.lock`. Run it off-thread.                               |
| P0       | Built-in `assert` / `expect` for `Deno.test`             | `deno init` currently scaffolds `jsr:@std/assert` just to write a test (`cli/tools/init/mod.rs`).            |
| P1       | `Deno.serve` routing (`URLPattern`-based route table)  | `URLPattern` is already global. Adding route tables removes the need for a router dependency.               |
| P1       | `Deno.hash` (fast non-crypto: xxhash, plus crc32)        | Sync and fast, unlike `crypto.subtle`. `xxhash-rust` and `crc32fast` are already in `Cargo.lock`.             |
| P1       | Data formats: `Deno.parseToml/Yaml`, `stringify*`, CSV  | Config files and data. `toml` is already in `Cargo.lock`. YAML and CSV need new crates.                               |
| P1       | `Deno.glob()`                                            | Native filesystem globbing that respects permissions. `glob` and `globset` are already in `Cargo.lock`.      |
| P2       | `Deno.$` shell (built on the `deno task` shell)          | The task shell already exists in Rust. Expose it as a tagged template.                                       |
| P2       | `Deno.semver`, `Deno.uuid.v7()`                          | Small, but common reasons to add a dependency.                                                               |
| P2       | CLI argument parsing (`Deno.parseArgs`)                 | Built-in for scripts.                                                                                        |
| P3       | Built-in SQL clients (Postgres, Redis)                  | A large surface. Design it after the SQLite API settles.                                                     |

**Done when:** every P0 and P1 item has shipped behind a flag with docs and
spec tests, and `deno init` produces a project with zero dependencies.

---

## M3: Performance

_Goal: numbers we publish and defend._

1. Build a **baseline benchmark suite** (startup, `Deno.serve` req/s, fs
   read/write, SQLite, JSON, `fetch`) that compares Done against upstream Deno,
   Node and Bun. Start from `tests/bench`.
2. Run it in CI on every merge to `main` and fail on regressions.
3. Go after the targets M1 opens up: snapshot size and startup time without
   `ext/node`.
4. Profile the `Deno.serve` hot path (`ext/http`, `libs/http_h1`).

**Done when:** a public benchmark page tracks every release.

---

## M4: Competitive native APIs

_Goal: anything a competing runtime has built-in, Done has built-in._

Keep a living parity matrix (feature → Bun / Node / Done status). Each gap
becomes an M2-style item. Gaps we already know about include password hashing,
SQLite, a shell API, glob, semver, fast hashing, an S3 client, and a stable
public bundler API (`Deno.bundle` exists but is unstable).

---

## M5: Products

_Goal: build the products that make Done a platform._

- **Done Desktop.** `deno desktop` already exists (`cli/tools/desktop.rs`,
  `doc/desktop-architecture.md`, `cli/tsc/dts/lib.deno.desktop.d.ts`). It
  downloads pinned `laufey` backends. Decide whether to keep that dependency or
  host the binaries ourselves, then finish and stabilize the API.
- **First-party web framework.** A Fresh-style framework built on M2 routing
  and `Deno.bundle`, with zero npm dependencies. `deno compile .` already
  detects frameworks (`cli/tools/framework.rs`).
- **Templates.** `done init --web | --desktop | --cli`, each with zero
  dependencies.

---

## How to pick up work

1. Pick an item and open an issue titled `[M<n>] <item>`.
2. Keep each PR to a single item (see CLAUDE.md: no drive-by changes).
3. A new API starts behind `--unstable-<name>`, with types, spec tests in
   `tests/specs/`, and unit tests in `tests/unit/`.
