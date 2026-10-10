// Copyright 2018-2026 the Deno authors. MIT license.

// `fs.mjs read` or `fs.mjs write`: a 1 MiB file, with each runtime's own
// file API (`Deno.readFile`, `Bun.file`, `node:fs/promises`).
import { args, bench, report, runtime } from "./_util.mjs";

const SIZE = 1 << 20;
const bytes = new Uint8Array(SIZE).map((_, i) => i % 251);
const mode = args[0] ?? "read";

let dir, path, read, write, cleanup;
if (runtime === "mokou" || runtime === "deno") {
  dir = Deno.makeTempDirSync();
  path = `${dir}/data.bin`;
  read = () => Deno.readFile(path);
  write = () => Deno.writeFile(path, bytes);
  cleanup = () => Deno.removeSync(dir, { recursive: true });
} else {
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  dir = fs.mkdtempSync(`${os.tmpdir()}/bench-`);
  path = `${dir}/data.bin`;
  if (runtime === "bun") {
    read = () => Bun.file(path).bytes();
    write = () => Bun.write(path, bytes);
  } else {
    read = () => fsp.readFile(path);
    write = () => fsp.writeFile(path, bytes);
  }
  cleanup = () => fs.rmSync(dir, { recursive: true });
}

await write();
try {
  const result = await bench(mode === "write" ? write : read, {
    iterations: 20,
    samples: 15,
  });
  report({ ...result, bytes: SIZE });
} finally {
  cleanup();
}
