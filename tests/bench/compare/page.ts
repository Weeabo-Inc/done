#!/usr/bin/env -S deno run --allow-read --allow-write
// Copyright 2018-2026 the Deno authors. MIT license.
// deno-lint-ignore-file no-console

// Builds the public benchmark page from the results of `run.ts --json`, one
// file per release.
//
//   deno run -A tests/bench/compare/page.ts site/benchmarks/results \
//     site/benchmarks/index.html
//
// The page shows the newest run against Deno, Node and Bun, and how Mokou's own
// numbers moved from release to release. It is one self-contained HTML file.

interface Measurement {
  value?: number;
  min?: number;
  max?: number;
  error?: string;
}

interface Results {
  date: string;
  label?: string;
  notes?: string[];
  commit?: string;
  machine?: { cpu?: string; memoryGb?: number };
  os: string;
  arch: string;
  cpus: number;
  runtimes: { name: string; version: string; size?: number }[];
  benchmarks: {
    name: string;
    unit: "ms" | "req/s";
    description: string;
    results: Record<string, Measurement>;
  }[];
}

const [dir, out] = Deno.args;
if (!dir || !out) {
  console.error("Usage: page.ts <results dir> <out.html>");
  Deno.exit(2);
}

const runs: Results[] = [];
for (const entry of Deno.readDirSync(dir)) {
  if (!entry.isFile || !entry.name.endsWith(".json")) continue;
  runs.push(JSON.parse(Deno.readTextFileSync(`${dir}/${entry.name}`)));
}
runs.sort((a, b) => a.date.localeCompare(b.date));
if (runs.length === 0) {
  console.error(`No results in ${dir}`);
  Deno.exit(1);
}
const latest = runs.at(-1)!;

const esc = (text: unknown) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function format(value: number, unit: string) {
  if (unit === "req/s") return Math.round(value).toLocaleString("en-US");
  return value >= 100 ? value.toFixed(0) : value.toPrecision(3);
}

/** How many times faster `a` is than `b` (above 1), whichever the unit. */
function times(a: number, b: number, unit: string) {
  return unit === "req/s" ? a / b : b / a;
}

const NAMES: Record<string, string> = {
  mokou: "Mokou",
  deno: "Deno",
  node: "Node.js",
  bun: "Bun",
};
const COLORS: Record<string, string> = {
  mokou: "#f0651a",
  deno: "#4d7da8",
  node: "#6a9a52",
  bun: "#8a7a6a",
};

/** One horizontal bar per runtime, to a common scale. */
function bars(bench: Results["benchmarks"][number]) {
  const entries = Object.entries(bench.results).filter(
    ([, r]) => r.value !== undefined,
  );
  if (entries.length === 0) return "";
  const max = Math.max(...entries.map(([, r]) => r.value!));
  const mokou = bench.results.mokou?.value;
  const rows = entries.map(([name, r], i) => {
    const width = Math.max(1, (r.value! / max) * 100);
    const ratio = name !== "mokou" && mokou !== undefined
      ? times(mokou, r.value!, bench.unit)
      : undefined;
    return `<g transform="translate(0 ${i * 26})">
      <text x="0" y="16" class="lbl">${esc(NAMES[name] ?? name)}</text>
      <rect x="70" y="3" width="${
      (width * 2.4).toFixed(1)
    }" height="18" rx="3" fill="${COLORS[name] ?? "#888"}"/>
      <text x="${(70 + width * 2.4 + 6).toFixed(1)}" y="16" class="val">${
      format(r.value!, bench.unit)
    }${
      ratio === undefined
        ? ""
        : ` <tspan class="ratio">${ratio.toFixed(2)}×</tspan>`
    }</text>
    </g>`;
  });
  return `<svg viewBox="0 0 420 ${
    entries.length * 26 + 2
  }" role="img" aria-label="${esc(bench.name)} by runtime">${
    rows.join("")
  }</svg>`;
}

