// Copyright 2018-2026 the Deno authors. MIT license.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./test_util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- a scripted RESP server -----------------------------------------------------

/** Reads one command (an array of bulk strings) from `conn`. */
async function readCommand(
  conn: Deno.Conn,
  state: { buf: Uint8Array },
): Promise<string[] | null> {
  const chunk = new Uint8Array(4096);
  while (true) {
    const text = decoder.decode(state.buf);
    const m = text.match(/^\*(\d+)\r\n/);
    if (m) {
      const count = Number(m[1]);
      let at = m[0].length;
      const args: string[] = [];
      let complete = true;
      for (let i = 0; i < count; i++) {
        const bulk = text.slice(at).match(/^\$(\d+)\r\n/);
        if (!bulk) {
          complete = false;
          break;
        }
        const len = Number(bulk[1]);
        const start = at + bulk[0].length;
        if (text.length < start + len + 2) {
          complete = false;
          break;
        }
        args.push(text.slice(start, start + len));
        at = start + len + 2;
      }
      if (complete) {
        state.buf = state.buf.slice(encoder.encode(text.slice(0, at)).length);
        return args;
      }
    }
    const n = await conn.read(chunk);
    if (n === null) return null;
    state.buf = new Uint8Array([...state.buf, ...chunk.subarray(0, n)]);
  }
}

