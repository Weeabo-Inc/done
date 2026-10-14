// Copyright 2018-2026 the Deno authors. MIT license.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./test_util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- a scripted MySQL server ------------------------------------------------------

function lenenc(n: number): number[] {
  if (n < 251) return [n];
  return [0xfc, n & 0xff, n >> 8];
}
function lenencStr(text: string | Uint8Array): number[] {
  const bytes = typeof text === "string" ? encoder.encode(text) : text;
  return [...lenenc(bytes.length), ...bytes];
}
function int16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function int32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function packet(seq: number, payload: number[] | Uint8Array): Uint8Array {
  const body = payload instanceof Uint8Array
    ? payload
    : new Uint8Array(payload);
  const out = new Uint8Array(4 + body.length);
  out[0] = body.length & 0xff;
  out[1] = (body.length >> 8) & 0xff;
  out[2] = (body.length >> 16) & 0xff;
  out[3] = seq;
  out.set(body, 4);
  return out;
}

const SCRAMBLE = new Uint8Array([
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
]);

function handshake(plugin = "mysql_native_password"): number[] {
  return [
    10,
    ...encoder.encode("5.7.0-mock"),
    0,
    ...int32(99),
    ...SCRAMBLE.subarray(0, 8),
    0,
    ...int16(0xf7ff), // capabilities (low), without SSL
    45,
    ...int16(2),
    ...int16(0x00ff), // capabilities (high)
    21,
    ...new Array(10).fill(0),
    ...SCRAMBLE.subarray(8),
    0,
    ...encoder.encode(plugin),
    0,
  ];
}

const ok = (seq: number, affected = 0, insertId = 0, status = 2) =>
  packet(seq, [
    0,
    ...lenenc(affected),
    ...lenenc(insertId),
    ...int16(status),
    0,
    0,
  ]);
const eof = (seq: number, status = 2) =>
  packet(seq, [0xfe, 0, 0, ...int16(status)]);
const err = (seq: number, errno: number, state: string, message: string) =>
  packet(seq, [
    0xff,
    ...int16(errno),
    35,
    ...encoder.encode(state),
    ...encoder.encode(message),
  ]);

function columnDef(
  seq: number,
  name: string,
  type: number,
  { charset = 45, flags = 0 } = {},
): Uint8Array {
  return packet(seq, [
    ...lenencStr("def"),
    ...lenencStr("db"),
    ...lenencStr("t"),
    ...lenencStr("t"),
    ...lenencStr(name),
    ...lenencStr(name),
    0x0c,
    ...int16(charset),
    ...int32(255),
    type,
    ...int16(flags),
    0,
    0,
    0,
  ]);
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>),
  );
}

interface Command {
  type: number;
  payload: Uint8Array;
}

/** Serves one connection: sends a handshake, hands the login to `onLogin`,
 * then each command to `onCommand`, which returns the packets to answer with
 * (sequence numbers start at 1). */
function mockServer(options: {
  plugin?: string;
  onLogin: (payload: Uint8Array) => Promise<Uint8Array[]> | Uint8Array[];
  /** Packets the client sends in answer to the login reply, before commands. */
  authPackets?: number;
  onAuth?: (payload: Uint8Array) => Uint8Array[];
  onCommand: (command: Command) => Uint8Array[] | null;
}) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const commands: Command[] = [];
  const logins: Uint8Array[] = [];
  const done = (async () => {
    for await (const conn of listener) {
      (async () => {
        let buf = new Uint8Array();
        const chunk = new Uint8Array(65536);
        async function fill(n: number) {
          while (buf.length < n) {
            const read = await conn.read(chunk);
            if (read === null) throw new Error("eof");
            buf = new Uint8Array([...buf, ...chunk.subarray(0, read)]);
          }
        }
        async function readPacket() {
          await fill(4);
          const length = buf[0] | (buf[1] << 8) | (buf[2] << 16);
          await fill(4 + length);
          const payload = buf.slice(4, 4 + length);
          buf = buf.slice(4 + length);
          return payload;
        }
        try {
          await conn.write(packet(0, handshake(options.plugin)));
          const login = await readPacket();
          logins.push(login);
          for (const reply of await options.onLogin(login)) {
            await conn.write(reply);
          }
          for (let i = 0; i < (options.authPackets ?? 0); i++) {
            for (const reply of options.onAuth!(await readPacket())) {
              await conn.write(reply);
            }
          }
          while (true) {
            const payload = await readPacket();
            const command = { type: payload[0], payload: payload.slice(1) };
            commands.push(command);
            if (command.type === 1) break; // COM_QUIT
            const replies = options.onCommand(command);
            if (replies === null) break;
            for (const reply of replies) await conn.write(reply);
          }
        } catch {
          // The client went away.
        } finally {
          try {
            conn.close();
          } catch {
            // Already closed.
          }
        }
      })();
    }
  })();
  return {
    port: (listener.addr as Deno.NetAddr).port,
    commands,
    logins,
    async close() {
      listener.close();
      await done;
    },
  };
}

