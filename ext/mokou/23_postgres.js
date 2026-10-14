// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.postgres`: a PostgreSQL client speaking the version 3 wire protocol:
// SCRAM-SHA-256, MD5 and cleartext logins, TLS, parameterized queries,
// transactions and LISTEN/NOTIFY. Values travel in text format and are
// converted to JavaScript values by column type.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_hash_digest,
  op_done_hash_digest_string,
  op_done_hmac_sha256,
} = core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  BigInt,
  DataView,
  DataViewPrototypeGetInt16,
  DataViewPrototypeGetInt32,
  DataViewPrototypeSetInt16,
  DataViewPrototypeSetInt32,
  Date,
  DatePrototype,
  DatePrototypeGetTime,
  DatePrototypeToISOString,
  Error,
  JSONParse,
  JSONStringify,
  MathMax,
  MapPrototypeGet,
  MapPrototypeSet,
  NumberIsNaN,
  NumberIsSafeInteger,
  NumberParseFloat,
  NumberParseInt,
  NumberPrototypeToString,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  PromiseWithResolvers,
  RegExpPrototypeExec,
  SafeArrayIterator,
  SafeMap,
  SafeRegExp,
  SafeSet,
  SafeSetIterator,
  SetPrototypeAdd,
  SetPrototypeDelete,
  String,
  StringFromCharCode,
  StringPrototypeCharCodeAt,
  StringPrototypeIncludes,
  StringPrototypeIndexOf,
  StringPrototypeReplace,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  Symbol,
  SymbolDispose,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  TypedArrayPrototypeSet,
  TypedArrayPrototypeSubarray,
  Uint8Array,
  Uint8ArrayPrototype,
  decodeURIComponent,
} = primordials;
const { connect } = core.loadExtScript("ext:deno_net/01_net.js");
const { startTls } = core.loadExtScript("ext:deno_net/02_tls.js");
const { URL, URLPrototype } = core.loadExtScript("ext:deno_web/00_url.js");
const { forgivingBase64Decode, forgivingBase64Encode } = core.loadExtScript(
  "ext:deno_web/00_infra.js",
);

const constructorKey = Symbol("PostgresClient");
const decoder = new TextDecoder();
const MAX_SCRAM_ITERATIONS = 1 << 20;

/** An error reported by the server. */
class PostgresError extends Error {
  name = "PostgresError";
  /** The SQLSTATE code, such as `"23505"` for a unique violation. */
  code;
  severity;
  detail;
  hint;
  position;
  schema;
  table;
  column;
  constraint;
  routine;
  constructor(fields) {
    super(fields.M ?? "Unknown PostgreSQL error");
    this.code = fields.C;
    this.severity = fields.S;
    this.detail = fields.D;
    this.hint = fields.H;
    this.position = fields.P;
    this.schema = fields.s;
    this.table = fields.t;
    this.column = fields.c;
    this.constraint = fields.n;
    this.routine = fields.R;
  }
}

// --- message building ---------------------------------------------------------

