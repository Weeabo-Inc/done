// Copyright 2018-2026 the Deno authors. MIT license.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./test_util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- a scripted PostgreSQL backend ------------------------------------------------

function message(type: string, body: Uint8Array | number[] = []): Uint8Array {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const out = new Uint8Array(5 + bytes.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + bytes.length);
  out.set(bytes, 5);
  return out;
}

function int32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return [...b];
}

function int16(n: number): number[] {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n);
  return [...b];
}

function cstr(text: string): number[] {
  return [...encoder.encode(text), 0];
}

const authOk = message("R", int32(0));
const ready = message("Z", [73]);
const parameterStatus = message("S", [
  ...cstr("server_version"),
  ...cstr("16.0"),
]);

function rowDescription(columns: [string, number][]): Uint8Array {
  const body = [...int16(columns.length)];
  for (const [name, oid] of columns) {
    body.push(
      ...cstr(name),
      ...int32(0),
      ...int16(0),
      ...int32(oid),
      ...int16(-1),
      ...int32(-1),
      ...int16(0),
    );
  }
  return message("T", body);
}

function dataRow(values: (string | null)[]): Uint8Array {
  const body = [...int16(values.length)];
  for (const value of values) {
    if (value === null) body.push(...int32(-1));
    else {
      const bytes = encoder.encode(value);
      body.push(...int32(bytes.length), ...bytes);
    }
  }
  return message("D", body);
}

function errorResponse(fields: Record<string, string>): Uint8Array {
  const body: number[] = [];
  for (const [code, value] of Object.entries(fields)) {
    body.push(code.charCodeAt(0), ...cstr(value));
  }
  body.push(0);
  return message("E", body);
}

function join(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

interface Frontend {
  type: string;
  body: Uint8Array;
}

/** Serves one connection: reads the startup, then each frontend message, and
 * calls `onMessage` for them; it returns what to send back. */
function mockBackend(options: {
  onStartup: (
    params: Record<string, string>,
    conn: Deno.Conn,
  ) => Promise<void> | void;
  onMessage: (
    msg: Frontend,
    all: Frontend[],
    conn: Deno.Conn,
  ) => Uint8Array | null;
}) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const received: Frontend[] = [];
  const startups: Record<string, string>[] = [];
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
        try {
          // The startup message has no type byte.
          await fill(4);
          let length = new DataView(buf.buffer).getInt32(0);
          await fill(length);
          const startup = buf.slice(8, length);
          buf = buf.slice(length);
          const parts = decoder.decode(startup).split("\0");
          const params: Record<string, string> = {};
          for (let i = 0; i + 1 < parts.length; i += 2) {
            if (parts[i]) params[parts[i]] = parts[i + 1];
          }
          startups.push(params);
          await options.onStartup(params, conn);
          while (true) {
            await fill(5);
            length = new DataView(buf.buffer, buf.byteOffset).getInt32(1);
            await fill(1 + length);
            const msg = {
              type: String.fromCharCode(buf[0]),
              body: buf.slice(5, 1 + length),
            };
            buf = buf.slice(1 + length);
            received.push(msg);
            if (msg.type === "X") break;
            const reply = options.onMessage(msg, received, conn);
            if (reply === null) break;
            if (reply.length) await conn.write(reply);
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
    received,
    startups,
    async close() {
      listener.close();
      await done;
    },
  };
}

const net = { permissions: { net: true } };
const noTls = { ssl: false } as const;

Deno.test(net, async function postgresStartupAndRowDecoding() {
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, parameterStatus, ready));
    },
    onMessage(msg) {
      if (msg.type !== "S") return new Uint8Array();
      // Reply to the extended query once its Sync arrives.
      return join(
        message("1"),
        message("2"),
        rowDescription([
          ["i", 23],
          ["big", 20],
          ["huge", 20],
          ["f", 701],
          ["n", 1700],
          ["b", 16],
          ["t", 25],
          ["j", 3802],
          ["bytes", 17],
          ["d", 1082],
          ["ts", 1114],
          ["tstz", 1184],
          ["ints", 1007],
          ["texts", 1009],
          ["nested", 1007],
          ["nothing", 25],
          ["u", 2950],
          ["unknown", 600],
        ]),
        dataRow([
          "-7",
          "9007199254740991",
          "9223372036854775807",
          "1.5",
          "12345678901234567890.123456789",
          "t",
          "héllo",
          '{"a":[1,2,{"b":null}]}',
          "\\x00ff0a",
          "2026-10-14",
          "2026-10-14 12:34:56.789123",
          "2026-10-14 12:34:56.5+02",
          "{1,2,NULL,4}",
          '{a,"b c","d\\"e\\\\f",NULL,"NULL"}',
          "{{1,2},{3,4}}",
          null,
          "123e4567-e89b-12d3-a456-426614174000",
          "(1,2)",
        ]),
        message("C", cstr("SELECT 1")),
        ready,
      );
    },
  });
  const pg = await Deno.postgres.connect({
    port: backend.port,
    username: "app",
    database: "db",
    applicationName: "mokou-test",
    ...noTls,
  });
  try {
    assertEquals(backend.startups[0], {
      user: "app",
      database: "db",
      client_encoding: "UTF8",
      application_name: "mokou-test",
    });
    const result = await pg.query("SELECT 1");
    assertEquals(result.command, "SELECT");
    assertEquals(result.count, 1);
    assertEquals(result.fields[0], { name: "i", typeOid: 23 });
    assertEquals(result.rows[0], {
      i: -7,
      big: 9007199254740991,
      huge: 9223372036854775807n,
      f: 1.5,
      n: "12345678901234567890.123456789",
      b: true,
      t: "héllo",
      j: { a: [1, 2, { b: null }] },
      bytes: new Uint8Array([0, 255, 10]),
      d: new Date("2026-10-14T00:00:00Z"),
      ts: new Date("2026-10-14T12:34:56.789Z"),
      tstz: new Date("2026-10-14T10:34:56.500Z"),
      ints: [1, 2, null, 4],
      texts: ["a", "b c", 'd"e\\f', null, "NULL"],
      nested: [[1, 2], [3, 4]],
      nothing: null,
      u: "123e4567-e89b-12d3-a456-426614174000",
      unknown: "(1,2)",
    });
  } finally {
    pg.close();
    await backend.close();
  }
});

