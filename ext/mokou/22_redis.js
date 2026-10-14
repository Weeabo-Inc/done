// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.redis`: a Redis client over TCP or TLS, speaking RESP2. Commands are
// pipelined on one connection and answered in order. Pub/sub uses its own
// connection.

(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayIsArray,
  ArrayPrototypePush,
  ArrayPrototypeShift,
  BigInt,
  Error,
  MathMax,
  NumberIsInteger,
  NumberIsSafeInteger,
  NumberParseInt,
  ObjectEntries,
  ObjectFreeze,
  ObjectFromEntries,
  ObjectPrototypeIsPrototypeOf,
  PromiseWithResolvers,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  SafeArrayIterator,
  SafePromiseAll,
  String,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  Symbol,
  SymbolAsyncIterator,
  SymbolDispose,
  TypeError,
  TypedArrayPrototypeSet,
  TypedArrayPrototypeSubarray,
  Uint8Array,
  Uint8ArrayPrototype,
  decodeURIComponent,
} = primordials;
const { connect } = core.loadExtScript("ext:deno_net/01_net.js");
const { connectTls } = core.loadExtScript("ext:deno_net/02_tls.js");
const { URL, URLPrototype } = core.loadExtScript("ext:deno_web/00_url.js");

const CR = 13;
const LF = 10;
const MAX_DEPTH = 64;
const MAX_BULK = 512 * 1024 * 1024;
const decoder = new TextDecoder();
const constructorKey = Symbol("RedisClient");

class RedisError extends Error {
  name = "RedisError";
  /** The first word of the message, such as `"WRONGTYPE"` or `"ERR"`. */
  code;
  constructor(message) {
    super(message);
    const space = StringPrototypeIndexOf(message, " ");
    this.code = space === -1
      ? message
      : StringPrototypeSlice(message, 0, space);
  }
}

const RedisErrorPrototype = RedisError.prototype;

// --- encoding -----------------------------------------------------------------

function argBytes(arg) {
  if (typeof arg === "string") return core.encode(arg);
  if (ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, arg)) return arg;
  if (
    typeof arg === "number" || typeof arg === "bigint" ||
    typeof arg === "boolean"
  ) {
    return core.encode(String(typeof arg === "boolean" ? +arg : arg));
  }
  throw new TypeError(
    "Redis arguments must be strings, numbers, booleans or Uint8Arrays",
  );
}

/** One command as a RESP array of bulk strings. */
function encode(command, args) {
  const parts = [command, ...new SafeArrayIterator(args)];
  const pieces = [];
  let size = 0;
  const head = core.encode(`*${parts.length}\r\n`);
  ArrayPrototypePush(pieces, head);
  size += head.length;
  for (let i = 0; i < parts.length; i++) {
    const bytes = argBytes(parts[i]);
    const header = core.encode(`$${bytes.length}\r\n`);
    ArrayPrototypePush(pieces, header, bytes, CRLF);
    size += header.length + bytes.length + 2;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    TypedArrayPrototypeSet(out, pieces[i], offset);
    offset += pieces[i].length;
  }
  return out;
}
const CRLF = new Uint8Array([CR, LF]);

// --- decoding -----------------------------------------------------------------

class ProtocolError extends Error {
  name = "RedisProtocolError";
}

