// Copyright 2018-2026 the Deno authors. MIT license.
import { toFileUrl } from "@std/path";
import { assert, assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function doneSqliteInMemory() {
  using db = Deno.openSqlite(":memory:");
  assert(db instanceof Deno.SqliteDatabase);
  assert(db.isOpen);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const result = db.run("INSERT INTO users (name) VALUES (?)", "Ada");
  assertEquals(result.changes, 1);
  assertEquals(result.lastInsertRowid, 1);
  db.run("INSERT INTO users (name) VALUES ($name)", { $name: "Grace" });
  assertEquals(db.query("SELECT name FROM users ORDER BY id"), [
    { name: "Ada" },
    { name: "Grace" },
  ]);
  assertEquals(db.get("SELECT name FROM users WHERE id = ?", 2), {
    name: "Grace",
  });
  assertEquals(db.get("SELECT name FROM users WHERE id = ?", 99), undefined);

  const stmt = db.prepare("SELECT count(*) AS n FROM users");
  assertEquals(stmt.get(), { n: 2 });
});

Deno.test(function doneSqliteTransaction() {
  using db = Deno.openSqlite(":memory:");
  db.exec("CREATE TABLE t (v INTEGER)");
  const n = db.transaction(() => {
    db.run("INSERT INTO t VALUES (1)");
    db.run("INSERT INTO t VALUES (2)");
    return 2;
  });
  assertEquals(n, 2);
  assertThrows(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (3)");
        throw new Error("rollback");
      }),
    Error,
    "rollback",
  );
  assertEquals(db.query("SELECT v FROM t ORDER BY v"), [{ v: 1 }, { v: 2 }]);
  assert(!db.inTransaction);

  // Nested transactions use savepoints.
  db.transaction(() => {
    db.run("INSERT INTO t VALUES (10)");
    assertThrows(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (11)");
        throw new Error("inner");
      })
    );
  });
  assertEquals(db.query("SELECT v FROM t WHERE v >= 10"), [{ v: 10 }]);
});

Deno.test(
  { permissions: { read: true, write: true } },
  function doneSqliteFile() {
    const dir = Deno.makeTempDirSync();
    const path = `${dir}/app.db`;
    {
      using db = Deno.openSqlite(path);
      db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
      db.run("INSERT INTO kv VALUES (?, ?)", "a", "1");
    }
    {
      using db = Deno.openSqlite(toFileUrl(path), { readOnly: true });
      assertEquals(db.query("SELECT * FROM kv"), [{ k: "a", v: "1" }]);
      assertThrows(() => db.run("INSERT INTO kv VALUES ('b', '2')"));
    }
    Deno.removeSync(dir, { recursive: true });
  },
);

Deno.test(function doneSqliteClose() {
  const db = Deno.openSqlite(":memory:");
  db.close();
  assert(!db.isOpen);
  assertThrows(() => db.exec("SELECT 1"));
});

Deno.test(
  { permissions: { read: false, write: false } },
  function doneSqliteRequiresPermission() {
    assertThrows(
      () => Deno.openSqlite("nope.db"),
      Deno.errors.NotCapable,
    );
  },
);