Deno.test(net, async function postgresEncodesExtendedQueries() {
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, ready));
    },
    onMessage(msg) {
      return msg.type === "S"
        ? join(
          message("1"),
          message("2"),
          message("n"),
          message("C", cstr("INSERT 0 1")),
          ready,
        )
        : new Uint8Array();
    },
  });
  const pg = await Deno.postgres.connect({
    port: backend.port,
    username: "u",
    ...noTls,
  });
  try {
    const result = await pg.query(
      "INSERT INTO t VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        "text",
        42,
        7n,
        true,
        null,
        new Date("2026-01-02T03:04:05Z"),
        new Uint8Array([1, 171]),
        { a: [1] },
        ["x y", 'q"r', null, [1, 2]],
      ],
    );
    assertEquals(result.command, "INSERT");
    assertEquals(result.count, 1);
    assertEquals(result.rows, []);
    const types = backend.received.map((m) => m.type).join("");
    assertEquals(types, "PBDES");
    const [parse, bind] = backend.received;
    assertEquals(
      decoder.decode(parse.body),
      "\0INSERT INTO t VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)\0\0\0",
    );
    // Parameters, in text format: count, then length-prefixed values.
    const text = decoder.decode(bind.body);
    for (
      const expected of [
        "text",
        "42",
        "7",
        "t",
        "2026-01-02T03:04:05.000Z",
        "\\x01ab",
        '{"a":[1]}',
        '{"x y","q\\"r",NULL,{"1","2"}}',
      ]
    ) {
      assert(text.includes(expected), `${expected} in ${JSON.stringify(text)}`);
    }
    const view = new DataView(bind.body.buffer, bind.body.byteOffset);
    assertEquals(view.getInt16(2), 0); // parameter formats: all text
    assertEquals(view.getInt16(4), 9); // parameter count
    assertEquals(view.getInt32(6), 4); // "text"

    await assertRejects(
      () => pg.query("SELECT $1", [Symbol("x")]),
      TypeError,
      "Unsupported query parameter",
    );
    await assertRejects(
      () => pg.query("SELECT 1", "x" as unknown as unknown[]),
      TypeError,
    );
    await assertRejects(() => pg.query(1 as unknown as string), TypeError);
  } finally {
    pg.close();
    await backend.close();
  }
});

