// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.openSqlite()`: a native SQLite API built directly on the Rust
// implementation in `ext/node_sqlite`, without loading `node:sqlite` or any of
// the Node compatibility layer.

(function () {
const { core, primordials } = __bootstrap;
const { DatabaseSync } = core.ops;
const {
  ObjectPrototypeIsPrototypeOf,
  ReflectApply,
  SafeMap,
  MapPrototypeGet,
  MapPrototypeSet,
  MapPrototypeClear,
  MapPrototypeGetSize,
  SymbolDispose,
  TypeError,
} = primordials;
const { pathFromURL } = core.loadExtScript("ext:deno_web/00_infra.js");
const { URLPrototype } = core.loadExtScript("ext:deno_web/00_url.js");

// Statements prepared by `query()`, `get()` and `run()` are cached per
// database, up to this many distinct SQL strings.
const STATEMENT_CACHE_SIZE = 64;

class SqliteDatabase {
  #db;
  #path;
  #statements = new SafeMap();

  constructor(path, options = { __proto__: null }) {
    if (ObjectPrototypeIsPrototypeOf(URLPrototype, path)) {
      path = pathFromURL(path);
    }
    if (typeof path !== "string") {
      throw new TypeError(
        'Deno.openSqlite() expects a path string, a file: URL or ":memory:"',
      );
    }
    this.#path = path;
    this.#db = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: options.foreignKeys ?? true,
      timeout: options.timeout ?? 0,
      readBigInts: options.readBigInts ?? false,
      allowExtension: options.allowExtension ?? false,
    });
  }

  /** The path the database was opened with. */
  get path() {
    return this.#path;
  }

  get isOpen() {
    return this.#db.isOpen;
  }

  get inTransaction() {
    return this.#db.isTransaction;
  }

  /** Runs one or more SQL statements that return no rows. */
  exec(sql) {
    this.#db.exec(sql);
  }

  /** Prepares a statement for repeated use. */
  prepare(sql) {
    return this.#db.prepare(sql);
  }

  #cached(sql) {
    let statement = MapPrototypeGet(this.#statements, sql);
    if (statement === undefined) {
      if (MapPrototypeGetSize(this.#statements) >= STATEMENT_CACHE_SIZE) {
        MapPrototypeClear(this.#statements);
      }
      statement = this.#db.prepare(sql);
      MapPrototypeSet(this.#statements, sql, statement);
    }
    return statement;
  }

  /** Runs a query and returns every row as an object. */
  query(sql, ...params) {
    const statement = this.#cached(sql);
    return ReflectApply(statement.all, statement, params);
  }

  /** Runs a query and returns the first row, or `undefined`. */
  get(sql, ...params) {
    const statement = this.#cached(sql);
    return ReflectApply(statement.get, statement, params);
  }

  /** Runs a statement and returns the number of changed rows and the last
   * inserted row id. */
  run(sql, ...params) {
    const statement = this.#cached(sql);
    return ReflectApply(statement.run, statement, params);
  }

  /** Runs `fn` inside a transaction. The transaction is committed when `fn`
   * returns and rolled back if it throws. Nested calls use savepoints. */
  transaction(fn) {
    const nested = this.#db.isTransaction;
    const savepoint = "done_tx";
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
    let result;
    try {
      result = fn(this);
    } catch (error) {
      this.#db.exec(
        nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK",
      );
      throw error;
    }
    if (
      result !== null && typeof result === "object" &&
      typeof result.then === "function"
    ) {
      this.#db.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      throw new TypeError(
        "Deno.SqliteDatabase.transaction() callbacks must be synchronous",
      );
    }
    this.#db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  }

  close() {
    MapPrototypeClear(this.#statements);
    this.#db.close();
  }

  [SymbolDispose]() {
    if (this.#db.isOpen) this.close();
  }
}

function openSqlite(path, options) {
  return new SqliteDatabase(path, options);
}

return { openSqlite, SqliteDatabase };
})();
