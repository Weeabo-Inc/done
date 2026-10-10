// Copyright 2018-2026 the Deno authors. MIT license.
// deno-lint-ignore-file no-console

// `serve.mjs <port>`: a "Hello, world!" HTTP server using each runtime's own
// server (`Deno.serve`, `Bun.serve`, `node:http`). It prints "listening" once
// it accepts connections, and `run.ts` then points `wrk` at it.
import { args, runtime } from "./_util.mjs";

const port = Number(args[0] ?? 4600);
const hostname = "127.0.0.1";
const body = "Hello, world!";

if (runtime === "mokou" || runtime === "deno") {
  Deno.serve({
    port,
    hostname,
    onListen: () => console.log("listening"),
  }, () => new Response(body));
} else if (runtime === "bun") {
  Bun.serve({ port, hostname, fetch: () => new Response(body) });
  console.log("listening");
} else {
  const http = await import("node:http");
  http.createServer((_req, res) => res.end(body)).listen(
    port,
    hostname,
    () => console.log("listening"),
  );
}