Deno.test(net, async function postgresReportsServerErrorsAndSurvivesThem() {
  let queries = 0;
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, ready));
    },
    onMessage(msg) {
      if (msg.type !== "S") return new Uint8Array();
      queries++;
      return queries === 1
        ? join(
          errorResponse({
            S: "ERROR",
            C: "23505",
            M: 'duplicate key value violates unique constraint "users_pkey"',
            D: "Key (id)=(1) already exists.",
            t: "users",
            n: "users_pkey",
            s: "public",
          }),
          ready,
        )
        : join(
          message("1"),
          message("2"),
          message("n"),
          message("C", cstr("SELECT 0")),
          ready,
        );
    },
  });
  const pg = await Deno.postgres.connect({
    port: backend.port,
    username: "u",
    ...noTls,
  });
  try {
    const error = await assertRejects(
      () => pg.query("INSERT"),
      Deno.PostgresError,
      "duplicate key",
    );
    assertEquals(error.code, "23505");
    assertEquals(error.severity, "ERROR");
    assertEquals(error.table, "users");
    assertEquals(error.constraint, "users_pkey");
    assertEquals(error.detail, "Key (id)=(1) already exists.");
    assertEquals(error.name, "PostgresError");
    // The connection is usable after an error.
    assertEquals((await pg.query("SELECT")).count, 0);
  } finally {
    pg.close();
    await backend.close();
  }
});

Deno.test(net, async function postgresCleartextAndMd5Login() {
  for (const method of ["cleartext", "md5"]) {
    let passwordMessage = "";
    const backend = mockBackend({
      async onStartup(_params, conn) {
        await conn.write(
          method === "cleartext"
            ? message("R", int32(3))
            : message("R", [...int32(5), 1, 2, 3, 4]),
        );
      },
      onMessage(msg, _all, conn) {
        if (msg.type === "p") {
          passwordMessage = decoder.decode(msg.body);
          conn.write(join(authOk, ready));
        }
        return new Uint8Array();
      },
    });
    try {
      const pg = await Deno.postgres.connect({
        port: backend.port,
        username: "alice",
        password: "secret",
        ...noTls,
      });
      pg.close();
      if (method === "cleartext") {
        assertEquals(passwordMessage, "secret\0");
      } else {
        // md5(md5("secretalice") + salt), as hex, with the "md5" prefix.
        assertEquals(
          passwordMessage,
          `${md5Login("secret", "alice", [1, 2, 3, 4])}\0`,
        );
      }
    } finally {
      await backend.close();
    }
  }
  // Without a password, the login fails with a clear message.
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(message("R", int32(3)));
    },
    onMessage: () => new Uint8Array(),
  });
  try {
    await assertRejects(
      () =>
        Deno.postgres.connect({
          port: backend.port,
          username: "alice",
          ...noTls,
        }),
      Error,
      "asked for a password",
    );
  } finally {
    await backend.close();
  }
});

/** `md5` + md5(md5(password + user) + salt), the way the protocol defines it
 * (an independent implementation: RFC 1321 in a few lines). */
function md5Login(password: string, user: string, salt: number[]): string {
  const inner = md5Hex(encoder.encode(password + user));
  return "md5" + md5Hex(new Uint8Array([...encoder.encode(inner), ...salt]));
}

