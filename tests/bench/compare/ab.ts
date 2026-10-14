#!/usr/bin/env -S deno run --allow-run
// Copyright 2018-2026 the Deno authors. MIT license.
// deno-lint-ignore-file no-console

// Compares how long commands take to run, interleaving them round after round
// so that drift in machine load (thermal limits, noisy neighbours) hits every
// command alike. Use it to decide whether a change to startup is real:
//
//   deno run -A tests/bench/compare/ab.ts --runs 200 \
//     "mokou=target/release/deno run -A hello.mjs" \
//     "no-node=target/release/deno run --no-node -A hello.mjs" \
//     "deno=deno run -A hello.mjs"
//
// For every command it prints the median, the 10th and 90th percentile, and,
// for all but the first, how the median compares with the first command and
// whether the gap is larger than the spread (a bootstrap 95% interval of the
// difference between medians that excludes zero).

function usage(): never {
  console.error(
    'Usage: ab.ts [--runs N] [--warmup N] "label=command args..." ...',
  );
  Deno.exit(2);
}

let runs = 100;
let warmup = 10;
const commands: { label: string; argv: string[] }[] = [];
const args = [...Deno.args];
while (args.length) {
  const arg = args.shift()!;
  if (arg === "--runs") runs = Number(args.shift());
  else if (arg === "--warmup") warmup = Number(args.shift());
  else {
    const eq = arg.indexOf("=");
    if (eq < 1) usage();
    commands.push({
      label: arg.slice(0, eq),
      argv: arg.slice(eq + 1).split(/\s+/).filter(Boolean),
    });
  }
}
if (commands.length < 1 || !(runs > 0)) usage();

async function time(argv: string[]): Promise<number> {
  const start = performance.now();
  const result = await new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "null",
    stderr: "piped",
  }).output();
  const elapsed = performance.now() - start;
  if (!result.success) {
    throw new Error(
      `${argv.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return elapsed;
}

const samples = commands.map(() => [] as number[]);
for (let round = -warmup; round < runs; round++) {
  // Rotate the order so no command always runs right after the same one.
  for (let k = 0; k < commands.length; k++) {
    const i = (k + Math.max(round, 0)) % commands.length;
    const elapsed = await time(commands[i].argv);
    if (round >= 0) samples[i].push(elapsed);
  }
}

const sorted = samples.map((s) => [...s].sort((a, b) => a - b));
const quantile = (s: number[], q: number) =>
  s[Math.min(s.length - 1, Math.floor(q * s.length))];
const median = (s: number[]) => quantile(s, 0.5);

/** A bootstrap 95% interval for median(a) - median(b). */
function interval(a: number[], b: number[]): [number, number] {
  const draws = [];
  const pick = (s: number[]) =>
    median(
      Array.from({ length: s.length }, () =>
        s[Math.floor(Math.random() * s.length)]).sort((x, y) =>
          x - y
        ),
    );
  for (let i = 0; i < 1000; i++) draws.push(pick(a) - pick(b));
  draws.sort((x, y) => x - y);
  return [draws[25], draws[974]];
}

console.log(`${runs} runs each, interleaved\n`);
const base = sorted[0];
for (let i = 0; i < commands.length; i++) {
  const s = sorted[i];
  let line =
    `${commands[i].label.padEnd(14)} median ${median(s).toFixed(1)} ms` +
    `  p10 ${quantile(s, 0.1).toFixed(1)}  p90 ${quantile(s, 0.9).toFixed(1)}`;
  if (i > 0) {
    const [lo, hi] = interval(s, base);
    const diff = median(s) - median(base);
    const real = lo > 0 || hi < 0;
    line += `  ${diff >= 0 ? "+" : ""}${diff.toFixed(1)} ms (${
      ((diff / median(base)) * 100).toFixed(1)
    }%) vs ${commands[0].label}, ${real ? "significant" : "within noise"}`;
  }
  console.log(line);
}