/** Mokou's median over the releases that measured this benchmark. */
function trend(name: string, unit: string) {
  const points = runs
    .map((run) => ({
      label: run.label ?? run.commit?.slice(0, 7) ?? run.date.slice(0, 10),
      value: run.benchmarks.find((b) => b.name === name)?.results.mokou?.value,
    }))
    .filter((p): p is { label: string; value: number } =>
      p.value !== undefined
    );
  if (points.length === 0) return "";
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) =>
    points.length === 1 ? 110 : 10 + (i * 200) / (points.length - 1);
  const y = (v: number) => 8 + (1 - (v - lo) / span) * 34;
  const line = points.map((p, i) =>
    `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`
  ).join(" ");
  const dots = points.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${
      y(p.value).toFixed(1)
    }" r="3" fill="#f0651a"><title>${esc(p.label)}: ${
      format(p.value, unit)
    } ${unit}</title></circle>`
  ).join("");
  return `<svg viewBox="0 0 220 50" class="spark" role="img" aria-label="Mokou ${
    esc(name)
  } over releases"><polyline points="${line}" fill="none" stroke="#f0651a" stroke-width="2"/>${dots}</svg>`;
}

const when = (run: Results) => new Date(run.date).toISOString().slice(0, 10);
const nameOf = (run: Results) =>
  run.label ?? run.commit?.slice(0, 7) ?? when(run);

const cards = latest.benchmarks.map((bench) => `
  <section class="card">
    <h3>${esc(bench.name)} <small>${
  bench.unit === "ms" ? "ms, lower is better" : "requests/s, higher is better"
}</small></h3>
    <p>${esc(bench.description)}</p>
    ${bars(bench)}
    ${
  runs.length > 1
    ? `<div class="trend"><span>Mokou over releases</span>${
      trend(bench.name, bench.unit)
    }</div>`
    : ""
}
  </section>`).join("");

const releaseNames = runs.map(nameOf);
const history = latest.benchmarks.map((bench) => {
  const cells = runs.map((run) => {
    const value = run.benchmarks.find((b) => b.name === bench.name)?.results
      .mokou?.value;
    return `<td>${value === undefined ? "–" : format(value, bench.unit)}</td>`;
  }).join("");
  return `<tr><th>${
    esc(bench.name)
  } <small>${bench.unit}</small></th>${cells}</tr>`;
}).join("");

const sizes = latest.runtimes.map((r) =>
  `<li><b>${esc(NAMES[r.name] ?? r.name)}</b> ${esc(r.version)}${
    r.size === undefined ? "" : `, ${(r.size / 1e6).toFixed(1)} MB binary`
  }</li>`
).join("");

const machine = [
  latest.machine?.cpu,
  latest.machine?.memoryGb ? `${latest.machine.memoryGb} GB RAM` : undefined,
  `${latest.cpus} threads`,
  `${latest.os} ${latest.arch}`,
].filter(Boolean).join(", ");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Mokou benchmarks against Deno, Node.js and Bun, for every release.">
<title>Mokou Benchmarks</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inconsolata:wght@400;700&family=Open+Sans:wght@400;600;700&family=Yanone+Kaffeesatz:wght@400;600;700&display=swap">
<style>
:root { --sky:#cfdbe8; --paper:#fff; --ink:#2b3138; --soft:#5d6772; --link:#1b6db3; --flame:#f0651a; --flame-lo:#c9420e; --navy:#1d2630; --rule:#c3ced9;
  --display:"Yanone Kaffeesatz","Trebuchet MS",sans-serif; --body:"Open Sans","Lucida Grande",Verdana,sans-serif; --mono:"Inconsolata",Consolas,monospace; color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; padding:0 16px 32px; background:var(--sky) repeating-linear-gradient(45deg,rgba(255,255,255,.18) 0 2px,transparent 2px 6px); color:var(--ink); font:15px/1.6 var(--body); }