function md5Hex(data: Uint8Array): string {
  const K = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
  );
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const padded = new Uint8Array(((data.length + 8) >> 6 << 6) + 64);
  padded.set(data);
  padded[data.length] = 0x80;
  new DataView(padded.buffer).setUint32(
    padded.length - 8,
    (data.length * 8) >>> 0,
    true,
  );
  new DataView(padded.buffer).setUint32(
    padded.length - 4,
    Math.floor(data.length / 2 ** 29),
    true,
  );
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const m = Array.from(
      { length: 16 },
      (_, i) => view.getUint32(offset + i * 4, true),
    );
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      f = (f + a + K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      const s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test(function md5HelperIsCorrect() {
  assertEquals(md5Hex(encoder.encode("")), "d41d8cd98f00b204e9800998ecf8427e");
  assertEquals(
    md5Hex(encoder.encode("abc")),
    "900150983cd24fb0d6963f7d28e17f72",
  );
});

Deno.test(net, async function postgresSimpleQueriesAndTemplates() {
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, ready));
    },
    onMessage(msg) {
      if (msg.type === "Q") {
        return join(
          rowDescription([["a", 23]]),
          dataRow(["1"]),
          message("C", cstr("SELECT 1")),
          message("C", cstr("UPDATE 5")),
          message("I"),
          ready,
        );
      }
      if (msg.type === "S") {
        return join(
          message("1"),
          message("2"),
          rowDescription([["id", 23]]),
          dataRow(["9"]),
          message("C", cstr("SELECT 1")),
          ready,
        );
      }
      return new Uint8Array();
    },
  });
  const pg = await Deno.postgres.connect({
    port: backend.port,
    username: "u",
    ...noTls,
  });
  try {
    const results = await pg.exec("SELECT 1; UPDATE t SET a = 1; ;");
    assertEquals(results.map((r) => [r.command, r.count, r.rows.length]), [
      ["SELECT", 1, 1],
      ["UPDATE", 5, 0],
      ["", 0, 0],
    ]);
    const rows = await pg
      .sql`SELECT id FROM users WHERE name = ${"o'brien"} AND age > ${3}`;
    assertEquals(rows, [{ id: 9 }]);
    // Values are parameters, never part of the SQL text.
    const parse = backend.received.find((m) => m.type === "P")!;
    assertEquals(
      decoder.decode(parse.body),
      "\0SELECT id FROM users WHERE name = $1 AND age > $2\0\0\0",
    );
    assert(!decoder.decode(parse.body).includes("brien"));
  } finally {
    pg.close();
    await backend.close();
  }
});

Deno.test(net, async function postgresTransactions() {
  const statements: string[] = [];
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, ready));
    },
    onMessage(msg) {
      if (msg.type === "Q") {
        statements.push(decoder.decode(msg.body).replace(/\0$/, ""));
        return join(message("C", cstr("COMMIT")), ready);
      }
      if (msg.type === "P") {
        statements.push(decoder.decode(msg.body).split("\0")[1]);
      }
      return msg.type === "S"
        ? join(
          message("1"),
          message("2"),
          message("n"),
          message("C", cstr("UPDATE 1")),
          ready,
        )
        : new Uint8Array();
    },
  });
  const pg = await Deno.postgres.connect({
    port: backend.port,
    username: "u",
    ...noTls,
  });
  try {
    const value = await pg.transaction(async (tx) => {
      await tx.query("UPDATE a SET x = 1");
      await tx.sql`UPDATE b SET y = ${2}`;
      return "done";
    });
    assertEquals(value, "done");
    assertEquals(statements, [
      "BEGIN",
      "UPDATE a SET x = 1",
      "UPDATE b SET y = $1",
      "COMMIT",
    ]);

    statements.length = 0;
    await assertRejects(
      () =>
        pg.transaction(async (tx) => {
          await tx.query("UPDATE a SET x = 2");
          throw new Error("changed my mind");
        }),
      Error,
      "changed my mind",
    );
    assertEquals(statements, ["BEGIN", "UPDATE a SET x = 2", "ROLLBACK"]);

    // A transaction object stops working once the transaction is over.
    let leaked: Deno.PostgresTransaction | undefined;
    await pg.transaction((tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    await assertRejects(
      () => leaked!.query("SELECT 1"),
      Error,
      "already finished",
    );

    // Other calls wait for a running transaction.
    statements.length = 0;
    const order: string[] = [];
    const tx = pg.transaction(async (t) => {
      await t.query("UPDATE c SET z = 1");
      order.push("tx");
    });
    const outside = pg.query("UPDATE d SET w = 1").then(() =>
      order.push("outside")
    );
    await Promise.all([tx, outside]);
    assertEquals(order, ["tx", "outside"]);
    assertEquals(statements, [
      "BEGIN",
      "UPDATE c SET z = 1",
      "COMMIT",
      "UPDATE d SET w = 1",
    ]);
  } finally {
    pg.close();
    await backend.close();
  }
});

