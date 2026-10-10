#!/usr/bin/env -S deno run --allow-all
// Copyright 2018-2026 the Deno authors. MIT license.
// deno-lint-ignore-file no-console

// Compares Mokou with upstream Deno, Node and Bun on startup, JSON, file
// system, SQLite, fetch and HTTP server throughput. See README.md.
//
//   deno run -A tests/bench/compare/run.ts --mokou target/release/deno
//
// Runtimes that aren't found are skipped. The `serve` benchmark needs `wrk`.

const HERE = new URL(".", import.meta.url);
const CASES = new URL("./cases/", HERE);

interface Options {
  runtimes: Record<string, string | undefined>;
  only?: Set<string>;
  json?: string;
  markdown?: string;
  baseline?: string;
  threshold: number;
  duration: number;
}

function usage(): never {
  console.error(`Usage: run.ts [options]

  --mokou <path>       Mokou binary (default: target/release/deno)
  --deno <path>        Upstream Deno (default: \`deno\` on PATH, if it isn't Mokou)
  --node <path>        Node.js (default: \`node\` on PATH)
  --bun <path>         Bun (default: \`bun\` on PATH)
  --skip <runtime>     Don't run a runtime (repeatable)
  --only <a,b>         Only run these benchmarks
  --duration <s>       Seconds of load per server benchmark (default: 5)
  --json <file>        Write the results as JSON
  --markdown <file>    Write the results table as Markdown
  --baseline <file>    Fail if Mokou is slower than in this JSON result
  --threshold <ratio>  Allowed slowdown against the baseline (default: 0.1)`);
  Deno.exit(2);
}

function parseOptions(args: string[]): Options {
  const options: Options = { runtimes: {}, threshold: 0.1, duration: 5 };
  const skip = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    const take = () => {
      if (value === undefined) usage();
      i++;
      return value;
    };
    switch (flag) {
      case "--mokou":
      case "--deno":
      case "--node":
      case "--bun":
        options.runtimes[flag.slice(2)] = take();
        break;
      case "--skip":
        skip.add(take());
        break;
      case "--only":
        options.only = new Set(take().split(","));
        break;
      case "--duration":
        options.duration = Number(take());
        break;
      case "--json":
        options.json = take();
        break;
      case "--markdown":
        options.markdown = take();
        break;
      case "--baseline":
        options.baseline = take();
        break;
      case "--threshold":
        options.threshold = Number(take());
        break;
      default:
        usage();
    }
  }
  for (const name of skip) options.runtimes[name] = "";
  return options;
}

interface Runtime {
  name: string;
  path: string;
  version: string;
  /** Arguments that run a script file. */
  run: string[];
}

async function output(cmd: string, args: string[]) {
  const result = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function versionOf(path: string): Promise<string | undefined> {
  try {
    const result = await output(path, ["--version"]);
    return result.success ? result.stdout.split("\n")[0].trim() : undefined;
  } catch {
    return undefined;
  }
}

async function findRuntimes(options: Options): Promise<Runtime[]> {
  const candidates: [string, string, string[]][] = [
    [
      "mokou",
      options.runtimes.mokou ?? "target/release/deno",
      ["run", "-A", "--unstable-sqlite"],
    ],
    ["deno", options.runtimes.deno ?? "deno", ["run", "-A"]],
    ["node", options.runtimes.node ?? "node", ["--no-warnings"]],
    ["bun", options.runtimes.bun ?? "bun", []],
  ];
  const runtimes = [];
  for (const [name, path, run] of candidates) {
    if (path === "") continue;
    const version = await versionOf(path);
    if (version === undefined) {
      console.error(`Skipping ${name}: ${path} not found`);
      continue;
    }
    const isMokou = version.startsWith("mokou");
    if (isMokou !== (name === "mokou")) {
      console.error(`Skipping ${name}: ${path} is ${version}`);
      continue;
    }
    runtimes.push({ name, path, version, run });
  }
  return runtimes;
}

interface Measurement {
  /** Median: milliseconds, or requests per second. */
  value?: number;
  min?: number;
  max?: number;
  error?: string;
}

interface Benchmark {
  name: string;
  unit: "ms" | "req/s";
  description: string;
  measure(runtime: Runtime, context: Context): Promise<Measurement>;
}

interface Context {
  options: Options;
  fetchUrl?: string;
}

function caseFile(name: string) {
  return new URL(name, CASES).pathname;
}

/** Runs a case file and returns the JSON line it prints. */
async function runCase(
  runtime: Runtime,
  file: string,
  args: string[] = [],
): Promise<Measurement> {
  const result = await output(runtime.path, [
    ...runtime.run,
    caseFile(file),
    ...args,
  ]);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (!result.success || !line.startsWith("{")) {
    const message = (result.stderr || result.stdout).trim().split("\n")[0];
    return { error: message || "failed" };
  }
  const json = JSON.parse(line);
  return { value: json.median, min: json.min, max: json.max };
}

function caseBenchmark(
  name: string,
  file: string,
  args: string[],
  description: string,
): Benchmark {
  return {
    name,
    unit: "ms",
    description,
    measure: (runtime) => runCase(runtime, file, args),
  };
}

const startup: Benchmark = {
  name: "startup",
  unit: "ms",
  description: "Run a file that prints one line",
  async measure(runtime) {
    const args = [...runtime.run, caseFile("hello.mjs")];
    const times = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      const result = await new Deno.Command(runtime.path, {
        args,
        stdout: "null",
        stderr: "piped",
      }).output();
      const elapsed = performance.now() - start;
      if (!result.success) {
        return { error: new TextDecoder().decode(result.stderr).trim() };
      }
      // The first runs warm up the file system cache.
      if (i >= 5) times.push(elapsed);
    }
    times.sort((a, b) => a - b);
    return {
      value: times[Math.floor(times.length / 2)],
      min: times[0],
      max: times.at(-1),
    };
  },
};