class Writer {
  #buf = new Uint8Array(128);
  #len = 0;
  #ensure(extra) {
    if (this.#len + extra <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#len + extra) size *= 2;
    const grown = new Uint8Array(size);
    TypedArrayPrototypeSet(
      grown,
      TypedArrayPrototypeSubarray(this.#buf, 0, this.#len),
      0,
    );
    this.#buf = grown;
  }
  byte(value) {
    this.#ensure(1);
    this.#buf[this.#len++] = value;
    return this;
  }
  int16(value) {
    this.#ensure(2);
    DataViewPrototypeSetInt16(
      new DataView(TypedArrayPrototypeGetBuffer(this.#buf)),
      this.#len,
      value,
    );
    this.#len += 2;
    return this;
  }
  int32(value) {
    this.#ensure(4);
    DataViewPrototypeSetInt32(
      new DataView(TypedArrayPrototypeGetBuffer(this.#buf)),
      this.#len,
      value,
    );
    this.#len += 4;
    return this;
  }
  bytes(value) {
    this.#ensure(value.length);
    TypedArrayPrototypeSet(this.#buf, value, this.#len);
    this.#len += value.length;
    return this;
  }
  cstring(value) {
    const bytes = core.encode(value);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        throw new TypeError("PostgreSQL text can't contain NUL characters");
      }
    }
    return this.bytes(bytes).byte(0);
  }
  /** The body so far. */
  body() {
    return TypedArrayPrototypeSubarray(this.#buf, 0, this.#len);
  }
}

/** A message: its type byte, then its length (which counts itself). */
function frame(type, body) {
  const out = new Uint8Array(5 + body.length);
  out[0] = StringPrototypeCharCodeAt(type, 0);
  DataViewPrototypeSetInt32(
    new DataView(TypedArrayPrototypeGetBuffer(out)),
    1,
    4 + body.length,
  );
  TypedArrayPrototypeSet(out, body, 5);
  return out;
}

function concat(parts) {
  let size = 0;
  for (let i = 0; i < parts.length; i++) size += parts[i].length;
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    TypedArrayPrototypeSet(out, parts[i], at);
    at += parts[i].length;
  }
  return out;
}

// --- values -------------------------------------------------------------------

function quoteArrayElement(text) {
  return `"${
    StringPrototypeReplace(
      StringPrototypeReplace(text, BACKSLASH, "\\\\"),
      QUOTE,
      '\\"',
    )
  }"`;
}
const BACKSLASH = new SafeRegExp("\\\\", "g");
const QUOTE = new SafeRegExp('"', "g");

function bytesToHex(bytes) {
  let out = "\\x";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? "0" : "") + NumberPrototypeToString(bytes[i], 16);
  }
  return out;
}

/** A JavaScript value as the text of a query parameter, or null for NULL. */
function encodeParam(value) {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return String(value);
    case "bigint":
      return String(value);
    case "boolean":
      return value ? "t" : "f";
  }
  if (ObjectPrototypeIsPrototypeOf(DatePrototype, value)) {
    return DatePrototypeToISOString(value);
  }
  if (ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, value)) {
    return bytesToHex(value);
  }
  if (ArrayIsArray(value)) {
    const items = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item === null || item === undefined) {
        ArrayPrototypePush(items, "NULL");
      } else if (ArrayIsArray(item)) {
        ArrayPrototypePush(items, encodeParam(item));
      } else {
        ArrayPrototypePush(
          items,
          quoteArrayElement(
            typeof item === "object" &&
              !ObjectPrototypeIsPrototypeOf(DatePrototype, item) &&
              !ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, item)
              ? JSONStringify(item)
              : encodeParam(item),
          ),
        );
      }
    }
    return `{${ArrayPrototypeJoin(items, ",")}}`;
  }
  if (typeof value === "object") return JSONStringify(value);
  throw new TypeError(`Unsupported query parameter: ${String(value)}`);
}

function parseHexBytea(text) {
  if (!StringPrototypeStartsWith(text, "\\x")) return text;
  const out = new Uint8Array((text.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = NumberParseInt(
      StringPrototypeSlice(text, 2 + i * 2, 4 + i * 2),
      16,
    );
  }
  return out;
}

const TZ_SUFFIX = new SafeRegExp("([+-]\\d\\d)(?::?(\\d\\d))?(?::?(\\d\\d))?$");

function parseTimestamp(text, withZone) {
  let iso = StringPrototypeReplace(text, " ", "T");
  if (withZone) {
    const match = RegExpPrototypeExec(TZ_SUFFIX, iso);
    if (match === null) return text;
    iso = `${StringPrototypeSlice(iso, 0, match.index)}${match[1]}:${
      match[2] ?? "00"
    }`;
  } else {
    iso += "Z";
  }
  const time = new Date(iso);
  return NumberIsNaN(DatePrototypeGetTime(time)) ? text : time;
}

function parseInt8(text) {
  const value = NumberParseInt(text, 10);
  return NumberIsSafeInteger(value) ? value : BigInt(text);
}

function parseFloat8(text) {
  switch (text) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
  }
  return NumberParseFloat(text);
}