Deno.test(net, async function postgresConnectionLossAndBadServers() {
  // The server drops the connection in the middle of a query.
  const dropping = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, ready));
    },
    onMessage: (msg) => msg.type === "S" ? null : new Uint8Array(),
  });
  const pg = await Deno.postgres.connect({
    port: dropping.port,
    username: "u",
    ...noTls,
  });
  try {
    await assertRejects(() => pg.query("SELECT 1"), Error, "closed");
    await pg.closed;
    await assertRejects(() => pg.query("SELECT 1"), Error, "closed");
  } finally {
    pg.close();
    await dropping.close();
  }
  // The server rejects the login.
  const rejecting = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(
        errorResponse({
          S: "FATAL",
          C: "28P01",
          M: 'password authentication failed for user "u"',
        }),
      );
    },
    onMessage: () => new Uint8Array(),
  });
  try {
    const error = await assertRejects(
      () =>
        Deno.postgres.connect({
          port: rejecting.port,
          username: "u",
          ...noTls,
        }),
      Deno.PostgresError,
      "password authentication failed",
    );
    assertEquals(error.code, "28P01");
  } finally {
    await rejecting.close();
  }
});

Deno.test(net, async function postgresConnectionStringsAndOptions() {
  const backend = mockBackend({
    async onStartup(_params, conn) {
      await conn.write(join(authOk, ready));
    },
    onMessage: () => new Uint8Array(),
  });
  try {
    const pg = await Deno.postgres.connect(
      `postgres://me%40corp:p%2Fw@127.0.0.1:${backend.port}/my%20db?sslmode=disable&application_name=svc`,
    );
    pg.close();
    assertEquals(backend.startups[0], {
      user: "me@corp",
      database: "my db",
      client_encoding: "UTF8",
      application_name: "svc",
    });
    // The database defaults to the user name.
    (await Deno.postgres.connect({
      port: backend.port,
      username: "solo",
      ssl: false,
    })).close();
    assertEquals(backend.startups[1].database, "solo");

    await assertRejects(
      () => Deno.postgres.connect("mysql://localhost"),
      TypeError,
      "Unsupported protocol",
    );
    await assertRejects(
      () => Deno.postgres.connect({ port: backend.port }),
      TypeError,
      "username",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => Deno.postgres.connect({ username: "u", ssl: "sometimes" as any }),
      TypeError,
      "ssl",
    );
    await assertRejects(
      () => Deno.postgres.connect(5 as unknown as string),
      TypeError,
    );
  } finally {
    await backend.close();
  }
});

Deno.test(function postgresClientHasNoPublicConstructor() {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => new (Deno.PostgresClient as any)(),
    TypeError,
    "Illegal constructor",
  );
});

// --- a real server ----------------------------------------------------------------
//
// Set MOKOU_TEST_POSTGRES to a superuser URL, such as
// postgres://postgres:secret@127.0.0.1:5432/postgres, to run these. Each test
// works in its own schema and removes it afterwards.

let realUrl: string | undefined;
try {
  realUrl = Deno.env.get("MOKOU_TEST_POSTGRES");
} catch {
  // No env permission: skip the real-server tests.
}