const net = { permissions: { net: true } };
const noTls = { ssl: false } as const;

/** `COM_QUERY` replies for the `SET time_zone` the client sends after login. */
function defaultCommand(command: Command): Uint8Array[] {
  void command;
  return [ok(1)];
}

Deno.test(net, async function mysqlNativePasswordLogin() {
  const server = mockServer({
    onLogin: () => [ok(2)],
    onCommand: defaultCommand,
  });
  try {
    const db = await Deno.mysql.connect({
      port: server.port,
      username: "app",
      password: "apppass",
      database: "testdb",
      ...noTls,
    });
    db.close();
    const login = server.logins[0];
    const view = new DataView(login.buffer, login.byteOffset);
    const caps = view.getUint32(0, true);
    assert(caps & 0x200, "protocol 4.1");
    assert(caps & 0x8, "connect with db");
    assert(caps & 0x80000, "plugin auth");
    assertEquals(view.getUint32(4, true), 0xffffff);
    assertEquals(login[8], 45); // utf8mb4
    const text = decoder.decode(login.subarray(32));
    assert(text.startsWith("app\0"), text);
    // 20-byte proof: SHA1(pw) XOR SHA1(scramble + SHA1(SHA1(pw))).
    const hash = await sha1(encoder.encode("apppass"));
    const mixed = await sha1(
      new Uint8Array([...SCRAMBLE, ...(await sha1(hash))]),
    );
    const expected = hash.map((b, i) => b ^ mixed[i]);
    const proofAt = 32 + "app\0".length;
    assertEquals(login[proofAt], 20);
    assertEquals(login.slice(proofAt + 1, proofAt + 21), expected);
    assertEquals(
      decoder.decode(login.subarray(proofAt + 21)),
      "testdb\0mysql_native_password\0",
    );
    // The session time zone is pinned to UTC.
    assertEquals(server.commands[0].type, 3);
    assertEquals(
      decoder.decode(server.commands[0].payload),
      "SET time_zone = '+00:00'",
    );
  } finally {
    await server.close();
  }
});

Deno.test(net, async function mysqlLoginWithoutPasswordOrDatabase() {
  const server = mockServer({
    onLogin: () => [ok(2)],
    onCommand: defaultCommand,
  });
  try {
    (await Deno.mysql.connect({ port: server.port, username: "u", ...noTls }))
      .close();
    const login = server.logins[0];
    const caps = new DataView(login.buffer, login.byteOffset).getUint32(
      0,
      true,
    );
    assertEquals(caps & 0x8, 0);
    // An empty password is sent as an empty (zero-length) proof.
    assertEquals(
      [...login.subarray(32)],
      [
        ...encoder.encode("u\0"),
        0,
        ...encoder.encode("mysql_native_password\0"),
      ],
    );
  } finally {
    await server.close();
  }
});

