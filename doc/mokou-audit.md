# Mokou fork audit (baseline: Deno 2.9.7)

This is a snapshot of what Mokou inherited at the fork point (upstream commit
`3d44d1d8`). Line counts are `.rs`/`.js`/`.ts`/`.mjs` source and exclude
`tests/` directories. Re-run the commands at the bottom to refresh it.

## 1. How much of the tree is Node compatibility

| Area                                           | Paths                                                                                                                                                   | Lines     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Node / npm compat                              | `ext/node`, `ext/node_crypto`, `ext/node_sqlite`, `ext/napi`, `libs/npm*`, `libs/node_resolver`, `libs/node_shim`, `libs/package_json`, `libs/napi_sys` | **~255k** |
| Everything else in `ext/`, `runtime/`, `libs/` | the rest, including `libs/core` at ~68k                                                                                                                 | ~357k     |
| **Total**                                      | `ext/` + `runtime/` + `libs/`                                                                                                                           | ~612k     |

About **42%** of the runtime-side code exists to emulate Node. `ext/node` alone
is ~173k lines (40k Rust, 133k JS/TS, 119 polyfill entries). That is four times
the size of `ext/web`, the next largest extension.

The native Deno extensions, largest first: `web` 42k, `crypto` 18k, `http` 15k,
`fetch` 11k, `webgpu` 9k, `net` 9k, `telemetry` 6k, `fs` 5k, `ffi` 5k, `process`
4k, `io` 4k, `kv` 3k, `websocket` 3k, `cache` 2k, `cron` 2k, `canvas` 2k,
`image` 2k, `os` 2k, `tls` 1k.

## 2. Where Node leaks into the default (Deno-native) path

- **Timers.** The global `setTimeout`/`setInterval` are lazily loaded from
  `node:timers` (`runtime/js/98_global_scope_shared.js:95`) and return a Node
  `Timeout` object instead of a number (`ext/node/polyfills/timers.ts:65`). The
  `node-globals` unstable flag is a no-op that is kept only for compatibility
  (`runtime/features/data.rs`).
- **Native capability that exists only behind `node:`.** SQLite is implemented
  in Rust (`ext/node_sqlite`, ~6.5k lines) but is exposed only as `node:sqlite`.
  `Deno.*` has no SQLite API.
- **Scaffolding pulls in dependencies.** `deno init` writes `jsr:@std/assert`
  (and `jsr:@std/http` for `--serve`) into new projects just to write a test
  (`cli/tools/init/mod.rs:157`).

## 3. Links back to upstream that a hard fork must cut (M0)

| What                    | Where                                                                                          | Risk                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `upgrade` download URLs | `cli/tools/upgrade.rs:42-44` (`github.com/denoland/deno/releases`, `dl.deno.land`)             | **High.** `deno upgrade` replaced a Mokou build with upstream Deno. **Fixed in M0.**                   |
| Panic report URL        | `cli/lib.rs:634`, `cli/tools/upgrade.rs:279`                                                   | Users were sent to file Mokou bugs upstream. **Fixed in M0.**                                          |
| CI gating               | `.github/workflows/ci.ts:33` `isRepository("denoland/deno")`, referenced 21 more times         | Release, cache and publish jobs silently skip on this repo. **Fixed in M0** (`isReleaseRepo`).         |
| CI delta builds         | `.github/workflows/ci.ts:945-974`                                                              | Downloads the previous **upstream** release to build deltas from. **Fixed in M0.**                     |
| `deploy` subcommand     | `cli/tools/deploy.rs`                                                                          | Fetches and runs the Deno Deploy CLI from JSR. **Disabled in M0** unless `MOKOU_ENABLE_DENO_DEPLOY=1`. |
| `compile` runtime       | `cli/standalone/binary.rs` (`download_base_binary`)                                            | Embedded upstream's `denort` from `dl.deno.land`. **Fixed in M0** (Mokou releases).                    |
| `desktop` backends      | `cli/tools/desktop.rs`, `cli/laufey_sums.lock`                                                 | Downloaded third-party `laufey` binaries. **Fixed in M0** (mirrored on Mokou releases, SHA-pinned).    |
| Version and user agent  | `cli/lib/version.rs`, `runtime/js/01_version.ts`, `runtime/js/97_navigator_user_agent_data.js` | Mokou identifies itself as Deno. **Fixed in M0** (`Mokou/<ver> Deno/<base>`).                          |

The default registries (`jsr.io` in `libs/resolver/factory.rs:187`, and
`registry.npmjs.org` in `libs/npmrc/lib.rs:22`) are ecosystem endpoints, not
upstream control. Keep them, but document them.

## 4. Assets Mokou can build on

- **`deno desktop`** (`cli/tools/desktop.rs`, 8.4k lines, plus
  `desktop_devtools.rs` and `doc/desktop-architecture.md`) is already in the
  tree. It is the foundation for Mokou Desktop.
- **Framework detection for `deno compile .`** (`cli/tools/framework.rs`) covers
  Fresh, Next, Astro, SvelteKit and others.
- **Already-vendored crates** that make M2 APIs cheap to add: `argon2`,
  `xxhash-rust`, `twox-hash`, `crc32fast`, `glob`, `globset`, `toml`, `uuid`
  (all present in `Cargo.lock`).
- The **task shell** (`deno task`) is a Rust shell implementation that could
  back a `Deno.$` API.
- The **unstable feature registry** (`runtime/features/data.rs`) is the place to
  gate every new Mokou API.

## Refreshing these numbers

```sh
cnt(){ find "$@" -type f \( -name '*.rs' -o -name '*.js' -o -name '*.ts' -o -name '*.mjs' \) \
  -not -path '*/tests/*' | xargs cat | wc -l; }
cnt ext/node ext/node_crypto ext/node_sqlite ext/napi libs/npm libs/npm_installer \
  libs/node_resolver libs/node_shim libs/npm_cache libs/npmrc libs/package_json libs/napi_sys
cnt ext runtime libs
grep -n "isDenoland" .github/workflows/ci.ts | wc -l
```
