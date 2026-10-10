// Copyright 2018-2026 the Deno authors. MIT license.
// deno-lint-ignore-file no-console

// Shared helpers for the benchmark cases. Each case runs unchanged on Mokou,
// Deno, Node and Bun, uses the fastest idiomatic API of the runtime it finds
// itself on, and prints one JSON line with its timings for `run.ts`.

/** "mokou", "deno", "bun" or "node". */
export const runtime = globalThis.Mokou
  ? "mokou"
  : globalThis.Bun
  ? "bun"
  : globalThis.Deno
  ? "deno"
  : "node";

export const args = globalThis.Deno
  ? globalThis.Deno.args
  : globalThis.process.argv.slice(2);

/**
 * Runs `fn` `warmup` times, then times `samples` runs of it. Each run calls
 * `fn` `iterations` times, and the reported numbers are per call.
 */
export async function bench(fn, options = {}) {
  const { warmup = 3, samples = 10, iterations = 1 } = options;
  for (let i = 0; i < warmup; i++) {
    for (let j = 0; j < iterations; j++) await fn();
  }
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    for (let j = 0; j < iterations; j++) await fn();
    times.push((performance.now() - start) / iterations);
  }
  return summarize(times);
}

export function summarize(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { median, min: sorted[0], max: sorted.at(-1), samples: times.length };
}

/** Prints the result line that `run.ts` reads. */
export function report(result) {
  console.log(JSON.stringify({ runtime, ...result }));
}