const fetchBenchmark: Benchmark = {
  name: "fetch",
  unit: "ms",
  description: "One sequential fetch() to a local server",
  measure(runtime, context) {
    if (!context.fetchUrl) return Promise.resolve({ error: "no server" });
    return runCase(runtime, "fetch.mjs", [context.fetchUrl]);
  },
};

let nextPort = 4600;

interface Server {
  url: string;
  stop(): Promise<void>;
}

/** Starts `serve.mjs` and resolves once it prints "listening". */
async function startServer(runtime: Runtime): Promise<Server> {
  const port = nextPort++;
  const child = new Deno.Command(runtime.path, {
    args: [...runtime.run, caseFile("serve.mjs"), String(port)],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const timeout = setTimeout(() => child.kill(), 30_000);
  let seen = "";
  try {
    while (!seen.includes("listening")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("server exited before listening");
      seen += value;
    }
  } finally {
    clearTimeout(timeout);
  }
  // Keep draining stdout so the server never blocks on a full pipe.
  (async () => {
    while (!(await reader.read()).done);
  })().catch(() => {});
  return {
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await child.status;
    },
  };
}

async function hasWrk() {
  try {
    return (await output("wrk", ["--version"])).stdout.includes("wrk");
  } catch {
    return false;
  }
}

const serve: Benchmark = {
  name: "serve",
  unit: "req/s",
  description: "Hello world HTTP server under `wrk -t2 -c64`",
  async measure(runtime, context) {
    if (!await hasWrk()) return { error: "wrk not installed" };
    let server;
    try {
      server = await startServer(runtime);
    } catch (error) {
      return { error: String(error) };
    }
    try {
      // Warm up the JIT and the connection pool.
      await output("wrk", ["-t2", "-c64", "-d1s", server.url]);
      const result = await output("wrk", [
        "-t2",
        "-c64",
        `-d${context.options.duration}s`,
        server.url,
      ]);
      const match = result.stdout.match(/Requests\/sec:\s+([\d.]+)/);
      if (!match) return { error: result.stdout.trim().split("\n")[0] };
      return { value: Number(match[1]) };
    } finally {
      await server.stop();
    }
  },
};

const BENCHMARKS: Benchmark[] = [
  startup,
  caseBenchmark("json.parse", "json.mjs", ["parse"], "JSON.parse() 0.9 MB"),
  caseBenchmark(
    "json.stringify",
    "json.mjs",
    ["stringify"],
    "JSON.stringify() 0.9 MB",
  ),
  caseBenchmark("fs.read", "fs.mjs", ["read"], "Read a 1 MiB file"),
  caseBenchmark("fs.write", "fs.mjs", ["write"], "Write a 1 MiB file"),
  caseBenchmark(
    "sqlite",
    "sqlite.mjs",
    [],
    "Insert 10k rows in a transaction, then select them",
  ),
  fetchBenchmark,
  serve,
];

interface Results {
  date: string;
  commit?: string;
  os: string;
  arch: string;
  cpus: number;
  runtimes: { name: string; version: string }[];
  benchmarks: {
    name: string;
    unit: string;
    description: string;
    results: Record<string, Measurement>;
  }[];
}

function format(value: number, unit: string) {
  if (unit === "req/s") return `${Math.round(value).toLocaleString("en-US")}`;
  return value >= 100 ? value.toFixed(0) : value.toPrecision(3);
}

/** How many times faster Mokou is (above 1) or slower (below 1). */
function speedup(mokou: number, other: number, unit: string) {
  return unit === "req/s" ? mokou / other : other / mokou;
}

function toMarkdown(results: Results): string {
  const names = results.runtimes.map((r) => r.name);
  const lines = [
    `| Benchmark | ${names.join(" | ")} |`,
    `| --- | ${names.map(() => "---:").join(" | ")} |`,
  ];
  for (const bench of results.benchmarks) {
    const mokou = bench.results.mokou?.value;
    const cells = names.map((name) => {
      const result = bench.results[name];
      if (result?.value === undefined) return result?.error ? "error" : "–";
      let cell = format(result.value, bench.unit);
      if (name !== "mokou" && mokou !== undefined) {
        cell += ` (${speedup(mokou, result.value, bench.unit).toFixed(2)}×)`;
      }
      return cell;
    });
    lines.push(`| ${bench.name} (${bench.unit}) | ${cells.join(" | ")} |`);
  }
  lines.push(
    "",
    "Lower is better for ms, higher for req/s. (N×) is how many times faster " +
      "Mokou is than that runtime, so below 1 means Mokou is slower.",
    "",
    results.runtimes.map((r) => `- ${r.name}: ${r.version}`).join("\n"),
  );
  const errors = results.benchmarks.flatMap((bench) =>
    Object.entries(bench.results)
      .filter(([, r]) => r.error)
      .map(([name, r]) => `- ${bench.name} on ${name}: ${r.error}`)
  );
  if (errors.length) lines.push("", "Errors:", "", ...errors);
  return lines.join("\n") + "\n";
}

/** Returns the benchmarks where Mokou got slower than in `baseline`. */
function regressions(
  results: Results,
  baseline: Results,
  threshold: number,
): string[] {
  const found = [];
  for (const bench of results.benchmarks) {
    const now = bench.results.mokou?.value;
    const before = baseline.benchmarks.find((b) => b.name === bench.name)
      ?.results.mokou?.value;
    if (now === undefined || before === undefined) continue;
    const ratio = speedup(now, before, bench.unit);
    if (ratio < 1 / (1 + threshold)) {
      found.push(
        `${bench.name}: ${format(before, bench.unit)} -> ${
          format(now, bench.unit)
        } ${bench.unit} (${((1 / ratio - 1) * 100).toFixed(1)}% slower)`,
      );
    }
  }
  return found;
}

async function gitCommit() {
  try {
    const result = await output("git", ["rev-parse", "HEAD"]);
    return result.success ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseOptions(Deno.args);
  const runtimes = await findRuntimes(options);
  if (!runtimes.some((r) => r.name === "mokou")) {
    console.error(
      "Mokou not found. Build it with `cargo build --release` or pass --mokou.",
    );
    Deno.exit(1);
  }
  const benchmarks = BENCHMARKS.filter((b) =>
    !options.only || options.only.has(b.name)
  );

  const context: Context = { options };
  // Every runtime fetches from the same server: Mokou's.
  let fetchServer: Server | undefined;
  if (benchmarks.includes(fetchBenchmark)) {
    fetchServer = await startServer(runtimes[0]);
    context.fetchUrl = fetchServer.url;
  }

  const results: Results = {
    date: new Date().toISOString(),
    commit: await gitCommit(),
    os: Deno.build.os,
    arch: Deno.build.arch,
    cpus: navigator.hardwareConcurrency,
    runtimes: runtimes.map(({ name, version }) => ({ name, version })),
    benchmarks: [],
  };
  try {
    for (const bench of benchmarks) {
      const entry = {
        name: bench.name,
        unit: bench.unit,
        description: bench.description,
        results: {} as Record<string, Measurement>,
      };
      for (const runtime of runtimes) {
        console.error(`${bench.name} on ${runtime.name}...`);
        entry.results[runtime.name] = await bench.measure(runtime, context);
      }
      results.benchmarks.push(entry);
    }
  } finally {
    await fetchServer?.stop();
  }

  let markdown = toMarkdown(results);
  const mokou = runtimes.find((r) => r.name === "mokou")!;
  if (mokou.version.includes("debug")) {
    markdown =
      "> **Warning:** Mokou is a debug build, so its numbers are not " +
      "representative. Build it with `cargo build --release`.\n\n" + markdown;
  }

  let found: string[] = [];
  if (options.baseline) {
    const baseline: Results = JSON.parse(
      await Deno.readTextFile(options.baseline),
    );
    found = regressions(results, baseline, options.threshold);
    const against = `the baseline${
      baseline.commit ? ` (${baseline.commit.slice(0, 12)})` : ""
    }`;
    const percent = `${Math.round(options.threshold * 100)}%`;
    markdown += found.length
      ? `\nMokou is more than ${percent} slower than ${against}:\n\n` +
        found.map((line) => `- ${line}`).join("\n") + "\n"
      : `\nNo benchmark is more than ${percent} slower than ${against}.\n`;
  }

  console.log(markdown);
  if (options.markdown) await Deno.writeTextFile(options.markdown, markdown);
  if (options.json) {
    await Deno.writeTextFile(
      options.json,
      JSON.stringify(results, null, 2) + "\n",
    );
  }
  if (found.length) Deno.exit(1);
}

await main();