Deno.test(
  { ignore: !realUrl, permissions: { net: true, env: true } },
  async function postgresAgainstARealServer(t) {
    const pg = await Deno.postgres.connect(realUrl!);
    try {
      await pg.exec(
        "DROP SCHEMA IF EXISTS mokou_test CASCADE; CREATE SCHEMA mokou_test",
      );
      await pg.exec("SET search_path TO mokou_test");

      await t.step("types", async () => {
        const { rows: [row] } = await pg.query(`
          SELECT 1::int2 AS i2, (-2147483648)::int4 AS i4, 9007199254740993::int8 AS i8,
                 1.25::float8 AS f8, 'NaN'::float8 AS nan, 12.50::numeric(10,2) AS num,
                 true AS yes, 'héllo \u{1F995}'::text AS txt, '{"a":[1,null]}'::jsonb AS js,
                 '\\xdeadbeef'::bytea AS bin, '2026-10-14'::date AS d,
                 '2026-10-14 12:34:56.789123'::timestamp AS ts,
                 '2026-10-14 12:34:56+05:30'::timestamptz AS tstz,
                 ARRAY[1,2,NULL]::int4[] AS ints, ARRAY['a b','c"d',NULL]::text[] AS texts,
                 ARRAY[[1,2],[3,4]]::int4[] AS grid, '{}'::int4[] AS empty,
                 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS id, NULL::text AS nothing,
                 '(1,2)'::point AS p
        `);
        assertEquals(row.i2, 1);
        assertEquals(row.i4, -2147483648);
        assertEquals(row.i8, 9007199254740993n);
        assertEquals(row.f8, 1.25);
        assert(Number.isNaN(row.nan));
        assertEquals(row.num, "12.50");
        assertEquals(row.yes, true);
        assertEquals(row.txt, "héllo \u{1F995}");
        assertEquals(row.js, { a: [1, null] });
        assertEquals(row.bin, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        assertEquals(row.d, new Date("2026-10-14T00:00:00Z"));
        assertEquals(row.ts, new Date("2026-10-14T12:34:56.789Z"));
        assertEquals(row.tstz, new Date("2026-10-14T07:04:56Z"));
        assertEquals(row.ints, [1, 2, null]);
        assertEquals(row.texts, ["a b", 'c"d', null]);
        assertEquals(row.grid, [[1, 2], [3, 4]]);
        assertEquals(row.empty, []);
        assertEquals(row.id, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
        assertEquals(row.nothing, null);
        assertEquals(row.p, "(1,2)");
      });

      await t.step("parameters round-trip", async () => {
        await pg.exec(`CREATE TABLE items (
          id serial PRIMARY KEY, name text, qty int, price numeric, at timestamptz,
          data jsonb, raw bytea, tags text[], ok boolean, big bigint)`);
        const when = new Date("2026-01-02T03:04:05.678Z");
        const inserted = await pg.query(
          `INSERT INTO items (name, qty, price, at, data, raw, tags, ok, big)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            "o'brien; DROP TABLE items; --",
            3,
            "9.99",
            when,
            { nested: { list: [1, 2] } },
            new Uint8Array([0, 1, 255]),
            ["x y", 'q"r', "back\\slash", "NULL"],
            false,
            1234567890123456789n,
          ],
        );
        assertEquals(inserted.command, "INSERT");
        assertEquals(inserted.count, 1);
        const row = inserted.rows[0];
        assertEquals(row.name, "o'brien; DROP TABLE items; --");
        assertEquals(row.qty, 3);
        assertEquals(row.price, "9.99");
        assertEquals(row.at, when);
        assertEquals(row.data, { nested: { list: [1, 2] } });
        assertEquals(row.raw, new Uint8Array([0, 1, 255]));
        assertEquals(row.tags, ["x y", 'q"r', "back\\slash", "NULL"]);
        assertEquals(row.ok, false);
        assertEquals(row.big, 1234567890123456789n);

        const nulls = await pg
          .sql`INSERT INTO items (name, qty) VALUES (${null}, ${undefined}) RETURNING id, name, qty`;
        assertEquals(nulls[0].name, null);
        assertEquals(nulls[0].qty, null);
        assertEquals(
          (await pg.query("UPDATE items SET qty = qty + 1")).count,
          2,
        );
        const found = await pg.sql<
          { name: string }
        >`SELECT name FROM items WHERE qty = ${4}`;
        assertEquals(found.length, 1);
        assertEquals(
          (await pg.sql`SELECT count(*)::int AS n FROM items`)[0].n,
          2,
        );
      });

      await t.step("errors", async () => {
        const syntax = await assertRejects(
          () => pg.query("SELEC 1"),
          Deno.PostgresError,
        );
        assertEquals(syntax.code, "42601");
        assert(syntax.position !== undefined);
        await pg.query("CREATE UNIQUE INDEX items_name ON items (name)");
        await assertRejects(
          () =>
            pg.query("INSERT INTO items (name) VALUES ($1)", [
              "o'brien; DROP TABLE items; --",
            ]),
          Deno.PostgresError,
          "duplicate key",
        );
        const missing = await assertRejects(
          () => pg.query("SELECT * FROM nope"),
          Deno.PostgresError,
        );
        assertEquals(missing.code, "42P01");
        // The connection still works.
        assertEquals((await pg.sql`SELECT 1 AS one`)[0].one, 1);
      });

      await t.step("scripts and empty queries", async () => {
        const results = await pg.exec("SELECT 1 AS a; SELECT 2 AS b, 3 AS c");
        assertEquals(results.map((r) => r.rows), [[{ a: 1 }], [{
          b: 2,
          c: 3,
        }]]);
        assertEquals((await pg.query("")).rows, []);
        // Duplicate column names keep the last value, as in most clients.
        assertEquals((await pg.query("SELECT 1 AS x, 2 AS x")).rows[0], {
          x: 2,
        });
        assertEquals(
          (await pg.query('SELECT 1 AS "__proto__"')).rows[0].__proto__,
          1,
        );
      });

      await t.step("transactions", async () => {
        await pg.exec("CREATE TABLE acct (n text PRIMARY KEY, bal int)");
        await pg.transaction(async (tx) => {
          await tx.query("INSERT INTO acct VALUES ('a', 100), ('b', 0)");
          await tx.sql`UPDATE acct SET bal = bal - ${30} WHERE n = 'a'`;
          await tx.sql`UPDATE acct SET bal = bal + ${30} WHERE n = 'b'`;
        });
        assertEquals(
          (await pg.query("SELECT n, bal FROM acct ORDER BY n")).rows,
          [
            { n: "a", bal: 70 },
            { n: "b", bal: 30 },
          ],
        );
        await assertRejects(
          () =>
            pg.transaction(async (tx) => {
              await tx.query("UPDATE acct SET bal = 0");
              await tx.query("INSERT INTO acct VALUES ('a', 1)"); // duplicate key
            }),
          Deno.PostgresError,
        );
        assertEquals(
          (await pg.sql`SELECT bal FROM acct WHERE n = 'a'`)[0].bal,
          70,
        );
      });

      await t.step("concurrent calls run in order", async () => {
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) => pg.sql`SELECT ${i}::int AS n`),
        );
        assertEquals(
          results.map((r) => r[0].n),
          Array.from({ length: 50 }, (_, i) => i),
        );
      });

      await t.step("listen and notify", async () => {
        const received: [string, string][] = [];
        const notified = Promise.withResolvers<void>();
        const stop = await pg.listen("mokou_chan", (payload, channel) => {
          received.push([channel, payload]);
          notified.resolve();
        });
        const other = await Deno.postgres.connect(realUrl!);
        await other.query("SELECT pg_notify('mokou_chan', $1)", [
          "hello \u{1F995}",
        ]);
        other.close();
        await notified.promise;
        assertEquals(received, [["mokou_chan", "hello \u{1F995}"]]);
        stop();
      });
    } finally {
      await pg.exec("DROP SCHEMA IF EXISTS mokou_test CASCADE");
      pg.close();
    }
  },
);

Deno.test(
  { ignore: !realUrl, permissions: { net: true, env: true } },
  async function postgresWrongPasswordIsRefused() {
    const url = new URL(realUrl!);
    url.password = "definitely-wrong";
    const error = await assertRejects(
      () => Deno.postgres.connect(url),
      Deno.PostgresError,
    );
    assertEquals(error.code, "28P01");
  },
);