function lineEnd(buf, pos, end) {
  for (let i = pos; i + 1 < end; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
}

function parseInteger(buf, pos, end) {
  let negative = false;
  let i = pos;
  if (buf[i] === 45) {
    negative = true;
    i++;
  }
  if (i === end) throw new ProtocolError("Empty number in a Redis reply");
  let value = 0;
  for (; i < end; i++) {
    const digit = buf[i] - 48;
    if (digit < 0 || digit > 9) {
      throw new ProtocolError("Invalid number in a Redis reply");
    }
    value = value * 10 + digit;
  }
  return negative ? -value : value;
}

/** Parses one reply at `pos`. Returns `[value, nextPos]`, or `null` when the
 * reply isn't complete yet. */
function parseReply(buf, pos, end, asBytes, depth) {
  if (pos >= end) return null;
  if (depth > MAX_DEPTH) {
    throw new ProtocolError("Redis reply nested too deeply");
  }
  const type = buf[pos];
  const eol = lineEnd(buf, pos + 1, end);
  if (eol === -1) return null;
  const next = eol + 2;
  switch (type) {
    case 43: // +
      return [
        decoder.decode(TypedArrayPrototypeSubarray(buf, pos + 1, eol)),
        next,
      ];
    case 45: // -
      return [
        new RedisError(
          decoder.decode(TypedArrayPrototypeSubarray(buf, pos + 1, eol)),
        ),
        next,
      ];
    case 58: { // :
      const value = parseInteger(buf, pos + 1, eol);
      if (!NumberIsSafeInteger(value)) {
        return [
          BigInt(
            decoder.decode(TypedArrayPrototypeSubarray(buf, pos + 1, eol)),
          ),
          next,
        ];
      }
      return [value, next];
    }
    case 36: { // $
      const length = parseInteger(buf, pos + 1, eol);
      if (length === -1) return [null, next];
      if (length < 0 || length > MAX_BULK) {
        throw new ProtocolError("Invalid bulk string length in a Redis reply");
      }
      if (next + length + 2 > end) return null;
      const slice = TypedArrayPrototypeSubarray(buf, next, next + length);
      return [
        asBytes ? new Uint8Array(slice) : decoder.decode(slice),
        next + length + 2,
      ];
    }
    case 42: { // *
      const length = parseInteger(buf, pos + 1, eol);
      if (length === -1) return [null, next];
      if (length < 0) {
        throw new ProtocolError("Invalid array length in a Redis reply");
      }
      const items = [];
      let at = next;
      for (let i = 0; i < length; i++) {
        const item = parseReply(buf, at, end, asBytes, depth + 1);
        if (item === null) return null;
        items[i] = item[0];
        at = item[1];
      }
      return [items, at];
    }
    default:
      throw new ProtocolError(
        `Unexpected byte ${type} at the start of a Redis reply`,
      );
  }
}

// --- connection ---------------------------------------------------------------

function parseOptions(target, options) {
  let config;
  if (
    typeof target === "string" ||
    ObjectPrototypeIsPrototypeOf(URLPrototype, target)
  ) {
    const url = new URL(`${target}`);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      throw new TypeError(
        `Unsupported protocol ${url.protocol}; expected redis: or rediss:`,
      );
    }
    config = {
      hostname: url.hostname === "" ? undefined : url.hostname,
      port: url.port === "" ? undefined : NumberParseInt(url.port, 10),
      username: url.username === ""
        ? undefined
        : decodeURIComponent(url.username),
      password: url.password === ""
        ? undefined
        : decodeURIComponent(url.password),
      db: url.pathname.length > 1
        ? NumberParseInt(StringPrototypeSlice(url.pathname, 1), 10)
        : undefined,
      tls: url.protocol === "rediss:",
      ...options,
    };
  } else if (target !== null && typeof target === "object") {
    config = { ...target };
  } else {
    throw new TypeError(
      "Deno.redis.connect() expects a URL or an options object",
    );
  }
  config.hostname ??= "127.0.0.1";
  config.port ??= 6379;
  if (config.db !== undefined && !NumberIsInteger(config.db)) {
    throw new TypeError("db must be an integer");
  }
  return config;
}

class Pending {
  asBytes;
  resolve;
  reject;
  promise;
  constructor(asBytes) {
    this.asBytes = asBytes;
    const { promise, resolve, reject } = PromiseWithResolvers();
    this.promise = promise;
    this.resolve = resolve;
    this.reject = reject;
  }
}

