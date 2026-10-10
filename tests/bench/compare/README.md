# Cross-runtime benchmarks

Compares Mokou with upstream Deno, Node and Bun (ROADMAP M3). Each case in
`cases/` runs unchanged on every runtime and uses the fastest idiomatic API of
the runtime it finds itself on, for example `Deno.openSqlite()` on Mokou,
`bun:sqlite` on Bun and `node:sqlite` on Deno and Node.

```sh
cargo build --release
./target/release/deno run -A tests/bench/compare/run.ts --json results.json
```

| Benchmark        | Measures                                                       |
| ---------------- | -------------------------------------------------------------- |
| `startup`        | Running a file that prints one line (median of 20 runs)        |
| `json.parse`     | `JSON.parse()` of 0.9 MB                                       |
| `json.stringify` | `JSON.stringify()` of the same data                            |
| `fs.read`        | Reading a 1 MiB file                                           |
| `fs.write`       | Writing a 1 MiB file                                           |
| `sqlite`         | Inserting 10k rows in one transaction, then selecting them all |
| `fetch`          | One sequential `fetch()` to a local server (Mokou's)           |
| `serve`          | Requests per second for a hello world server, `wrk -t2 -c64`   |

Times are the median per operation in milliseconds, and the table shows how many
times faster Mokou is than each other runtime. `serve` needs
[`wrk`](https://github.com/wg/wrk) on `PATH` and is reported as an error without
it.

Runtimes are looked up on `PATH` (`deno`, `node`, `bun`) unless you pass their
paths with `--deno`, `--node` and `--bun`. Mokou defaults to
`target/release/deno`. A `deno` that turns out to be Mokou is skipped, and
`--skip <runtime>` leaves one out. `--only startup,serve` runs a subset.

Use a release build: the harness warns when Mokou is a debug build, whose
numbers mean nothing.

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