Deno.test(net, async function mysqlLoginFailureAndAuthSwitch() {
  const rejecting = mockServer({
    onLogin:
      () => [err(2, 1045, "28000", "Access denied for user 'u'@'localhost'")],
    onCommand: defaultCommand,
  });
  try {
    const error = await assertRejects(
      () =>
        Deno.mysql.connect({
          port: rejecting.port,
          username: "u",
          password: "x",
          ...noTls,
        }),
      Deno.MysqlError,
      "Access denied",
    );
    assertEquals(error.errno, 1045);
    assertEquals(error.sqlState, "28000");
    assertEquals(error.name, "MysqlError");
  } finally {
    await rejecting.close();
  }

  // The server asks for another plugin, with a new scramble.
  const newScramble = new Uint8Array(20).map((_, k) => 100 + k);
  const hash = await sha1(encoder.encode("x"));
  const mixed = await sha1(
    new Uint8Array([...newScramble, ...(await sha1(hash))]),
  );
  const expected = hash.map((b, k) => b ^ mixed[k]);
  let switched: Uint8Array | undefined;
  const switching = mockServer({
    plugin: "caching_sha2_password",
    onLogin: () => [
      packet(2, [
        0xfe,
        ...encoder.encode("mysql_native_password"),
        0,
        ...newScramble,
        0,
      ]),
    ],
    authPackets: 1,
    onAuth: (payload) => {
      switched = payload;
      return [ok(4)];
    },
    onCommand: defaultCommand,
  });
  try {
    (await Deno.mysql.connect({
      port: switching.port,
      username: "u",
      password: "x",
      ...noTls,
    })).close();
    assertEquals(switched, expected);
  } finally {
    await switching.close();
  }
});

Deno.test(net, async function mysqlUnsupportedPluginIsReported() {
  const server = mockServer({
    plugin: "sha256_password",
    onLogin: () => [],
    onCommand: defaultCommand,
  });
  try {
    await assertRejects(
      () =>
        Deno.mysql.connect({
          port: server.port,
          username: "u",
          password: "x",
          ...noTls,
        }),
      Error,
      "Unsupported MySQL authentication plugin: sha256_password",
    );
  } finally {
    await server.close();
  }
});

