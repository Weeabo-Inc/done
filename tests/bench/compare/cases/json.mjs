// Copyright 2018-2026 the Deno authors. MIT license.

// `json.mjs parse` or `json.mjs stringify`: about 1 MB of JSON.
import { args, bench, report } from "./_util.mjs";

const data = Array.from({ length: 5000 }, (_, i) => ({
  id: i,
  name: `user-${i}`,
  email: `user-${i}@example.com`,
  active: i % 3 !== 0,
  score: i * 1.5,
  tags: ["alpha", "beta", "gamma"].slice(0, (i % 3) + 1),
  address: { city: "Tokyo", zip: String(100000 + i), lines: ["1-2-3", "4"] },
}));
const text = JSON.stringify(data);

const mode = args[0] ?? "parse";
const fn = mode === "stringify"
  ? () => JSON.stringify(data)
  : () => JSON.parse(text);
report({
  ...(await bench(fn, { iterations: 5, samples: 15 })),
  bytes: text.length,
});