class RedisClient {
  #conn;
  #buf = new Uint8Array(4096);
  #start = 0;
  #end = 0;
  #pending = [];
  #write = PromiseResolve();
  #closed = false;
  #closedPromise;
  #closeError;
  // Set on the connection used for pub/sub.
  #onPush;
  #pushMode = false;

  constructor(key, conn) {
    if (key !== constructorKey) throw new TypeError("Illegal constructor");
    this.#conn = conn;
    this.#closedPromise = this.#readLoop();
  }

  static async open(config, onPush) {
    const connection = config.tls
      ? await connectTls({
        hostname: config.hostname,
        port: config.port,
        caCerts: config.caCerts,
      })
      : await connect({ hostname: config.hostname, port: config.port });
    // Small writes shouldn't wait for the peer's delayed acknowledgement.
    connection.setNoDelay?.(true);
    const client = new RedisClient(constructorKey, connection);
    client.#onPush = onPush;
    try {
      if (config.password !== undefined) {
        await client.send(
          "AUTH",
          ...new SafeArrayIterator(
            config.username === undefined
              ? [config.password]
              : [config.username, config.password],
          ),
        );
      }
      if (config.db !== undefined && config.db !== 0) {
        await client.send("SELECT", config.db);
      }
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  /** Resolves when the connection has closed. */
  get closed() {
    return this.#closedPromise;
  }

  async #readLoop() {
    const chunk = new Uint8Array(16384);
    try {
      while (true) {
        const n = await this.#conn.read(chunk);
        if (n === null) break;
        this.#append(TypedArrayPrototypeSubarray(chunk, 0, n));
        this.#drain();
      }
    } catch (error) {
      if (!this.#closed) this.#closeError = error;
    } finally {
      this.#closed = true;
      try {
        this.#conn.close();
      } catch {
        // Already closed.
      }
      const error = this.#closeError ??
        new Error("The Redis connection is closed");
      for (const pending of new SafeArrayIterator(this.#pending)) {
        pending.reject(error);
      }
      this.#pending = [];
      this.#onPush?.(null, this.#closeError);
    }
  }

  #append(bytes) {
    const used = this.#end - this.#start;
    if (this.#end + bytes.length > this.#buf.length) {
      const grown = new Uint8Array(
        MathMax(this.#buf.length * 2, used + bytes.length),
      );
      TypedArrayPrototypeSet(
        grown,
        TypedArrayPrototypeSubarray(this.#buf, this.#start, this.#end),
        0,
      );
      this.#buf = grown;
      this.#start = 0;
      this.#end = used;
    }
    TypedArrayPrototypeSet(this.#buf, bytes, this.#end);
    this.#end += bytes.length;
  }

  #drain() {
    while (this.#start < this.#end) {
      const pending = this.#pending[0];
      const result = parseReply(
        this.#buf,
        this.#start,
        this.#end,
        pending?.asBytes ?? false,
        0,
      );
      if (result === null) break;
      this.#start = result[1];
      if (this.#pushMode) {
        this.#onPush(result[0]);
        continue;
      }
      if (pending === undefined) {
        throw new ProtocolError(
          "Unexpected Redis reply with no command waiting",
        );
      }
      ArrayPrototypeShift(this.#pending);
      if (ObjectPrototypeIsPrototypeOf(RedisErrorPrototype, result[0])) {
        pending.reject(result[0]);
      } else pending.resolve(result[0]);
    }
    if (this.#start === this.#end) this.#start = this.#end = 0;
  }

  #enqueue(bytes, pending) {
    if (this.#closed) {
      throw new Error("The Redis connection is closed");
    }
    if (pending !== undefined) ArrayPrototypePush(this.#pending, pending);
    // Writes are chained so commands reach the server in call order.
    this.#write = PromisePrototypeThen(this.#write, async () => {
      let written = 0;
      while (written < bytes.length) {
        written += await this.#conn.write(
          TypedArrayPrototypeSubarray(bytes, written),
        );
      }
    });
    PromisePrototypeThen(this.#write, undefined, (error) => {
      this.#closeError ??= error;
      try {
        this.#conn.close();
      } catch {
        // Already closed.
      }
    });
  }

  /** Sends a command and resolves to its reply: strings, integers, arrays,
   * `null`. Error replies reject with a `RedisError`. */
  send(command, ...args) {
    return this.#command(command, args, false);
  }

  /** Like `send()`, with bulk strings as `Uint8Array`s instead of text. */
  sendBytes(command, ...args) {
    return this.#command(command, args, true);
  }

  #command(command, args, asBytes) {
    if (typeof command !== "string" || command === "") {
      return PromiseReject(new TypeError("A Redis command must be a string"));
    }
    let bytes;
    try {
      bytes = encode(command, args);
    } catch (error) {
      return PromiseReject(error);
    }
    const pending = new Pending(asBytes);
    try {
      this.#enqueue(bytes, pending);
    } catch (error) {
      return PromiseReject(error);
    }
    return pending.promise;
  }

  /** From here on, every reply is a pub/sub message. */
  _enterPushMode() {
    this.#pushMode = true;
  }

  /** Writes a command without expecting a reply (pub/sub connections). */
  _sendRaw(command, args) {
    this.#enqueue(encode(command, args), undefined);
  }

  /** Starts a pipeline. With `transaction`, the commands run atomically
   * between MULTI and EXEC. */
  pipeline(options = { __proto__: null }) {
    return new Pipeline(this, !!options.transaction);
  }

  ping(message) {
    return message === undefined
      ? this.send("PING")
      : this.send("PING", message);
  }
  get(key) {
    return this.send("GET", key);
  }
  /** `options`: `ex`/`px` (expiry in seconds/milliseconds), `exat`/`pxat`,
   * `keepTtl`, `nx`, `xx`. Resolves to `"OK"`, or `null` when `nx`/`xx`
   * kept the value from being set. */
  set(key, value, options = { __proto__: null }) {
    const args = [key, value];
    for (const { 0: name, 1: flag } of new SafeArrayIterator(SET_OPTIONS)) {
      const option = options[name];
      if (option === undefined || option === false) continue;
      ArrayPrototypePush(args, flag);
      if (option !== true) ArrayPrototypePush(args, option);
    }
    return this.send("SET", ...new SafeArrayIterator(args));
  }
  del(...keys) {
    return this.send("DEL", ...new SafeArrayIterator(keys));
  }
  async exists(...keys) {
    return await this.send("EXISTS", ...new SafeArrayIterator(keys)) > 0;
  }
  expire(key, seconds) {
    return this.send("EXPIRE", key, seconds);
  }
  ttl(key) {
    return this.send("TTL", key);
  }
  incr(key) {
    return this.send("INCR", key);
  }
  incrBy(key, amount) {
    return this.send("INCRBY", key, amount);
  }
  decr(key) {
    return this.send("DECR", key);
  }
  mget(...keys) {
    return this.send("MGET", ...new SafeArrayIterator(keys));
  }
  mset(entries) {
    const args = [];
    for (
      const { 0: key, 1: value } of new SafeArrayIterator(
        ObjectEntries(entries),
      )
    ) {
      ArrayPrototypePush(args, key, value);
    }
    return this.send("MSET", ...new SafeArrayIterator(args));
  }
  hget(key, field) {
    return this.send("HGET", key, field);
  }
  hset(key, fields) {
    const args = [key];
    for (
      const { 0: field, 1: value } of new SafeArrayIterator(
        ObjectEntries(fields),
      )
    ) {
      ArrayPrototypePush(args, field, value);
    }
    return this.send("HSET", ...new SafeArrayIterator(args));
  }
  async hgetall(key) {
    const flat = await this.send("HGETALL", key);
    const entries = [];
    for (let i = 0; i < flat.length; i += 2) {
      ArrayPrototypePush(entries, [flat[i], flat[i + 1]]);
    }
    return ObjectFromEntries(entries);
  }
  hdel(key, ...fields) {
    return this.send("HDEL", key, ...new SafeArrayIterator(fields));
  }
  lpush(key, ...values) {
    return this.send("LPUSH", key, ...new SafeArrayIterator(values));
  }
  rpush(key, ...values) {
    return this.send("RPUSH", key, ...new SafeArrayIterator(values));
  }
  lpop(key) {
    return this.send("LPOP", key);
  }
  rpop(key) {
    return this.send("RPOP", key);
  }
  llen(key) {
    return this.send("LLEN", key);
  }
  lrange(key, start, stop) {
    return this.send("LRANGE", key, start, stop);
  }
  sadd(key, ...members) {
    return this.send("SADD", key, ...new SafeArrayIterator(members));
  }
  srem(key, ...members) {
    return this.send("SREM", key, ...new SafeArrayIterator(members));
  }
  smembers(key) {
    return this.send("SMEMBERS", key);
  }
  async sismember(key, member) {
    return await this.send("SISMEMBER", key, member) === 1;
  }
  publish(channel, message) {
    return this.send("PUBLISH", channel, message);
  }

  /** Iterates the keys matching `match`, using SCAN, so a large database
   * isn't blocked. */
  async *scan(options = { __proto__: null }) {
    let cursor = "0";
    do {
      const args = [cursor];
      if (options.match !== undefined) {
        ArrayPrototypePush(args, "MATCH", options.match);
      }
      if (options.count !== undefined) {
        ArrayPrototypePush(args, "COUNT", options.count);
      }
      if (options.type !== undefined) {
        ArrayPrototypePush(args, "TYPE", options.type);
      }
      const reply = await this.send("SCAN", ...new SafeArrayIterator(args));
      cursor = reply[0];
      for (let i = 0; i < reply[1].length; i++) yield reply[1][i];
    } while (cursor !== "0");
  }

  /** Subscribes to channels, and to patterns with `patterns` (such as
   * `"news.*"`), on a new connection. Resolves once the server has
   * confirmed every subscription. */
  async subscribe(channels, options = { __proto__: null }) {
    const list = typeof channels === "string" ? [channels] : channels ?? [];
    const patterns = typeof options.patterns === "string"
      ? [options.patterns]
      : options.patterns ?? [];
    if (!ArrayIsArray(list) || !ArrayIsArray(patterns)) {
      throw new TypeError("channels and patterns must be strings or arrays");
    }
    return await Subscription.open(this.#config, list, patterns);
  }

  #config;
  _setConfig(config) {
    this.#config = config;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }

  [SymbolDispose]() {
    this.close();
  }
}

const SET_OPTIONS = [
  ["ex", "EX"],
  ["px", "PX"],
  ["exat", "EXAT"],
  ["pxat", "PXAT"],
  ["keepTtl", "KEEPTTL"],
  ["nx", "NX"],
  ["xx", "XX"],
  ["get", "GET"],
];

class Pipeline {
  #client;
  #transaction;
  #commands = [];
  constructor(client, transaction) {
    this.#client = client;
    this.#transaction = transaction;
  }
  /** Adds a command. Returns the pipeline, so calls chain. */
  send(command, ...args) {
    ArrayPrototypePush(this.#commands, [command, args]);
    return this;
  }
  /** Sends everything at once. Resolves to one result per command, in order;
   * a command that fails has its `RedisError` in its place instead of
   * rejecting the whole pipeline. A transaction resolves to the results of
   * its commands, or `null` if a `WATCH` aborted it. */
  async exec() {
    const commands = this.#commands;
    this.#commands = [];
    const client = this.#client;
    const replies = [];
    const track = (promise) =>
      ArrayPrototypePush(
        replies,
        PromisePrototypeThen(promise, (value) => value, (error) => error),
      );
    if (this.#transaction) track(client.send("MULTI"));
    for (let i = 0; i < commands.length; i++) {
      track(
        client.send(commands[i][0], ...new SafeArrayIterator(commands[i][1])),
      );
    }
    if (this.#transaction) track(client.send("EXEC"));
    const results = await SafePromiseAll(replies);
    if (!this.#transaction) return results;
    const exec = results[results.length - 1];
    if (ObjectPrototypeIsPrototypeOf(RedisErrorPrototype, exec)) throw exec;
    return exec;
  }
}

/** Messages from `subscribe()`. */
class Subscription {
  #client;
  #queue = [];
  #waiting = [];
  #done = false;
  #error;
  #acks = 0;
  #ackWaiter;

  static async open(config, channels, patterns) {
    const subscription = new Subscription();
    subscription.#client = await RedisClient.open(
      config,
      (reply, error) => subscription.#onPush(reply, error),
    );
    const expected = channels.length + patterns.length;
    if (expected === 0) return subscription;
    subscription.#client._enterPushMode();
    const acked = PromiseWithResolvers();
    subscription.#ackWaiter = { remaining: expected, resolve: acked.resolve };
    if (channels.length > 0) {
      subscription.#client._sendRaw("SUBSCRIBE", channels);
    }
    if (patterns.length > 0) {
      subscription.#client._sendRaw("PSUBSCRIBE", patterns);
    }
    try {
      await acked.promise;
    } catch (error) {
      subscription.close();
      throw error;
    }
    return subscription;
  }

  #onPush(reply, error) {
    if (reply === null) {
      this.#done = true;
      this.#error = error;
      if (this.#ackWaiter) this.#ackWaiter.resolve();
      for (const waiter of new SafeArrayIterator(this.#waiting)) {
        waiter.resolve({ value: undefined, done: true });
      }
      this.#waiting = [];
      return;
    }
    if (ObjectPrototypeIsPrototypeOf(RedisErrorPrototype, reply)) {
      this.#error = reply;
      this.close();
      return;
    }
    if (!ArrayIsArray(reply)) return;
    const kind = reply[0];
    if (kind === "subscribe" || kind === "psubscribe") {
      this.#acks++;
      const waiter = this.#ackWaiter;
      if (waiter && --waiter.remaining === 0) waiter.resolve();
      return;
    }
    let message;
    if (kind === "message") {
      message = { channel: reply[1], message: reply[2] };
    } else if (kind === "pmessage") {
      message = { pattern: reply[1], channel: reply[2], message: reply[3] };
    } else {
      return;
    }
    const waiter = ArrayPrototypeShift(this.#waiting);
    if (waiter) waiter.resolve({ value: message, done: false });
    else ArrayPrototypePush(this.#queue, message);
  }

  /** Resolves with the next message, or `null` once closed. */
  next() {
    return this.#take();
  }

  async #take() {
    if (this.#queue.length > 0) return ArrayPrototypeShift(this.#queue);
    if (this.#done) {
      if (this.#error) throw this.#error;
      return null;
    }
    const waiter = PromiseWithResolvers();
    ArrayPrototypePush(this.#waiting, { resolve: waiter.resolve });
    const result = await waiter.promise;
    if (result.done && this.#error) throw this.#error;
    return result.done ? null : result.value;
  }

  [SymbolAsyncIterator]() {
    return {
      next: async () => {
        const value = await this.#take();
        return value === null
          ? { value: undefined, done: true }
          : { value, done: false };
      },
      return: () => {
        this.close();
        return PromiseResolve({ value: undefined, done: true });
      },
    };
  }

  close() {
    this.#client.close();
  }

  [SymbolDispose]() {
    this.close();
  }
}

async function connectRedis(target = { __proto__: null }, options) {
  const config = parseOptions(target, options);
  const client = await RedisClient.open(config);
  client._setConfig(config);
  return client;
}

const redis = ObjectFreeze({ connect: connectRedis });

return { redis, RedisClient, RedisError };
})();