Deno.test(net, async function mysqlPreparedStatementsAndBinaryRows() {
  const server = mockServer({
    onLogin: () => [ok(2)],
    onCommand(command) {
      switch (command.type) {
        case 3:
          return defaultCommand(command);
        case 0x16: // COM_STMT_PREPARE
          return [
            packet(1, [
              0,
              ...int32(7),
              ...int16(2),
              ...int16(3),
              0,
              ...int16(0),
            ]),
            columnDef(2, "?", 253),
            columnDef(3, "?", 253),
            columnDef(4, "?", 253),
            eof(5),
            columnDef(6, "id", 3),
            columnDef(7, "name", 253),
            eof(8),
          ];
        case 0x17: { // COM_STMT_EXECUTE
          // A binary row: 0x00, the null bitmap (offset 2, so bit 4 is the third
          // column), an unsigned LONG and a VAR_STRING.
          const row = [
            0,
            0b00010000,
            ...int32(0xfffffffe),
            ...lenencStr("héllo"),
          ];
          return [
            packet(1, [3]),
            columnDef(2, "id", 3, { flags: 0x20 }),
            columnDef(3, "name", 253),
            columnDef(4, "gone", 253),
            eof(5),
            packet(6, row),
            eof(7),
          ];
        }
      }
      return [ok(1)];
    },
  });
  const db = await Deno.mysql.connect({
    port: server.port,
    username: "u",
    ...noTls,
  });
  try {
    const result = await db.query(
      "SELECT id, name FROM t WHERE a = ? AND b = ? AND c = ?",
      [
        "x",
        42,
        null,
      ],
    );
    assertEquals(result.fields, [
      { name: "id", type: 3 },
      { name: "name", type: 253 },
      { name: "gone", type: 253 },
    ]);
    assertEquals(result.rows, [{ id: 4294967294, name: "héllo", gone: null }]);

    // The close arrives a moment after the result does.
    for (let i = 0; i < 100 && server.commands.length < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const types = server.commands.map((c) => c.type);
    assertEquals(types, [3, 0x16, 0x17, 0x19]);
    assertEquals(
      decoder.decode(server.commands[1].payload),
      "SELECT id, name FROM t WHERE a = ? AND b = ? AND c = ?",
    );
    const execute = server.commands[2].payload;
    const view = new DataView(execute.buffer, execute.byteOffset);
    assertEquals(view.getUint32(0, true), 7); // statement id
    assertEquals(execute[4], 0); // no cursor
    assertEquals(view.getUint32(5, true), 1); // iterations
    assertEquals(execute[9], 0b100); // null bitmap: third parameter
    assertEquals(execute[10], 1); // types follow
    assertEquals([...execute.subarray(11, 17)], [253, 0, 8, 0, 6, 0]); // VAR_STRING, LONGLONG, NULL
    // The values: "x" as length-encoded text, then 42 as an int64.
    assertEquals([...execute.subarray(17, 19)], [1, 120]);
    assertEquals(view.getBigInt64(19, true), 42n);
    // The statement is closed after use.
    assertEquals(server.commands[3].payload.length, 4);

    await assertRejects(
      () => db.query("SELECT ?", []),
      TypeError,
      "3 parameters",
    );
    await assertRejects(
      () => db.query("SELECT 1", "x" as unknown as unknown[]),
      TypeError,
    );
  } finally {
    db.close();
    await server.close();
  }
});

Deno.test(net, async function mysqlServerErrorsAndConnectionLoss() {
  let n = 0;
  const server = mockServer({
    onLogin: () => [ok(2)],
    onCommand(command) {
      if (command.type === 3) return defaultCommand(command);
      if (command.type === 0x16) {
        n++;
        return n === 1
          ? [err(1, 1146, "42S02", "Table 'db.nope' doesn't exist")]
          : null; // hang up
      }
      return [];
    },
  });
  const db = await Deno.mysql.connect({
    port: server.port,
    username: "u",
    ...noTls,
  });
  try {
    const error = await assertRejects(
      () => db.query("SELECT * FROM nope"),
      Deno.MysqlError,
      "doesn't exist",
    );
    assertEquals(error.errno, 1146);
    assertEquals(error.sqlState, "42S02");
    await assertRejects(() => db.query("SELECT 1"), Error, "closed");
    await db.closed;
    await assertRejects(() => db.query("SELECT 1"), Error, "closed");
  } finally {
    db.close();
    await server.close();
  }
});

Deno.test(net, async function mysqlConnectionStringsAndOptions() {
  const server = mockServer({
    onLogin: () => [ok(2)],
    onCommand: defaultCommand,
  });
  try {
    (await Deno.mysql.connect(
      `mysql://me%40corp:p%2Fw@127.0.0.1:${server.port}/my%20db?ssl=disable`,
    )).close();
    const text = decoder.decode(server.logins[0].subarray(32));
    assert(text.startsWith("me@corp\0"), text);
    assert(text.includes("my db\0"), text);

    await assertRejects(
      () => Deno.mysql.connect("postgres://localhost"),
      TypeError,
      "Unsupported protocol",
    );
    await assertRejects(
      () => Deno.mysql.connect({ port: server.port }),
      TypeError,
      "username",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => Deno.mysql.connect({ username: "u", ssl: "maybe" as any }),
      TypeError,
      "ssl",
    );
    await assertRejects(
      () => Deno.mysql.connect(5 as unknown as string),
      TypeError,
    );
  } finally {
    await server.close();
  }
});

Deno.test(function mysqlClientHasNoPublicConstructor() {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => new (Deno.MysqlClient as any)(),
    TypeError,
    "Illegal constructor",
  );
});

// --- a real server ----------------------------------------------------------------
//
// Set MOKOU_TEST_MYSQL to a URL for a user that may create databases, such as
// mysql://root:secret@127.0.0.1:3306, to run these against MySQL or MariaDB.
// They work in a database of their own and drop it afterwards.

let realUrl: string | undefined;
try {
  realUrl = Deno.env.get("MOKOU_TEST_MYSQL");
} catch {
  // No env permission: skip the real-server tests.
}