/** Decoders for text-format values, by type OID. Anything else stays text. */
const DECODERS = new SafeMap();
function decoderFor(oid, fn) {
  MapPrototypeSet(DECODERS, oid, fn);
}
for (const oid of new SafeArrayIterator([21, 23, 26])) {
  decoderFor(oid, (t) => NumberParseInt(t, 10));
}
decoderFor(20, parseInt8);
decoderFor(700, parseFloat8);
decoderFor(701, parseFloat8);
decoderFor(16, (t) => t === "t");
decoderFor(114, JSONParse);
decoderFor(3802, JSONParse);
decoderFor(17, parseHexBytea);
decoderFor(1082, (t) => {
  const date = new Date(`${t}T00:00:00Z`);
  return NumberIsNaN(DatePrototypeGetTime(date)) ? t : date;
});
decoderFor(1114, (t) => parseTimestamp(t, false));
decoderFor(1184, (t) => parseTimestamp(t, true));

/** Array type OID -> element type OID. */
const ARRAY_ELEMENTS = new SafeMap([
  [1000, 16],
  [1001, 17],
  [1005, 21],
  [1007, 23],
  [1016, 20],
  [1021, 700],
  [1022, 701],
  [1009, 25],
  [1015, 1043],
  [1014, 1042],
  [1182, 1082],
  [1115, 1114],
  [1185, 1184],
  [1231, 1700],
  [2951, 2950],
  [199, 114],
  [3807, 3802],
]);

/** Parses `{a,"b c",NULL,{1,2}}`. */
function parseArray(text, convert) {
  let pos = 0;
  function parseLevel() {
    if (text[pos] !== "{") throw new Error("Malformed PostgreSQL array");
    pos++;
    const items = [];
    if (text[pos] === "}") {
      pos++;
      return items;
    }
    while (true) {
      const char = text[pos];
      if (char === "{") {
        ArrayPrototypePush(items, parseLevel());
      } else if (char === '"') {
        pos++;
        let value = "";
        while (text[pos] !== '"') {
          if (pos >= text.length) throw new Error("Malformed PostgreSQL array");
          if (text[pos] === "\\") pos++;
          value += text[pos++];
        }
        pos++;
        ArrayPrototypePush(items, convert(value));
      } else {
        const start = pos;
        while (text[pos] !== "," && text[pos] !== "}") {
          if (pos >= text.length) throw new Error("Malformed PostgreSQL array");
          pos++;
        }
        const raw = StringPrototypeSlice(text, start, pos);
        ArrayPrototypePush(items, raw === "NULL" ? null : convert(raw));
      }
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "}") {
        pos++;
        return items;
      }
      throw new Error("Malformed PostgreSQL array");
    }
  }
  // Arrays with explicit bounds start `[1:3]={...}`.
  if (text[0] === "[") pos = StringPrototypeIndexOf(text, "=") + 1;
  return parseLevel();
}

function converterFor(oid) {
  const element = MapPrototypeGet(ARRAY_ELEMENTS, oid);
  if (element !== undefined) {
    const inner = converterFor(element);
    return (text) => parseArray(text, inner);
  }
  return MapPrototypeGet(DECODERS, oid) ?? ((text) => text);
}

// --- SCRAM-SHA-256 ------------------------------------------------------------

function hmac(key, data) {
  return op_done_hmac_sha256(
    typeof key === "string" ? core.encode(key) : key,
    typeof data === "string" ? core.encode(data) : data,
  );
}

function sha256(data) {
  return op_done_hash_digest("sha256", data);
}

/** PBKDF2 with HMAC-SHA-256 and one 32-byte block, as SCRAM's `Hi()`. */
function hi(password, salt, iterations) {
  const first = new Uint8Array(salt.length + 4);
  TypedArrayPrototypeSet(first, salt, 0);
  first[first.length - 1] = 1;
  let u = hmac(password, first);
  const result = new Uint8Array(u);
  for (let i = 1; i < iterations; i++) {
    u = hmac(password, u);
    for (let j = 0; j < 32; j++) result[j] ^= u[j];
  }
  return result;
}

