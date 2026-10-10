// Copyright 2018-2026 the Deno authors. MIT license.

// Inserts 10,000 rows into an in-memory SQLite database in one transaction
// with a prepared statement, then reads them all back. Mokou uses
// `Deno.openSqlite()`, Bun `bun:sqlite`, and Deno and Node `node:sqlite`.
import { bench, report, runtime } from "./_util.mjs";

const ROWS = 10_000;

let open;
if (runtime === "mokou") {
  open = () => Deno.openSqlite(":memory:");
} else if (runtime === "bun") {
  const { Database } = await import("bun:sqlite");
  open = () => new Database(":memory:");
} else {
  const { DatabaseSync } = await import("node:sqlite");
  open = () => new DatabaseSync(":memory:");
}

function run() {
  const db = open();
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score REAL)");
  const insert = db.prepare("INSERT INTO users (name, score) VALUES (?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < ROWS; i++) insert.run(`user-${i}`, i * 1.5);
  db.exec("COMMIT");
  const rows = db.prepare("SELECT id, name, score FROM users").all();
  if (rows.length !== ROWS) throw new Error(`Expected ${ROWS} rows`);
  db.close();
}

report({ ...(await bench(run, { samples: 10 })), rows: ROWS });