/** Serves `handler` for each connection, and records every command. */
function mockServer(
  handler: (
    command: string[],
    conn: Deno.Conn,
  ) => Uint8Array | string | null | Promise<Uint8Array | string | null>,
) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const commands: string[][] = [];
  const done = (async () => {
    for await (const conn of listener) {
      (async () => {
        const state = { buf: new Uint8Array() };
        try {
          while (true) {
            const command = await readCommand(conn, state);
            if (command === null) break;
            commands.push(command);
            const reply = await handler(command, conn);
            if (reply === null) {
              conn.close();
              break;
            }
            await conn.write(
              typeof reply === "string" ? encoder.encode(reply) : reply,
            );
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
    async close() {
      listener.close();
      await done;
    },
  };
}

const net = { permissions: { net: true } };

Deno.test(net, async function redisParsesEveryReplyType() {
  const server = mockServer((command) => {
    switch (command[0]) {
      case "SIMPLE":
        return "+OK\r\n";
      case "INT":
        return ":-42\r\n";
      case "BIGINT":
        return ":9007199254740993\r\n";
      case "BULK":
        return "$12\r\nhello\r\nworld\r\n";
      case "UTF8":
        return encoder.encode("$6\r\nhéllo\r\n");
      case "NULL":
        return "$-1\r\n";
      case "EMPTY":
        return "$0\r\n\r\n";
      case "ARRAY":
        return "*4\r\n:1\r\n$3\r\ntwo\r\n*2\r\n+x\r\n$-1\r\n*-1\r\n";
      case "ERR":
        return "-WRONGTYPE Operation against a key holding the wrong kind\r\n";
      case "BYTES":
        return new Uint8Array([
          ...encoder.encode("$4\r\n"),
          0,
          255,
          13,
          10,
          ...encoder.encode("\r\n"),
        ]);
    }
    return "-ERR unknown\r\n";
  });
  const redis = await Deno.redis.connect({ port: server.port });
  try {
    assertEquals(await redis.send("SIMPLE"), "OK");
    assertEquals(await redis.send("INT"), -42);
    assertEquals(await redis.send("BIGINT"), 9007199254740993n);
    assertEquals(await redis.send("BULK"), "hello\r\nworld");
    assertEquals(await redis.send("UTF8"), "héllo");
    assertEquals(await redis.send("NULL"), null);
    assertEquals(await redis.send("EMPTY"), "");
    assertEquals(await redis.send("ARRAY"), [1, "two", ["x", null], null]);
    assertEquals(
      await redis.sendBytes("BYTES"),
      new Uint8Array([0, 255, 13, 10]),
    );
    const error = await assertRejects(
      () => redis.send("ERR"),
      Deno.RedisError,
      "wrong kind",
    );
    assertEquals(error.code, "WRONGTYPE");
    assertEquals(error.name, "RedisError");
    // The connection survives an error reply.
    assertEquals(await redis.send("SIMPLE"), "OK");
  } finally {
    redis.close();
    await server.close();
  }
});

Deno.test(net, async function redisParsesReplyDeliveredByteByByte() {
  const replies: Record<string, string> = {
    A: "*3\r\n$5\r\nhello\r\n:7\r\n*1\r\n$3\r\nabc\r\n",
    B: "+tail\r\n",
  };
  const server = mockServer(async (command, conn) => {
    for (const byte of encoder.encode(replies[command[0]])) {
      await conn.write(new Uint8Array([byte]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return new Uint8Array();
  });
  const redis = await Deno.redis.connect({ port: server.port });
  try {
    const first = redis.send("A");
    const second = redis.send("B");
    assertEquals(await first, ["hello", 7, ["abc"]]);
    assertEquals(await second, "tail");
  } finally {
    redis.close();
    await server.close();
  }
});

Deno.test(net, async function redisEncodesCommandsAsBulkStrings() {
  const raw: Uint8Array[] = [];
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const serving = (async () => {
    const conn = await listener.accept();
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    raw.push(buf.slice(0, n!));
    await conn.write(encoder.encode("+OK\r\n"));
    conn.close();
  })();
  const redis = await Deno.redis.connect({
    port: (listener.addr as Deno.NetAddr).port,
  });
  try {
    await redis.send(
      "SET",
      "kéy",
      42,
      true,
      12345678901234567890n,
      new Uint8Array([0, 1]),
    );
    await serving;
    assertEquals(
      decoder.decode(raw[0]),
      "*6\r\n$3\r\nSET\r\n$4\r\nkéy\r\n$2\r\n42\r\n$1\r\n1\r\n" +
        "$20\r\n12345678901234567890\r\n$2\r\n\u0000\u0001\r\n",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => redis.send("SET", "k", { v: 1 } as any),
      TypeError,
      "strings, numbers",
    );
    await assertRejects(() => redis.send(""), TypeError);
  } finally {
    redis.close();
    listener.close();
  }
});

Deno.test(net, async function redisConnectUrlAuthenticatesAndSelects() {
  const server = mockServer(() => "+OK\r\n");
  try {
    const redis = await Deno.redis.connect(
      `redis://user:p%40ss%3A@127.0.0.1:${server.port}/3`,
    );
    redis.close();
    assertEquals(server.commands, [["AUTH", "user", "p@ss:"], ["SELECT", "3"]]);

    server.commands.length = 0;
    (await Deno.redis.connect({
      hostname: "127.0.0.1",
      port: server.port,
      password: "secret",
    })).close();
    assertEquals(server.commands, [["AUTH", "secret"]]);

    // No credentials and database 0: nothing extra is sent.
    server.commands.length = 0;
    (await Deno.redis.connect(`redis://127.0.0.1:${server.port}`)).close();
    assertEquals(server.commands, []);

    await assertRejects(
      () => Deno.redis.connect("http://localhost"),
      TypeError,
      "Unsupported protocol",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => Deno.redis.connect(42 as any),
      TypeError,
    );
  } finally {
    await server.close();
  }
});

Deno.test(net, async function redisConnectFailsOnBadPassword() {
  const server = mockServer((command) =>
    command[0] === "AUTH"
      ? "-WRONGPASS invalid username-password pair\r\n"
      : "+OK\r\n"
  );
  try {
    const error = await assertRejects(
      () => Deno.redis.connect({ port: server.port, password: "nope" }),
      Deno.RedisError,
    );
    assertEquals(error.code, "WRONGPASS");
  } finally {
    await server.close();
  }
});

Deno.test(net, async function redisConnectionLoss() {
  const server = mockServer((command) =>
    command[0] === "DIE" ? null : "+OK\r\n"
  );
  const redis = await Deno.redis.connect({ port: server.port });
  try {
    assertEquals(await redis.send("PING"), "OK");
    const dying = redis.send("DIE");
    const queued = redis.send("PING");
    await assertRejects(() => dying, Error, "closed");
    await assertRejects(() => queued, Error, "closed");
    await redis.closed;
    await assertRejects(() => redis.send("PING"), Error, "closed");
  } finally {
    redis.close();
    await server.close();
  }
});

Deno.test(net, async function redisRejectsGarbage() {
  const server = mockServer(() => "!not resp\r\n");
  const redis = await Deno.redis.connect({ port: server.port });
  try {
    await assertRejects(() => redis.send("PING"));
    await redis.closed;
  } finally {
    redis.close();
    await server.close();
  }
});

Deno.test(
  { permissions: { net: ["127.0.0.1:1"] } },
  async function redisNeedsNetPermission() {
    await assertRejects(
      () => Deno.redis.connect({ port: 6379 }),
      Deno.errors.NotCapable,
    );
  },
);

Deno.test(function redisClientHasNoPublicConstructor() {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => new (Deno.RedisClient as any)(),
    TypeError,
    "Illegal constructor",
  );
});

// --- a real server, when redis-server is installed ------------------------------

async function startRedis(): Promise<
  { port: number; stop: () => Promise<void> } | undefined
> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("redis-server", {
      args: [
        "--port",
        String(port),
        "--bind",
        "127.0.0.1",
        "--save",
        "",
        "--appendonly",
        "no",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    return undefined;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      return {
        port,
        async stop() {
          child.kill();
          await child.status;
        },
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill();
  await child.status;
  return undefined;
}

const redisServerAvailable = (() => {
  try {
    new Deno.Command("redis-server", { args: ["--version"] }).outputSync();
    return true;
  } catch {
    return false;
  }
})();

Deno.test(
  {
    ignore: !redisServerAvailable,
    permissions: { net: true, run: ["redis-server"] },
  },
  async function redisAgainstARealServer(t) {
    const server = await startRedis();
    assert(server, "redis-server did not start");
    const redis = await Deno.redis.connect({ port: server.port });
    try {
      await t.step("strings", async () => {
        assertEquals(await redis.ping(), "PONG");
        assertEquals(await redis.ping("hi"), "hi");
        assertEquals(await redis.set("a", "1"), "OK");
        assertEquals(await redis.get("a"), "1");
        assertEquals(await redis.get("missing"), null);
        assertEquals(await redis.set("a", "2", { nx: true }), null);
        assertEquals(await redis.set("b", "x", { ex: 100 }), "OK");
        const ttl = await redis.ttl("b");
        assert(ttl > 90 && ttl <= 100, `ttl ${ttl}`);
        assertEquals(await redis.exists("a", "b", "missing"), true);
        assertEquals(await redis.exists("missing"), false);
        assertEquals(await redis.incr("n"), 1);
        assertEquals(await redis.incrBy("n", 41), 42);
        assertEquals(await redis.decr("n"), 41);
        assertEquals(await redis.mset({ x: 1, y: "two" }), "OK");
        assertEquals(await redis.mget("x", "nope", "y"), ["1", null, "two"]);
        assertEquals(await redis.del("x", "y", "nope"), 2);
        assertEquals(await redis.expire("a", 50), 1);
        // Unicode survives, and so do bytes that aren't text.
        await redis.set("u", "héllo \u{1F995}");
        assertEquals(await redis.get("u"), "héllo \u{1F995}");
        const bytes = new Uint8Array(256).map((_, i) => i);
        await redis.set("bin", bytes);
        assertEquals(await redis.sendBytes("GET", "bin"), bytes);
      });

      await t.step("hashes, lists and sets", async () => {
        assertEquals(await redis.hset("h", { f1: "v1", f2: 2 }), 2);
        assertEquals(await redis.hget("h", "f1"), "v1");
        assertEquals(await redis.hgetall("h"), { f1: "v1", f2: "2" });
        assertEquals(await redis.hdel("h", "f1"), 1);
        assertEquals(await redis.hgetall("none"), {});
        assertEquals(await redis.rpush("l", "a", "b", "c"), 3);
        assertEquals(await redis.lpush("l", "z"), 4);
        assertEquals(await redis.lrange("l", 0, -1), ["z", "a", "b", "c"]);
        assertEquals(await redis.lpop("l"), "z");
        assertEquals(await redis.rpop("l"), "c");
        assertEquals(await redis.llen("l"), 2);
        assertEquals(await redis.sadd("s", "p", "q", "p"), 2);
        assertEquals(await redis.sismember("s", "p"), true);
        assertEquals(await redis.sismember("s", "r"), false);
        assertEquals((await redis.smembers("s")).sort(), ["p", "q"]);
        assertEquals(await redis.srem("s", "p"), 1);
      });

      await t.step("errors", async () => {
        const error = await assertRejects(
          () => redis.hget("l", "field"),
          Deno.RedisError,
        );
        assertEquals(error.code, "WRONGTYPE");
        await assertRejects(
          () => redis.send("NOSUCHCOMMAND"),
          Deno.RedisError,
          "unknown command",
        );
        assertEquals(await redis.get("a"), "1");
      });

      await t.step("pipelined commands arrive in order", async () => {
        await redis.del("counter");
        const results = await Promise.all(
          Array.from({ length: 200 }, () => redis.incr("counter")),
        );
        assertEquals(results, Array.from({ length: 200 }, (_, i) => i + 1));
      });

      await t.step("pipeline and transaction", async () => {
        const results = await redis.pipeline()
          .send("SET", "p", "1")
          .send("INCR", "p")
          .send("LPUSH", "p", "x")
          .send("GET", "p")
          .exec();
        assertEquals(results![0], "OK");
        assertEquals(results![1], 2);
        assert(results![2] instanceof Deno.RedisError);
        assertEquals(results![3], "2");

        const tx = await redis.pipeline({ transaction: true })
          .send("INCR", "t")
          .send("INCR", "t")
          .send("GET", "t")
          .exec();
        assertEquals(tx, [1, 2, "2"]);

        // A WATCHed key that changes aborts the transaction.
        await redis.send("WATCH", "w");
        await (await Deno.redis.connect({ port: server.port })).set("w", "x");
        const aborted = await redis.pipeline({ transaction: true })
          .send("SET", "w", "mine")
          .exec();
        assertEquals(aborted, null);
      });

      await t.step("scan", async () => {
        await redis.mset({ "scan:1": 1, "scan:2": 2, "scan:3": 3, other: 4 });
        const keys: string[] = [];
        for await (const key of redis.scan({ match: "scan:*", count: 2 })) {
          keys.push(key);
        }
        assertEquals(keys.sort(), ["scan:1", "scan:2", "scan:3"]);
      });

      await t.step("pub/sub", async () => {
        const subscription = await redis.subscribe(["news", "alerts"], {
          patterns: "log.*",
        });
        assertEquals(await redis.publish("news", "hello"), 1);
        assertEquals(await redis.publish("log.error", "boom"), 1);
        assertEquals(await redis.publish("nobody", "x"), 0);
        assertEquals(await subscription.next(), {
          channel: "news",
          message: "hello",
        });
        assertEquals(await subscription.next(), {
          pattern: "log.*",
          channel: "log.error",
          message: "boom",
        });
        // Iteration, and closing by leaving the loop.
        await redis.publish("alerts", "one");
        await redis.publish("alerts", "two");
        const seen: string[] = [];
        for await (const message of subscription) {
          seen.push(message.message);
          if (seen.length === 2) break;
        }
        assertEquals(seen, ["one", "two"]);
        assertEquals(await subscription.next(), null);
        assertEquals(await redis.publish("news", "after"), 0);
      });
    } finally {
      redis.close();
      await server.stop();
    }
  },
);