Deno.test(
  { ignore: !realUrl, permissions: { net: true, env: true } },
  async function mysqlAgainstARealServer(t) {
    const admin = await Deno.mysql.connect(realUrl!);
    await admin.exec(
      "DROP DATABASE IF EXISTS mokou_test; CREATE DATABASE mokou_test",
    );
    admin.close();
    const url = new URL(realUrl!);
    url.pathname = "/mokou_test";
    const db = await Deno.mysql.connect(url);
    try {
      await t.step("types", async () => {
        await db.exec(`CREATE TABLE types (
          i8 tinyint, u8 tinyint unsigned, i16 smallint, i24 mediumint, i32 int, u32 int unsigned,
          i64 bigint, u64 bigint unsigned, f float, d double, dec_ decimal(30,10),
          t text, v varchar(20), b blob, vb varbinary(10), j json,
          dt datetime(6), ts timestamp, dte date, tm time, yr year, e enum('a','b'), bit_ bit(8))`);
        await db.query(
          `INSERT INTO types VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            -8,
            200,
            -300,
            -70000,
            -2147483648,
            4294967295,
            -9223372036854775807n,
            18446744073709551615n,
            1.5,
            0.1,
            "12345678901234567890.1234567890",
            "héllo \u{1F995}",
            "varchar",
            new Uint8Array([0, 255, 1]),
            new Uint8Array([9, 8]),
            { a: [1, null] },
            new Date("2026-10-14T12:34:56.789Z"),
            new Date("2026-01-02T03:04:05Z"),
            new Date("2026-10-14T00:00:00Z"),
            "-12:34:56",
            2026,
            "b",
            5,
          ],
        );
        const [row] = (await db.query("SELECT * FROM types")).rows;
        assertEquals(row.i8, -8);
        assertEquals(row.u8, 200);
        assertEquals(row.i16, -300);
        assertEquals(row.i24, -70000);
        assertEquals(row.i32, -2147483648);
        assertEquals(row.u32, 4294967295);
        assertEquals(row.i64, -9223372036854775807n);
        assertEquals(row.u64, 18446744073709551615n);
        assertEquals(row.f, 1.5);
        assertEquals(row.d, 0.1);
        assertEquals(row.dec_, "12345678901234567890.1234567890");
        assertEquals(row.t, "héllo \u{1F995}");
        assertEquals(row.v, "varchar");
        assertEquals(row.b, new Uint8Array([0, 255, 1]));
        assertEquals(row.vb, new Uint8Array([9, 8]));
        assertEquals(
          typeof row.j === "string" ? JSON.parse(row.j as string) : row.j,
          { a: [1, null] },
        );
        assertEquals(row.dt, new Date("2026-10-14T12:34:56.789Z"));
        assertEquals(row.ts, new Date("2026-01-02T03:04:05Z"));
        assertEquals(row.dte, new Date("2026-10-14T00:00:00Z"));
        assertEquals(row.tm, "-12:34:56");
        assertEquals(row.yr, 2026);
        assertEquals(row.e, "b");
        assertEquals(row.bit_, new Uint8Array([5]));

        // The text protocol agrees.
        const [text] =
          (await db.exec("SELECT i8, u64, dec_, dt, tm, v, b FROM types"))[0]
            .rows;
        assertEquals(text.i8, -8);
        assertEquals(text.u64, 18446744073709551615n);
        assertEquals(text.dec_, "12345678901234567890.1234567890");
        assertEquals(text.dt, new Date("2026-10-14T12:34:56.789Z"));
        assertEquals(text.tm, "-12:34:56");
        assertEquals(text.v, "varchar");
        assertEquals(text.b, new Uint8Array([0, 255, 1]));

        const nulls = await db.sql`SELECT NULL AS n, ${null} AS p, 1 AS one`;
        assertEquals(nulls, [{ n: null, p: null, one: 1 }]);
      });

      await t.step("parameters, results and injection", async () => {
        await db.exec(
          "CREATE TABLE people (id int auto_increment primary key, name varchar(100), age int)",
        );
        const hostile = "o'brien'); DROP TABLE people; --";
        const insert = await db.query(
          "INSERT INTO people (name, age) VALUES (?, ?)",
          [hostile, 41],
        );
        assertEquals(insert.affectedRows, 1);
        assertEquals(insert.insertId, 1);
        assertEquals(insert.rows, []);
        await db
          .sql`INSERT INTO people (name, age) VALUES (${"Ada"}, ${36}), (${"Grace"}, ${null})`;
        const rows = await db.sql<
          { id: number; name: string; age: number | null }
        >`
          SELECT id, name, age FROM people WHERE age > ${30} OR age IS NULL ORDER BY id`;
        assertEquals(rows.map((r) => r.name), [hostile, "Ada", "Grace"]);
        assertEquals(rows[2].age, null);
        assertEquals(
          (await db.query(
            "UPDATE people SET age = age + 1 WHERE age IS NOT NULL",
          )).affectedRows,
          2,
        );
        assertEquals(
          (await db.query("DELETE FROM people WHERE name = ?", ["Grace"]))
            .affectedRows,
          1,
        );
        assertEquals((await db.sql`SELECT COUNT(*) AS n FROM people`)[0].n, 2);
        assertEquals((await db.query("SELECT 1 AS x, 2 AS x")).rows[0], {
          x: 2,
        });
      });

      await t.step("errors", async () => {
        const missing = await assertRejects(
          () => db.query("SELECT * FROM nope"),
          Deno.MysqlError,
        );
        assertEquals(missing.errno, 1146);
        assertEquals(missing.sqlState, "42S02");
        await db.exec("CREATE UNIQUE INDEX people_name ON people (name)");
        const dup = await assertRejects(
          () => db.query("INSERT INTO people (name) VALUES (?)", ["Ada"]),
          Deno.MysqlError,
          "Duplicate entry",
        );
        assertEquals(dup.errno, 1062);
        await assertRejects(() => db.exec("SELEC 1"), Deno.MysqlError);
        assertEquals((await db.sql`SELECT 1 AS one`)[0].one, 1);
      });

      await t.step("scripts return one result per statement", async () => {
        const results = await db.exec(
          "SELECT 1 AS a; UPDATE people SET age = 1; SELECT 2 AS b, 3 AS c",
        );
        assertEquals(results.map((r) => r.rows), [[{ a: 1 }], [], [{
          b: 2,
          c: 3,
        }]]);
        assertEquals(results[1].affectedRows, 2);
      });

      await t.step("transactions", async () => {
        await db.exec("CREATE TABLE acct (n varchar(10) primary key, bal int)");
        await db.transaction(async (tx) => {
          await tx.query("INSERT INTO acct VALUES ('a', 100), ('b', 0)");
          await tx.sql`UPDATE acct SET bal = bal - ${30} WHERE n = 'a'`;
          await tx.sql`UPDATE acct SET bal = bal + ${30} WHERE n = 'b'`;
        });
        assertEquals(
          (await db.query("SELECT n, bal FROM acct ORDER BY n")).rows,
          [
            { n: "a", bal: 70 },
            { n: "b", bal: 30 },
          ],
        );
        await assertRejects(
          () =>
            db.transaction(async (tx) => {
              await tx.query("UPDATE acct SET bal = 0");
              throw new Error("changed my mind");
            }),
          Error,
          "changed my mind",
        );
        assertEquals(
          (await db.sql`SELECT bal FROM acct WHERE n = 'a'`)[0].bal,
          70,
        );
      });

      await t.step("concurrent calls run in order", async () => {
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) => db.sql`SELECT ${i} + 0 AS n`),
        );
        assertEquals(
          results.map((r) => r[0].n),
          Array.from({ length: 50 }, (_, i) => i),
        );
      });

      await t.step("large values", async () => {
        await db.exec("CREATE TABLE big (b longblob)");
        // Values over 16 MB are split across packets, and the server's limit
        // is 16 MB by default, so raise it for connections made from now on.
        const admin = await Deno.mysql.connect(realUrl!);
        await admin.exec("SET GLOBAL max_allowed_packet = 67108864");
        admin.close();
        const wide = await Deno.mysql.connect(url);
        try {
          const size = 20 * 1024 * 1024;
          const data = new Uint8Array(size).map((_, i) => i % 251);
          await wide.query("INSERT INTO big VALUES (?)", [data]);
          const [row] = (await wide.query("SELECT b FROM big")).rows;
          assertEquals((row.b as Uint8Array).length, size);
          assertEquals((row.b as Uint8Array)[size - 1], (size - 1) % 251);
        } finally {
          wide.close();
        }
      });
    } finally {
      db.close();
      const cleanup = await Deno.mysql.connect(realUrl!);
      await cleanup.exec("DROP DATABASE IF EXISTS mokou_test");
      cleanup.close();
    }
  },
);

Deno.test(
  { ignore: !realUrl, permissions: { net: true, env: true } },
  async function mysqlWrongPasswordIsRefused() {
    const url = new URL(realUrl!);
    url.password = "definitely-wrong";
    // MySQL 8 users with caching_sha2_password can't prove a password over a
    // plain connection until the server has cached it, which is reported as
    // an error of its own.
    const error = await assertRejects(() => Deno.mysql.connect(url), Error);
    if (error instanceof Deno.MysqlError) assertEquals(error.errno, 1045);
    else assert(error.message.includes("needs TLS"), error.message);
  },
);