a { color:var(--link); } a:hover { color:var(--flame-lo); }
.wrap { max-width:960px; margin:0 auto; }
header { padding-block:22px 12px; display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 18px; }
header a.brand { font-family:var(--display); font-size:44px; font-weight:700; color:var(--navy); text-decoration:none; text-shadow:0 1px 0 #fff; }
header span { font-family:var(--display); font-size:22px; color:var(--soft); }
.panel { margin-top:18px; background:var(--paper); border:1px solid var(--rule); border-radius:10px; box-shadow:0 2px 6px rgba(30,50,70,.18); padding:24px 28px 28px; }
h1,h2,h3 { font-family:var(--display); color:var(--navy); line-height:1.1; margin:0; }
h1 { font-size:54px; text-shadow:0 1px 0 #fff; } h1 em { font-style:normal; color:var(--flame); }
h2 { font-size:34px; margin-bottom:12px; padding-bottom:6px; border-bottom:1px solid var(--rule); }
h3 { font-size:25px; } h3 small { font:400 12px var(--body); color:var(--soft); margin-left:6px; }
.lead { max-width:62ch; }
.meta { color:var(--soft); font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.card { min-width:0; border:1px solid var(--rule); border-radius:8px; padding:14px 16px 12px; background:linear-gradient(#fff,#f3f6fa); }
.card p { margin:2px 0 8px; font-size:13px; color:var(--soft); }
svg { max-width:100%; height:auto; display:block; }
.lbl { font:600 12px var(--body); fill:var(--ink); } .val { font:700 13px var(--mono); fill:var(--ink); } .ratio { fill:var(--flame-lo); font-weight:400; }
.trend { display:flex; align-items:center; gap:10px; margin-top:8px; font-size:12px; color:var(--soft); } .spark { width:220px; flex:none; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th,td { padding:5px 10px; border-bottom:1px dotted var(--rule); text-align:right; font-variant-numeric:tabular-nums; }
th:first-child { text-align:left; } thead th { font-family:var(--display); font-size:19px; color:var(--navy); }
th small { color:var(--soft); font-weight:400; }
ul.versions { margin:8px 0 0; padding-left:18px; font-size:13px; } code { font-family:var(--mono); font-size:14px; background:#eef2f6; padding:1px 5px; border-radius:3px; }
footer { margin-top:18px; font-size:12px; color:var(--soft); text-align:center; }
@media (max-width:700px) { .grid { grid-template-columns:minmax(0,1fr); } h1 { font-size:42px; } .panel { padding:18px 16px 22px; } .trend { flex-wrap:wrap; } }
</style>
</head>
<body>
<div class="wrap">
<header><a class="brand" href="../">Mokou</a><span>Benchmarks</span></header>
<section class="panel">
  <h1>How fast is <em>Mokou</em>?</h1>
  <p class="lead">Every release is measured against upstream Deno, Node.js and Bun on the same machine, with the same programs. The numbers below are for <b>${
  esc(nameOf(latest))
}</b>, run on ${when(latest)}${
  latest.commit
    ? ` at commit <code>${esc(latest.commit.slice(0, 12))}</code>`
    : ""
}.</p>
  <p class="meta">${esc(machine)}</p>
  ${
  (latest.notes ?? []).map((note) => `<p class="meta">${esc(note)}</p>`).join(
    "",
  )
}
  <ul class="versions">${sizes}</ul>
</section>
<section class="panel">
  <h2>Latest results</h2>
  <p class="meta">The number after a bar is how many times faster Mokou is than that runtime, so below 1× means Mokou is slower.</p>
  <div class="grid">${cards}</div>
</section>
<section class="panel">
  <h2>Release by release</h2>
  <p class="meta">Mokou's median for each benchmark. Releases are measured on the same kind of machine, but not the same one, so read small differences as noise.</p>
  <div class="scroll"><table><thead><tr><th></th>${
  releaseNames.map((n) => `<th>${esc(n)}</th>`).join("")
}</tr></thead><tbody>${history}</tbody></table></div>
</section>
<section class="panel">
  <h2>How it is measured</h2>
  <p>Each benchmark is a small program in <code>tests/bench/compare/cases</code> that runs unchanged on every runtime and uses the fastest idiomatic API each one has: <code>Deno.openSqlite()</code> on Mokou, <code>bun:sqlite</code> on Bun, <code>node:sqlite</code> on Deno and Node. Times are the median of repeated runs; the server benchmark is requests per second under <code>wrk -t2 -c64</code>. Runtimes are the latest stable releases at the time. To repeat a run:</p>
  <p><code>mokou run -A tests/bench/compare/run.ts --mokou ./target/release/deno --label v0.1.0 --json results.json</code></p>
  <p class="meta">Results for every release are kept in <a href="results/">results/</a> and this page is built from them by <code>tests/bench/compare/page.ts</code>.</p>
</section>
<footer>Mokou is MIT licensed. Benchmarks are only as good as the programs they run; send a better one.</footer>
</div>
</body>
</html>
`;

Deno.writeTextFileSync(out, html);
console.error(
  `Wrote ${out} from ${runs.length} run${runs.length === 1 ? "" : "s"}.`,
);