function xor(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function scramAttributes(message) {
  const out = { __proto__: null };
  const parts = StringPrototypeSplit(message, ",");
  for (let i = 0; i < parts.length; i++) {
    out[parts[i][0]] = StringPrototypeSlice(parts[i], 2);
  }
  return out;
}

class Scram {
  #password;
  #nonce;
  #clientFirstBare;
  #serverSignature;

  constructor(password) {
    this.#password = password;
    const random = new Uint8Array(18);
    crypto.getRandomValues(random);
    this.#nonce = forgivingBase64Encode(random);
    this.#clientFirstBare = `n=,r=${this.#nonce}`;
  }

  first() {
    return `n,,${this.#clientFirstBare}`;
  }

  /** Answers the server's first message with the client's proof. */
  final(serverFirst) {
    const attrs = scramAttributes(serverFirst);
    const iterations = NumberParseInt(attrs.i, 10);
    if (
      !StringPrototypeStartsWith(attrs.r ?? "", this.#nonce) ||
      !(iterations > 0) || iterations > MAX_SCRAM_ITERATIONS || !attrs.s
    ) {
      throw new Error("The server sent an invalid SCRAM challenge");
    }
    const salted = hi(
      this.#password,
      forgivingBase64Decode(attrs.s),
      iterations,
    );
    const withoutProof = `c=biws,r=${attrs.r}`;
    const authMessage =
      `${this.#clientFirstBare},${serverFirst},${withoutProof}`;
    const clientKey = hmac(salted, "Client Key");
    const proof = xor(clientKey, hmac(sha256(clientKey), authMessage));
    this.#serverSignature = forgivingBase64Encode(
      hmac(hmac(salted, "Server Key"), authMessage),
    );
    return `${withoutProof},p=${forgivingBase64Encode(proof)}`;
  }

  verify(serverFinal) {
    const attrs = scramAttributes(serverFinal);
    if (attrs.e !== undefined) throw new Error(`SCRAM error: ${attrs.e}`);
    if (attrs.v !== this.#serverSignature) {
      throw new Error("The server's SCRAM signature did not match");
    }
  }
}

// --- connection options -------------------------------------------------------

function parseTarget(target, options) {
  let config;
  if (
    typeof target === "string" ||
    ObjectPrototypeIsPrototypeOf(URLPrototype, target)
  ) {
    const url = new URL(`${target}`);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new TypeError(
        `Unsupported protocol ${url.protocol}; expected postgres: or postgresql:`,
      );
    }
    const params = url.searchParams;
    const sslmode = params.get("sslmode");
    config = {
      hostname: url.hostname === ""
        ? undefined
        : decodeURIComponent(url.hostname),
      port: url.port === "" ? undefined : NumberParseInt(url.port, 10),
      username: url.username === ""
        ? undefined
        : decodeURIComponent(url.username),
      password: url.password === ""
        ? undefined
        : decodeURIComponent(url.password),
      database: url.pathname.length > 1
        ? decodeURIComponent(StringPrototypeSlice(url.pathname, 1))
        : undefined,
      ssl: sslmode === null
        ? undefined
        : sslmode === "disable"
        ? false
        : sslmode,
      applicationName: params.get("application_name") ?? undefined,
      ...options,
    };
  } else if (target !== null && typeof target === "object") {
    config = { ...target };
  } else {
    throw new TypeError(
      "Deno.postgres.connect() expects a URL or an options object",
    );
  }
  config.hostname ??= "127.0.0.1";
  config.port ??= 5432;
  if (config.username === undefined) {
    throw new TypeError("A username is required to connect to PostgreSQL");
  }
  config.database ??= config.username;
  config.ssl ??= "prefer";
  if (
    config.ssl !== false && config.ssl !== true && config.ssl !== "prefer" &&
    config.ssl !== "require" && config.ssl !== "verify-full" &&
    config.ssl !== "verify-ca" && config.ssl !== "allow"
  ) {
    throw new TypeError(`Unsupported ssl setting: ${String(config.ssl)}`);
  }
  return config;
}

// --- the client ---------------------------------------------------------------

function commandInfo(tag) {
  const parts = StringPrototypeSplit(tag, " ");
  const last = parts[parts.length - 1];
  const count = NumberParseInt(last, 10);
  return { command: parts[0], count: NumberIsNaN(count) ? 0 : count };
}

