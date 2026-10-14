# Performance notes

What was measured for ROADMAP M3, how, and what it showed. The public numbers
are on [the benchmark page](../site/benchmarks/index.html), built from
`site/benchmarks/results/`. Everything here was measured on one shared 4-vCPU
virtual machine (Intel Xeon 2.1 GHz, 16 GB), so treat differences under about
15% on the millisecond benchmarks as noise. Where a claim needs more than that,
it was checked with `tests/bench/compare/ab.ts` (interleaved runs and a
bootstrap interval) or by counting instructions with callgrind, which doesn't
vary from run to run.

## Build the same way as the comparison

Mokou's startup looked 28% slower than upstream Deno 2.9.7 at first, and the
cause was the build, not the code. The official release is built in two passes:
trace which functions run at startup, then relink with that order
(`tools/startup_order`, the "Trace startup order" and "Relink" steps in
`ci.ts`), and package it with the unwind sections removed. Compared the same
way:

| `hello.mjs`, 200 to 300 interleaved runs | median  | against upstream Deno |
| ---------------------------------------- | ------- | --------------------- |
| Upstream Deno 2.9.7 (official)           | 20.4 ms |                       |
| Mokou, plain `cargo build --release`     | 26.2 ms | +28%, significant     |
| Mokou, with the startup order            | 21.4 ms | +4.9%, significant    |

Always benchmark Mokou built with the startup order, which is what a release is.
To make one locally:

```sh
cargo build --release
cp -p target/release/deno target/release/deno-before-startup-order
target/release/deno run -A tools/startup_order/generate_linux_function_orderfile.ts \
  --binary $PWD/target/release/deno-before-startup-order --output linux.order \
  --repeats 3 --workload-profile run-first
DENO_USE_STARTUP_ORDER=1 DENO_STARTUP_ORDER_FILE=$PWD/linux.order \
  cargo build --release
```

The snapshot's minified sources (`DENO_SNAPSHOT_MINIFY_SOURCES=1`, as CI does)
need a `deno` on `PATH` and access to npm for `rolldown`.

## Mokou against upstream Deno

With that build (median of three interleaved rounds, noisy):

- Startup is 4.3% slower than upstream (21.6 against 20.8 ms over 300 runs,
  significant) and runs 2.6 million more instructions (56.8 against 54.2
  million). Registering Mokou's own ops is a small part of that:
  `create_op_ctxs` is 0.2 million instructions in total. Most of startup is V8
  deserializing the snapshot (creating the isolate is about 35% of the
  instructions, creating the whole runtime about 70%), so the likely cause is a
  bigger snapshot, not slower code. Finding it needs a symbolized upstream build
  to compare against.
- Every other benchmark is within noise of upstream Deno: JSON, file reads and
  writes, `fetch`, SQLite and `Deno.serve` (86,000 against 88,000 requests per
  second).
- The packaged binary is 102.0 MB against 95.8 MB, 6.5% bigger. Before packaging
  it also holds 8.8 MB of unwind sections, which the release workflow removes.
  The 6 MB is code for Mokou's additions: `.text` is 4.9 MB bigger.

## ROADMAP M3 item 3: without `ext/node`

Question: is a second snapshot without `ext/node` worth it? Measured, on the
same build:

|                                           | default | `--no-node` | change          |
| ----------------------------------------- | ------- | ----------- | --------------- |
| Median startup (300 interleaved runs)     | 21.6 ms | 21.1 ms     | -0.6 ms (-2.7%) |
| Instructions (`hello.mjs`, callgrind)     | 56.8 M  | 52.9 M      | -6.8%           |
| Upstream Deno for reference, instructions | 54.2 M  |             |                 |

`--no-node` already skips the Node bootstrap, and that is where the gain is.
What a second snapshot could add is the cost of the Node objects that are still
in the snapshot, and V8 deserializes those lazily, so it isn't paid unless used.
The earlier debug-build measurement said the same (about 1%). The sources are
3.4 MB of JavaScript before minification, which is the most the binary could
shrink.

Decision: don't build a second snapshot. The remaining win is below what can be
measured and the binary would need both. Revisit if Node compatibility becomes a
build-time option, where the size would drop as well.

A caution: the first `--no-node` run, on a build without the startup order,
showed 8% faster. That was the function layout, not Node, and it disappeared
once both runs used the same build process.

## ROADMAP M3 item 4: the `Deno.serve` hot path

Profiled a hello world server in three ways.

**Instructions per request** (callgrind, `--jitless` so it can run under
valgrind, 52,865 requests, startup subtracted): 22,000, of which

| Where                                             | instructions | share |
| ------------------------------------------------- | -----------: | ----: |
| V8 (interpreter in jitless mode, builtins)        |       13,700 |   62% |
| Rust dependencies (parsing helpers, syscall glue) |        2,000 |    9% |
| tokio and mio                                     |        1,800 |    8% |
| `ext/http`                                        |        1,400 |    7% |
| `libs/http_h1` (parse and write)                  |        1,400 |    7% |
| libc (`memcpy`, `malloc`)                         |          800 |    4% |
| `deno_core` (ops, resources)                      |          800 |    4% |

The V8 share is inflated: with the JIT off, the JavaScript in `00_serve.ts` runs
in the interpreter. The Rust side is about 8,000 instructions per request, of
which the HTTP/1 parser and response writer are 1,400, which leaves little to
take out.

**V8 CPU profile with the JIT on** (`--cpu-prof`, `wrk -t2 -c64`, about 94,000
requests per second): the main thread is idle 96% of the time. JavaScript is
about 4% of it, mostly `trySetServeFastStaticResponse` (a static `Response`
takes the fast path and is answered without a round trip through JavaScript).

**Throughput**: 86,000 against upstream's 88,000, Bun's 98,000 and Node's 39,000
requests per second.

Conclusion: nothing in the hot path that the profile points at, so no change was
made. At this rate the server isn't limited by its own code: the load generator
and the kernel's loopback share four cores. To find headroom, repeat on a larger
machine with `wrk -t4`, and use `perf` with the symbols from
`target/release/deno` (this machine has no `perf`; `valgrind` was what was
available).

## Optimizations

Each entry was measured as an interleaved A/B of two `release-lite` builds that
differ only in that change (15 rounds, median). On this shared 4-vCPU VM, gaps
under about 5% are noise.

### File reads copied the whole file once more than needed

`Deno.readFile` and `Deno.readFileSync` read into a `Vec`, then cloned it
(`into_owned().to_vec()`) before handing it to V8. The `Vec` can be given to V8
as the backing store directly, so the clone is gone. `Deno.writeFileSync` also
copied its argument out of V8; it now borrows it.

| Case                   | Before   | After    | Change        |
| ---------------------- | -------- | -------- | ------------- |
| `readFileSync`, 1 MiB  | 0.753 ms | 0.633 ms | -15.9%        |
| `readFile`, 1 MiB      | 1.082 ms | 0.872 ms | -19.4%        |
| `writeFileSync`, 1 MiB | 1.095 ms | 1.063 ms | -2.9% (noise) |
| `readFileSync`, 1 KiB  | 5.70 us  | 5.77 us  | no change     |

## Reproducing

```sh
mokou run -A tests/bench/compare/run.ts --repeat 3 --label dev \
  --json results.json
mokou run -A tests/bench/compare/ab.ts --runs 300 \
  "default=mokou run -A hello.mjs" "no-node=mokou run --no-node -A hello.mjs"
valgrind --tool=callgrind --callgrind-out-file=cg.out \
  mokou run -A --v8-flags=--jitless hello.mjs
```
