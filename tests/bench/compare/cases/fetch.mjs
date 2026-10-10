// Copyright 2018-2026 the Deno authors. MIT license.

// `fetch.mjs <url>`: sequential `fetch()` calls to a local server, reading
// each body. `run.ts` starts the same server for every runtime.
import { args, bench, report } from "./_util.mjs";

const url = args[0];
if (!url) throw new Error("Usage: fetch.mjs <url>");

async function run() {
  const response = await fetch(url);
  await response.text();
}

report(await bench(run, { warmup: 50, iterations: 100, samples: 10 }));