function parseFields(body) {
  const view = new DataView(
    TypedArrayPrototypeGetBuffer(body),
    TypedArrayPrototypeGetByteOffset(body),
    TypedArrayPrototypeGetByteLength(body),
  );
  const count = DataViewPrototypeGetInt16(view, 0);
  const fields = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    let end = at;
    while (body[end] !== 0) end++;
    const name = decoder.decode(TypedArrayPrototypeSubarray(body, at, end));
    at = end + 1;
    const typeOid = DataViewPrototypeGetInt32(view, at + 6);
    at += 18;
    ArrayPrototypePush(fields, {
      name,
      typeOid,
      convert: converterFor(typeOid),
    });
  }
  return fields;
}

function parseRow(body, fields) {
  const view = new DataView(
    TypedArrayPrototypeGetBuffer(body),
    TypedArrayPrototypeGetByteOffset(body),
    TypedArrayPrototypeGetByteLength(body),
  );
  const count = DataViewPrototypeGetInt16(view, 0);
  const row = {};
  let at = 2;
  for (let i = 0; i < count; i++) {
    const length = DataViewPrototypeGetInt32(view, at);
    at += 4;
    let value = null;
    if (length >= 0) {
      value = fields[i].convert(
        decoder.decode(TypedArrayPrototypeSubarray(body, at, at + length)),
      );
      at += length;
    }
    ObjectDefineProperty(row, fields[i].name, {
      __proto__: null,
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return row;
}

function parseErrorFields(body) {
  const fields = { __proto__: null };
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const code = StringFromCharCode(body[at]);
    let end = at + 1;
    while (body[end] !== 0) end++;
    fields[code] = decoder.decode(
      TypedArrayPrototypeSubarray(body, at + 1, end),
    );
    at = end + 1;
  }
  return fields;
}

class PostgresClient {
  #conn;
  #config;
  #buf = new Uint8Array(8192);
  #start = 0;
  #end = 0;
  #closed = false;
  #closedPromise;
  #closeError;
  // What the connection is doing: the startup, or one operation.
  #startup;
  #op;
  #lock = PromiseResolve();
  #listeners = new SafeMap();
  #scram;

  constructor(key, conn, config) {
    if (key !== constructorKey) throw new TypeError("Illegal constructor");
    this.#conn = conn;
    this.#config = config;
    this.#startup = PromiseWithResolvers();
    this.#closedPromise = this.#readLoop();
  }

  static async open(config) {
    let conn;
    if (StringPrototypeStartsWith(config.hostname, "/")) {
      conn = await connect({
        transport: "unix",
        path: `${config.hostname}/.s.PGSQL.${config.port}`,
      });
    } else {
      conn = await connect({ hostname: config.hostname, port: config.port });
      // Small writes shouldn't wait for the peer's delayed acknowledgement.
      conn.setNoDelay(true);
      if (config.ssl !== false) conn = await negotiateTls(conn, config);
    }
    const client = new PostgresClient(constructorKey, conn, config);
    const startup = new Writer().int32(196608)
      .cstring("user").cstring(config.username)
      .cstring("database").cstring(config.database)
      .cstring("client_encoding").cstring("UTF8");
    if (config.applicationName !== undefined) {
      startup.cstring("application_name").cstring(config.applicationName);
    }
    startup.byte(0);
    const body = startup.body();
    const message = new Uint8Array(4 + body.length);
    DataViewPrototypeSetInt32(
      new DataView(TypedArrayPrototypeGetBuffer(message)),
      0,
      message.length,
    );
    TypedArrayPrototypeSet(message, body, 4);
    client.#write(message);
    try {
      await client.#startup.promise;
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  /** Settles when the connection has closed. */
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
      this.#closeConn();
      const error = this.#closeError ??
        new Error("The PostgreSQL connection is closed");
      this.#startup?.reject(error);
      this.#op?.reject(error);
      this.#op = undefined;
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
    while (this.#end - this.#start >= 5) {
      const view = new DataView(
        TypedArrayPrototypeGetBuffer(this.#buf),
        TypedArrayPrototypeGetByteOffset(this.#buf) + this.#start,
        this.#end - this.#start,
      );
      const length = DataViewPrototypeGetInt32(view, 1);
      if (length < 4) throw new Error("Invalid PostgreSQL message length");
      if (this.#end - this.#start < 1 + length) break;
      const type = StringFromCharCode(this.#buf[this.#start]);
      const body = TypedArrayPrototypeSubarray(
        this.#buf,
        this.#start + 5,
        this.#start + 1 + length,
      );
      this.#start += 1 + length;
      this.#onMessage(type, body);
    }
    if (this.#start === this.#end) this.#start = this.#end = 0;
  }

  #closeConn() {
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }

  #write(bytes) {
    if (this.#closed) throw new Error("The PostgreSQL connection is closed");
    this.#writing = PromisePrototypeThen(this.#writing, async () => {
      let written = 0;
      while (written < bytes.length) {
        written += await this.#conn.write(
          TypedArrayPrototypeSubarray(bytes, written),
        );
      }
    });
    PromisePrototypeThen(this.#writing, undefined, (error) => {
      this.#closeError ??= error;
      this.#closeConn();
    });
  }
  #writing = PromiseResolve();

  #onMessage(type, body) {
    switch (type) {
      case "R":
        this.#onAuth(body);
        return;
      case "E": {
        const error = new PostgresError(parseErrorFields(body));
        if (this.#startup !== undefined) {
          this.#startup.reject(error);
          this.#startup = undefined;
        } else if (this.#op !== undefined && this.#op.error === undefined) {
          this.#op.error = error;
        }
        return;
      }
      case "Z":
        if (this.#startup !== undefined) {
          this.#startup.resolve();
          this.#startup = undefined;
        } else if (this.#op !== undefined) {
          const op = this.#op;
          this.#op = undefined;
          if (op.error !== undefined) op.reject(op.error);
          else op.resolve(op.results);
        }
        return;
      case "A": {
        // NotificationResponse: pid, channel, payload.
        const channelEnd = StringPrototypeIndexOf(
          decoder.decode(TypedArrayPrototypeSubarray(body, 4)),
          "\0",
        );
        const text = decoder.decode(TypedArrayPrototypeSubarray(body, 4));
        const channel = StringPrototypeSlice(text, 0, channelEnd);
        const payload = StringPrototypeSlice(
          text,
          channelEnd + 1,
          text.length - 1,
        );
        const handlers = MapPrototypeGet(this.#listeners, channel);
        if (handlers !== undefined) {
          for (const handler of new SafeSetIterator(handlers)) {
            try {
              handler(payload, channel);
            } catch {
              // A listener's error isn't the connection's problem.
            }
          }
        }
        return;
      }
    }
    const op = this.#op;
    if (op === undefined) return;
    switch (type) {
      case "T":
        op.fields = parseFields(body);
        op.rows = [];
        return;
      case "D":
        ArrayPrototypePush(op.rows, parseRow(body, op.fields));
        return;
      case "n":
        op.fields = [];
        op.rows = [];
        return;
      case "C": {
        const tag = decoder.decode(
          TypedArrayPrototypeSubarray(body, 0, body.length - 1),
        );
        ArrayPrototypePush(op.results, {
          rows: op.rows ?? [],
          fields: ArrayPrototypeMap(
            op.fields ?? [],
            (f) => ({ name: f.name, typeOid: f.typeOid }),
          ),
          ...commandInfo(tag),
        });
        op.fields = undefined;
        op.rows = undefined;
        return;
      }
      case "I":
        ArrayPrototypePush(op.results, {
          rows: [],
          fields: [],
          command: "",
          count: 0,
        });
        return;
    }
    // ParseComplete, BindComplete, ParameterStatus, NoticeResponse,
    // BackendKeyData and the like need no action.
  }

  #onAuth(body) {
    const view = new DataView(
      TypedArrayPrototypeGetBuffer(body),
      TypedArrayPrototypeGetByteOffset(body),
      TypedArrayPrototypeGetByteLength(body),
    );
    const code = DataViewPrototypeGetInt32(view, 0);
    const password = this.#config.password;
    const needPassword = () => {
      if (password === undefined) {
        throw new Error("The server asked for a password and none was given");
      }
    };
    try {
      switch (code) {
        case 0:
          return;
        case 3:
          needPassword();
          this.#write(frame("p", new Writer().cstring(password).body()));
          return;
        case 5: {
          needPassword();
          const salt = TypedArrayPrototypeSubarray(body, 4, 8);
          const inner = op_done_hash_digest_string(
            "md5",
            core.encode(password + this.#config.username),
            "hex",
          );
          const outer = op_done_hash_digest_string(
            "md5",
            concat([core.encode(inner), salt]),
            "hex",
          );
          this.#write(frame("p", new Writer().cstring(`md5${outer}`).body()));
          return;
        }
        case 10: {
          needPassword();
          const mechanisms = decoder.decode(
            TypedArrayPrototypeSubarray(body, 4),
          );
          if (!StringPrototypeIncludes(mechanisms, "SCRAM-SHA-256")) {
            throw new Error(
              "The server only offers SASL mechanisms this client doesn't support",
            );
          }
          this.#scram = new Scram(password);
          const first = core.encode(this.#scram.first());
          this.#write(frame(
            "p",
            new Writer().cstring("SCRAM-SHA-256").int32(first.length)
              .bytes(first).body(),
          ));
          return;
        }
        case 11: {
          const serverFirst = decoder.decode(
            TypedArrayPrototypeSubarray(body, 4),
          );
          this.#write(frame(
            "p",
            new Writer().bytes(core.encode(this.#scram.final(serverFirst)))
              .body(),
          ));
          return;
        }
        case 12:
          this.#scram.verify(
            decoder.decode(TypedArrayPrototypeSubarray(body, 4)),
          );
          return;
        default:
          throw new Error(
            `Unsupported PostgreSQL authentication method (${code})`,
          );
      }
    } catch (error) {
      this.#startup?.reject(error);
      this.#startup = undefined;
      this.close();
    }
  }

  // Runs one operation: writes `bytes`, resolves to its results.
  #run(bytes) {
    if (this.#closed) {
      return PromiseReject(new Error("The PostgreSQL connection is closed"));
    }
    const { promise, resolve, reject } = PromiseWithResolvers();
    this.#op = { results: [], resolve, reject, error: undefined };
    try {
      this.#write(bytes);
    } catch (error) {
      this.#op = undefined;
      return PromiseReject(error);
    }
    return promise;
  }

  async #withLock(fn) {
    const previous = this.#lock;
    const next = PromiseWithResolvers();
    this.#lock = next.promise;
    await previous;
    try {
      return await fn();
    } finally {
      next.resolve();
    }
  }

  #extended(text, params) {
    if (typeof text !== "string") {
      throw new TypeError("The query must be a string");
    }
    if (!ArrayIsArray(params)) {
      throw new TypeError("Query parameters must be an array");
    }
    const bind = new Writer().cstring("").cstring("").int16(0).int16(
      params.length,
    );
    for (let i = 0; i < params.length; i++) {
      const value = encodeParam(params[i]);
      if (value === null) {
        bind.int32(-1);
      } else {
        const bytes = core.encode(value);
        bind.int32(bytes.length).bytes(bytes);
      }
    }
    bind.int16(0);
    return concat([
      frame("P", new Writer().cstring("").cstring(text).int16(0).body()),
      frame("B", bind.body()),
      frame("D", new Writer().byte(80).cstring("").body()),
      frame("E", new Writer().cstring("").int32(0).body()),
      frame("S", new Uint8Array(0)),
    ]);
  }

  async #query(text, params) {
    const results = await this.#run(this.#extended(text, params));
    return results[0] ?? { rows: [], fields: [], command: "", count: 0 };
  }

  async #exec(text) {
    if (typeof text !== "string") {
      throw new TypeError("The SQL must be a string");
    }
    return await this.#run(frame("Q", new Writer().cstring(text).body()));
  }

  /** Runs one statement with `$1`-style parameters. Resolves to
   * `{ rows, fields, command, count }`. */
  query(text, params = []) {
    return this.#withLock(() => this.#query(text, params));
  }

  /** Runs a script of statements without parameters, and resolves to a
   * result for each statement. */
  exec(text) {
    return this.#withLock(() => this.#exec(text));
  }

  /** A tagged template: values become parameters, never SQL text. Resolves
   * to the rows. */
  sql = (strings, ...values) =>
    this.#withLock(() => this.#tagged(strings, values));

  async #tagged(strings, values) {
    return (await this.#query(buildTemplate(strings, values), values)).rows;
  }

  /** Runs `fn` in a transaction on this connection: `COMMIT` when it
   * returns, `ROLLBACK` when it throws. Other calls on the client wait
   * until it finishes, so use the `tx` argument inside, never the client. */
  transaction(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("transaction() expects a function");
    }
    return this.#withLock(async () => {
      await this.#exec("BEGIN");
      const tx = new Transaction(
        (text, params) => this.#query(text, params),
        (text) => this.#exec(text),
        (strings, values) => this.#tagged(strings, values),
      );
      try {
        const result = await fn(tx);
        tx._end();
        await this.#exec("COMMIT");
        return result;
      } catch (error) {
        tx._end();
        try {
          await this.#exec("ROLLBACK");
        } catch {
          // The connection is gone; the original error matters more.
        }
        throw error;
      }
    });
  }

  /** Calls `handler(payload, channel)` for each `NOTIFY` on `channel`.
   * Resolves to a function that stops listening. */
  async listen(channel, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("listen() expects a handler function");
    }
    let handlers = MapPrototypeGet(this.#listeners, channel);
    if (handlers === undefined) {
      handlers = new SafeSet();
      MapPrototypeSet(this.#listeners, channel, handlers);
      await this.exec(
        `LISTEN "${StringPrototypeReplace(channel, QUOTE, '""')}"`,
      );
    }
    SetPrototypeAdd(handlers, handler);
    return () => {
      SetPrototypeDelete(handlers, handler);
    };
  }

  close() {
    if (this.#closed) return;
    try {
      this.#write(frame("X", new Uint8Array(0)));
    } catch {
      // Nothing to say goodbye to.
    }
    this.#closed = true;
    PromisePrototypeThen(this.#writing, () => this.#closeConn(), () => {});
  }

  [SymbolDispose]() {
    this.close();
  }
}

function buildTemplate(strings, values) {
  if (!ArrayIsArray(strings) || strings.length !== values.length + 1) {
    throw new TypeError("sql must be used as a tagged template");
  }
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
  return text;
}

class Transaction {
  #query;
  #exec;
  #tagged;
  #ended = false;
  constructor(query, exec, tagged) {
    this.#query = query;
    this.#exec = exec;
    this.#tagged = tagged;
    this.sql = async (strings, ...values) => {
      this.#check();
      return await this.#tagged(strings, values);
    };
  }
  _end() {
    this.#ended = true;
  }
  #check() {
    if (this.#ended) {
      throw new Error("The transaction has already finished");
    }
  }
  async query(text, params = []) {
    this.#check();
    return await this.#query(text, params);
  }
  async exec(text) {
    this.#check();
    return await this.#exec(text);
  }
}

/** Asks the server for TLS, and upgrades the connection if it agrees. */
async function negotiateTls(conn, config) {
  const request = new Uint8Array(8);
  const view = new DataView(TypedArrayPrototypeGetBuffer(request));
  DataViewPrototypeSetInt32(view, 0, 8);
  DataViewPrototypeSetInt32(view, 4, 80877103);
  let written = 0;
  while (written < 8) {
    written += await conn.write(TypedArrayPrototypeSubarray(request, written));
  }
  const answer = new Uint8Array(1);
  if (await conn.read(answer) === null) {
    throw new Error(
      "The server closed the connection during the TLS handshake",
    );
  }
  if (answer[0] === 83) { // 'S'
    return await startTls(conn, {
      hostname: config.hostname,
      caCerts: config.caCerts ?? [],
    });
  }
  if (answer[0] === 78) { // 'N'
    if (
      config.ssl === "require" || config.ssl === true ||
      config.ssl === "verify-full" || config.ssl === "verify-ca"
    ) {
      conn.close();
      throw new Error(
        "The server does not support TLS, which this connection requires",
      );
    }
    return conn;
  }
  conn.close();
  throw new Error("Unexpected answer to the TLS request");
}

async function connectPostgres(target, options) {
  const config = parseTarget(target, options);
  return await PostgresClient.open(config);
}

const postgres = ObjectFreeze({ connect: connectPostgres });

return { postgres, PostgresClient, PostgresError };
})();
