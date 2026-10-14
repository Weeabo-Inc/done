# Cross-runtime benchmarks

Compares Mokou with upstream Deno, Node and Bun (ROADMAP M3). Each case in
`cases/` runs unchanged on every runtime and uses the fastest idiomatic API of
the runtime it finds itself on, for example `Deno.openSqlite()` on Mokou,
`bun:sqlite` on Bun and `node:sqlite` on Deno and Node.

```sh
cargo build --release
./target/release/deno run -A tests/bench/compare/run.ts --json results.json
```

| Benchmark         | Measures                                                       |
| ----------------- | -------------------------------------------------------------- |
| `startup`         | Running a file that prints one line (median of 20 runs)        |
| `startup.no-node` | The same with `--no-node` (Mokou only)                         |
| `json.parse`      | `JSON.parse()` of 0.9 MB                                       |
| `json.stringify`  | `JSON.stringify()` of the same data                            |
| `fs.read`         | Reading a 1 MiB file                                           |
| `fs.write`        | Writing a 1 MiB file                                           |
| `sqlite`          | Inserting 10k rows in one transaction, then selecting them all |
| `fetch`           | One sequential `fetch()` to a local server (Mokou's)           |
| `serve`           | Requests per second for a hello world server, `wrk -t2 -c64`   |

Times are the median per operation in milliseconds, and the table shows how many
times faster Mokou is than each other runtime. `serve` needs
[`wrk`](https://github.com/wg/wrk) on `PATH` and is reported as an error without
it.

Runtimes are looked up on `PATH` (`deno`, `node`, `bun`) unless you pass their
paths with `--deno`, `--node` and `--bun`. Mokou defaults to
`target/release/deno`. A `deno` that turns out to be Mokou is skipped, and
`--skip <runtime>` leaves one out. `--only startup,serve` runs a subset.

Use a release build: the harness warns when Mokou is a debug build, whose
numbers mean nothing. The results also record each runtime's binary size, the
machine (CPU and memory) and, with `--label v0.1.0`, a name for the run.

## Public page

Every release gets a results file in `site/benchmarks/results/`, and `page.ts`
builds `site/benchmarks/index.html` from all of them: the newest run against
Deno, Node and Bun, and Mokou's own numbers release by release.

```sh
mokou run -A tests/bench/compare/run.ts --label v0.1.0 \
  --json site/benchmarks/results/v0.1.0.json
mokou run -A tests/bench/compare/page.ts \
  site/benchmarks/results site/benchmarks/index.html
```

The `bench_release` workflow does this when a release is published (it needs the
release to contain `mokou-x86_64-unknown-linux-gnu.zip`), attaches the JSON to
the release and opens a pull request with the new results and page.

## Is a change real?

Single runs on a shared machine vary by 10 to 30%. `ab.ts` runs commands
interleaved, round after round, and says whether the difference in medians is
larger than the noise (a bootstrap 95% interval that excludes zero):

```sh
mokou run -A tests/bench/compare/ab.ts --runs 200 \
  "default=target/release/deno run -A hello.mjs" \
  "no-node=target/release/deno run --no-node -A hello.mjs"
```

For changes too small to see in time, count instructions instead, which is
deterministic: `valgrind --tool=callgrind target/release/deno run -A hello.mjs`.

## Regressions

`--baseline previous.json` compares Mokou against an earlier `--json` result and
exits with status 1 when any benchmark is more than `--threshold` (default
`0.1`, 10%) slower. Only Mokou's numbers are compared, so the other runtimes
don't need to be installed for a regression check:

```sh
./target/release/deno run -A tests/bench/compare/run.ts \
  --skip deno --skip node --skip bun --baseline main.json
```

CI does exactly this in the `bench` job (`.github/workflows/ci.ts`) on every
push to `main` and on PRs labelled `ci-bench`: it compares against the last
`main` result, kept in the Actions cache, with a 25% threshold, and puts the
table in the job summary.

Benchmarks on shared CI machines are noisy. Compare results from the same
machine type, and prefer a threshold above the run-to-run variation you see.
