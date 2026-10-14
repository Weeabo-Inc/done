// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.mysql`: a MySQL and MariaDB client speaking the client/server
// protocol: mysql_native_password and caching_sha2_password logins, TLS,
// server-side prepared statements (so parameters are never part of the SQL),
// transactions and multi-statement scripts. Results are converted to
// JavaScript values by column type.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_hash_digest } = core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeMap,
  ArrayPrototypeSome,
  ArrayPrototypePush,
  ArrayPrototypeShift,
  BigInt,
  BigIntAsIntN,
  DataView,
  DataViewPrototypeGetBigInt64,
  DataViewPrototypeGetBigUint64,
  DataViewPrototypeGetFloat32,
  DataViewPrototypeGetFloat64,
  DataViewPrototypeGetInt16,
  DataViewPrototypeGetInt32,
  DataViewPrototypeGetInt8,
  DataViewPrototypeGetUint16,
  DataViewPrototypeGetUint32,
  DataViewPrototypeGetUint8,
  DataViewPrototypeSetBigInt64,
  DataViewPrototypeSetFloat64,
  Date,
  DatePrototype,
  DatePrototypeGetTime,
  DatePrototypeGetUTCDate,
  DatePrototypeGetUTCFullYear,
  DatePrototypeGetUTCHours,
  DatePrototypeGetUTCMilliseconds,
  DatePrototypeGetUTCMinutes,
  DatePrototypeGetUTCMonth,
  DatePrototypeGetUTCSeconds,
  DatePrototypeSetUTCFullYear,
  DatePrototypeSetUTCHours,
  Error,
  JSONParse,
  JSONStringify,
  MathFloor,
  MathMax,
  NumberIsInteger,
  Number,
  NumberIsNaN,
  NumberIsSafeInteger,
  NumberParseFloat,
  NumberParseInt,
  NumberPrototypeToPrecision,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  PromisePrototypeThen,
  PromiseResolve,
  PromiseWithResolvers,
  String,
  StringPrototypePadStart,
  StringPrototypeSlice,
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

const constructorKey = Symbol("MysqlClient");
const textDecoder = new TextDecoder();
const MAX_PACKET = 0xffffff;

// Capability flags.
const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_LONG_FLAG = 0x4;
const CLIENT_CONNECT_WITH_DB = 0x8;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_SSL = 0x800;
const CLIENT_TRANSACTIONS = 0x2000;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_MULTI_STATEMENTS = 0x10000;
const CLIENT_MULTI_RESULTS = 0x20000;
const CLIENT_PS_MULTI_RESULTS = 0x40000;
const CLIENT_PLUGIN_AUTH = 0x80000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x200000;

const SERVER_MORE_RESULTS_EXISTS = 0x8;

// Column types.
const T = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
};
const FLAG_UNSIGNED = 0x20;
const BINARY_CHARSET = 63;

/** An error reported by the server. */
class MysqlError extends Error {
  name = "MysqlError";
  /** The MySQL error number, such as 1062 for a duplicate key. */
  errno;
  /** The five-character SQLSTATE, such as `"23000"`. */
  sqlState;
  constructor(message, errno, sqlState) {
    super(message);
    this.errno = errno;
    this.sqlState = sqlState;
  }
}

// --- bytes --------------------------------------------------------------------

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
    return this.byte(value & 0xff).byte((value >> 8) & 0xff);
  }
  int32(value) {
    return this.int16(value & 0xffff).int16((value >>> 16) & 0xffff);
  }
  int64(value) {
    this.#ensure(8);
    DataViewPrototypeSetBigInt64(
      new DataView(TypedArrayPrototypeGetBuffer(this.#buf)),
      this.#len,
      BigInt(value),
      true,
    );
    this.#len += 8;
    return this;
  }
  float64(value) {
    this.#ensure(8);
    DataViewPrototypeSetFloat64(
      new DataView(TypedArrayPrototypeGetBuffer(this.#buf)),
      this.#len,
      value,
      true,
    );
    this.#len += 8;
    return this;
  }
  bytes(value) {
    this.#ensure(value.length);
    TypedArrayPrototypeSet(this.#buf, value, this.#len);
    this.#len += value.length;
    return this;
  }
  cstring(text) {
    return this.bytes(core.encode(text)).byte(0);
  }
  lenenc(value) {
    if (value < 251) return this.byte(value);
    if (value < 0x10000) return this.byte(0xfc).int16(value);
    if (value < 0x1000000) {
      return this.byte(0xfd).byte(value & 0xff).byte((value >> 8) & 0xff)
        .byte((value >> 16) & 0xff);
    }
    return this.byte(0xfe).int64(value);
  }
  lenencBytes(value) {
    return this.lenenc(value.length).bytes(value);
  }
  body() {
    return TypedArrayPrototypeSubarray(this.#buf, 0, this.#len);
  }
}

class Cursor {
  #bytes;
  #view;
  pos = 0;
  constructor(bytes) {
    this.#bytes = bytes;
    this.#view = new DataView(
      TypedArrayPrototypeGetBuffer(bytes),
      TypedArrayPrototypeGetByteOffset(bytes),
      TypedArrayPrototypeGetByteLength(bytes),
    );
  }
  get length() {
    return this.#bytes.length;
  }
  get remaining() {
    return this.#bytes.length - this.pos;
  }
  byte() {
    return this.#bytes[this.pos++];
  }
  peek() {
    return this.#bytes[this.pos];
  }
  skip(n) {
    this.pos += n;
  }
  int16() {
    const v = DataViewPrototypeGetUint16(this.#view, this.pos, true);
    this.pos += 2;
    return v;
  }
  int32() {
    const v = DataViewPrototypeGetUint32(this.#view, this.pos, true);
    this.pos += 4;
    return v;
  }
  view() {
    return this.#view;
  }
  bytes(n) {
    const out = TypedArrayPrototypeSubarray(
      this.#bytes,
      this.pos,
      this.pos + n,
    );
    this.pos += n;
    return out;
  }
  rest() {
    return this.bytes(this.remaining);
  }
  cstring() {
    let end = this.pos;
    while (end < this.#bytes.length && this.#bytes[end] !== 0) end++;
    const text = textDecoder.decode(
      TypedArrayPrototypeSubarray(this.#bytes, this.pos, end),
    );
    this.pos = end + 1;
    return text;
  }
  /** A length-encoded integer; `null` for the NULL marker 0xfb. */
  lenenc() {
    const first = this.byte();
    if (first < 251) return first;
    if (first === 0xfb) return null;
    if (first === 0xfc) return this.int16();
    if (first === 0xfd) {
      const v = this.#bytes[this.pos] | (this.#bytes[this.pos + 1] << 8) |
        (this.#bytes[this.pos + 2] << 16);
      this.pos += 3;
      return v;
    }
    const v = DataViewPrototypeGetBigUint64(this.#view, this.pos, true);
    this.pos += 8;
    return NumberIsSafeInteger(NumberFromBigInt(v)) ? NumberFromBigInt(v) : v;
  }
  lenencBytes() {
    const length = this.lenenc();
    return length === null ? null : this.bytes(length);
  }
  lenencString() {
    const bytes = this.lenencBytes();
    return bytes === null ? null : textDecoder.decode(bytes);
  }
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

// --- authentication -----------------------------------------------------------

function sha1(data) {
  return op_done_hash_digest("sha1", data);
}
function sha256(data) {
  return op_done_hash_digest("sha256", data);
}
function xor(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password))). */
function nativePassword(password, scramble) {
  if (password === "") return new Uint8Array(0);
  const hash = sha1(core.encode(password));
  return xor(hash, sha1(concat([scramble, sha1(hash)])));
}

/** SHA256(password) XOR SHA256(SHA256(SHA256(password)) + scramble). */
function cachingSha2Password(password, scramble) {
  if (password === "") return new Uint8Array(0);
  const hash = sha256(core.encode(password));
  return xor(hash, sha256(concat([sha256(hash), scramble])));
}

function authResponse(plugin, password, scramble) {
  switch (plugin) {
    case "mysql_native_password":
      return nativePassword(password, scramble);
    case "caching_sha2_password":
      return cachingSha2Password(password, scramble);
    case "mysql_clear_password":
      return core.encode(`${password}\0`);
    default:
      throw new Error(
        `Unsupported MySQL authentication plugin: ${plugin}. Use mysql_native_password or caching_sha2_password`,
      );
  }
}

// --- values -------------------------------------------------------------------

const NumberFromBigInt = (value) => Number(value);

function pad(value, width) {
  return StringPrototypePadStart(String(value), width, "0");
}

function makeDate(y, mo, d, h, mi, s, micros) {
  if (y === 0 && mo === 0 && d === 0) return null;
  const time = new Date(0);
  DatePrototypeSetUTCFullYear(time, y, mo - 1, d);
  DatePrototypeSetUTCHours(time, h, mi, s, MathFloor(micros / 1000));
  return time;
}

function parseTextDate(text) {
  // "2026-10-14", "2026-10-14 12:34:56", "2026-10-14 12:34:56.789012"
  const y = NumberParseInt(StringPrototypeSlice(text, 0, 4), 10);
  const mo = NumberParseInt(StringPrototypeSlice(text, 5, 7), 10);
  const d = NumberParseInt(StringPrototypeSlice(text, 8, 10), 10);
  if (text.length <= 10) return makeDate(y, mo, d, 0, 0, 0, 0);
  const h = NumberParseInt(StringPrototypeSlice(text, 11, 13), 10);
  const mi = NumberParseInt(StringPrototypeSlice(text, 14, 16), 10);
  const s = NumberParseInt(StringPrototypeSlice(text, 17, 19), 10);
  const fraction = text.length > 20 ? StringPrototypeSlice(text, 20) : "";
  const micros = fraction === ""
    ? 0
    : NumberParseInt(StringPrototypeSlice(fraction + "000000", 0, 6), 10);
  if (ArrayPrototypeSome([y, mo, d, h, mi, s], NumberIsNaN)) return text;
  return makeDate(y, mo, d, h, mi, s, micros);
}

function isTextType(column) {
  switch (column.type) {
    case T.VARCHAR:
    case T.VAR_STRING:
    case T.STRING:
    case T.TINY_BLOB:
    case T.MEDIUM_BLOB:
    case T.LONG_BLOB:
    case T.BLOB:
    case T.ENUM:
    case T.SET:
    case T.JSON:
      return column.charset !== BINARY_CHARSET || column.type === T.JSON;
    default:
      return false;
  }
}

function isBinaryType(column) {
  switch (column.type) {
    case T.VARCHAR:
    case T.VAR_STRING:
    case T.STRING:
    case T.TINY_BLOB:
    case T.MEDIUM_BLOB:
    case T.LONG_BLOB:
    case T.BLOB:
    case T.BIT:
    case T.GEOMETRY:
      return true;
    default:
      return false;
  }
}

function decodeIntegerText(text) {
  const value = NumberParseInt(text, 10);
  if (NumberIsSafeInteger(value)) return value;
  return BigInt(text);
}

/** A value from the text protocol, as `bytes`. */
function decodeText(bytes, column) {
  if (bytes === null) return null;
  if (isBinaryType(column) && !isTextType(column)) {
    return new Uint8Array(bytes);
  }
  const text = textDecoder.decode(bytes);
  switch (column.type) {
    case T.TINY:
    case T.SHORT:
    case T.LONG:
    case T.INT24:
    case T.YEAR:
      return NumberParseInt(text, 10);
    case T.LONGLONG:
      return decodeIntegerText(text);
    case T.FLOAT:
    case T.DOUBLE:
      return NumberParseFloat(text);
    case T.DATE:
    case T.DATETIME:
    case T.TIMESTAMP:
      return parseTextDate(text);
    case T.JSON:
      try {
        return JSONParse(text);
      } catch {
        return text;
      }
    default:
      return text;
  }
}

/** A value from the binary protocol, read at the cursor. */
function decodeBinary(cursor, column) {
  const view = cursor.view();
  const unsigned = (column.flags & FLAG_UNSIGNED) !== 0;
  switch (column.type) {
    case T.TINY: {
      const v = unsigned
        ? DataViewPrototypeGetUint8(view, cursor.pos)
        : DataViewPrototypeGetInt8(view, cursor.pos);
      cursor.skip(1);
      return v;
    }
    case T.SHORT:
    case T.YEAR: {
      const v = unsigned
        ? DataViewPrototypeGetUint16(view, cursor.pos, true)
        : DataViewPrototypeGetInt16(view, cursor.pos, true);
      cursor.skip(2);
      return v;
    }
    case T.LONG:
    case T.INT24: {
      const v = unsigned
        ? DataViewPrototypeGetUint32(view, cursor.pos, true)
        : DataViewPrototypeGetInt32(view, cursor.pos, true);
      cursor.skip(4);
      return v;
    }
    case T.LONGLONG: {
      const big = unsigned
        ? DataViewPrototypeGetBigUint64(view, cursor.pos, true)
        : DataViewPrototypeGetBigInt64(view, cursor.pos, true);
      cursor.skip(8);
      const number = NumberFromBigInt(big);
      return NumberIsSafeInteger(number) ? number : big;
    }
    case T.FLOAT: {
      const v = DataViewPrototypeGetFloat32(view, cursor.pos, true);
      cursor.skip(4);
      // Round to the decimal digits a FLOAT holds, so 1.1 doesn't read as
      // 1.100000023841858.
      return NumberParseFloat(NumberPrototypeToPrecision(v, 7));
    }
    case T.DOUBLE: {
      const v = DataViewPrototypeGetFloat64(view, cursor.pos, true);
      cursor.skip(8);
      return v;
    }
    case T.DATE:
    case T.DATETIME:
    case T.TIMESTAMP: {
      const length = cursor.byte();
      if (length === 0) return null;
      const y = cursor.int16();
      const mo = cursor.byte();
      const d = cursor.byte();
      let h = 0, mi = 0, s = 0, micros = 0;
      if (length >= 7) {
        h = cursor.byte();
        mi = cursor.byte();
        s = cursor.byte();
      }
      if (length >= 11) micros = cursor.int32();
      return makeDate(y, mo, d, h, mi, s, micros);
    }
    case T.TIME: {
      const length = cursor.byte();
      if (length === 0) return "00:00:00";
      const negative = cursor.byte() === 1;
      const days = cursor.int32();
      const h = cursor.byte();
      const mi = cursor.byte();
      const s = cursor.byte();
      let text = `${negative ? "-" : ""}${pad(days * 24 + h, 2)}:${
        pad(mi, 2)
      }:${pad(s, 2)}`;
      if (length >= 12) text += `.${pad(cursor.int32(), 6)}`;
      return text;
    }
    default: {
      const bytes = cursor.lenencBytes();
      return decodeText(bytes, column);
    }
  }
}

function setProperty(row, name, value) {
  ObjectDefineProperty(row, name, {
    __proto__: null,
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A parameter's type and encoded value for COM_STMT_EXECUTE. */
function encodeParam(value, types, values) {
  const unsigned = 0;
  if (value === null || value === undefined) {
    ArrayPrototypePush(types, T.NULL, unsigned);
    return true;
  }
  switch (typeof value) {
    case "boolean":
      ArrayPrototypePush(types, T.TINY, unsigned);
      values.byte(value ? 1 : 0);
      return false;
    case "number":
      if (NumberIsInteger(value) && NumberIsSafeInteger(value)) {
        ArrayPrototypePush(types, T.LONGLONG, unsigned);
        values.int64(value);
      } else {
        ArrayPrototypePush(types, T.DOUBLE, unsigned);
        values.float64(value);
      }
      return false;
    case "bigint":
      if (value >= -(2n ** 63n) && value < 2n ** 63n) {
        ArrayPrototypePush(types, T.LONGLONG, unsigned);
        values.int64(value);
      } else if (value >= 0n && value < 2n ** 64n) {
        ArrayPrototypePush(types, T.LONGLONG, 0x80);
        values.int64(BigIntAsIntN(64, value));
      } else {
        throw new TypeError("BigInt parameter doesn't fit in 64 bits");
      }
      return false;
    case "string":
      ArrayPrototypePush(types, T.VAR_STRING, unsigned);
      values.lenencBytes(core.encode(value));
      return false;
  }
  if (ObjectPrototypeIsPrototypeOf(DatePrototype, value)) {
    if (NumberIsNaN(DatePrototypeGetTime(value))) {
      throw new TypeError("Invalid Date parameter");
    }
    ArrayPrototypePush(types, T.DATETIME, unsigned);
    const micros = DatePrototypeGetUTCMilliseconds(value) * 1000;
    values.byte(micros === 0 ? 7 : 11)
      .int16(DatePrototypeGetUTCFullYear(value))
      .byte(DatePrototypeGetUTCMonth(value) + 1)
      .byte(DatePrototypeGetUTCDate(value))
      .byte(DatePrototypeGetUTCHours(value))
      .byte(DatePrototypeGetUTCMinutes(value))
      .byte(DatePrototypeGetUTCSeconds(value));
    if (micros !== 0) values.int32(micros);
    return false;
  }
  if (ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, value)) {
    ArrayPrototypePush(types, T.BLOB, unsigned);
    values.lenencBytes(value);
    return false;
  }
  if (typeof value === "object") {
    ArrayPrototypePush(types, T.VAR_STRING, unsigned);
    values.lenencBytes(core.encode(JSONStringify(value)));
    return false;
  }
  throw new TypeError(`Unsupported query parameter: ${String(value)}`);
}

// --- options ------------------------------------------------------------------

function parseTarget(target, options) {
  let config;
  if (
    typeof target === "string" ||
    ObjectPrototypeIsPrototypeOf(URLPrototype, target)
  ) {
    const url = new URL(`${target}`);
    if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") {
      throw new TypeError(
        `Unsupported protocol ${url.protocol}; expected mysql: or mariadb:`,
      );
    }
    const ssl = url.searchParams.get("ssl") ?? url.searchParams.get("sslmode");
    config = {
      hostname: url.hostname === "" ? undefined : url.hostname,
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
      ssl: ssl === null
        ? undefined
        : ssl === "disable" || ssl === "false" || ssl === "0"
        ? false
        : ssl === "require" || ssl === "true" || ssl === "1"
        ? "require"
        : ssl,
      ...options,
    };
  } else if (target !== null && typeof target === "object") {
    config = { ...target };
  } else {
    throw new TypeError(
      "Deno.mysql.connect() expects a URL or an options object",
    );
  }
  config.hostname ??= "127.0.0.1";
  config.port ??= 3306;
  if (config.username === undefined) {
    throw new TypeError("A username is required to connect to MySQL");
  }
  config.password ??= "";
  config.ssl ??= "prefer";
  if (
    config.ssl !== false && config.ssl !== true && config.ssl !== "prefer" &&
    config.ssl !== "require"
  ) {
    throw new TypeError(`Unsupported ssl setting: ${String(config.ssl)}`);
  }
  return config;
}

// --- the client ---------------------------------------------------------------

/** Reads one whole packet (header and payload) straight from `conn`. */
async function readRawPacket(conn) {
  const header = new Uint8Array(4);
  await readFully(conn, header);
  const length = header[0] | (header[1] << 8) | (header[2] << 16);
  const payload = new Uint8Array(length);
  await readFully(conn, payload);
  return { payload, seq: header[3] };
}

async function readFully(conn, buffer) {
  let read = 0;
  while (read < buffer.length) {
    const n = await conn.read(TypedArrayPrototypeSubarray(buffer, read));
    if (n === null) throw new Error("The MySQL server closed the connection");
    read += n;
  }
}

async function writeFully(conn, bytes) {
  let written = 0;
  while (written < bytes.length) {
    written += await conn.write(TypedArrayPrototypeSubarray(bytes, written));
  }
}

function packet(seq, payload) {
  const out = new Uint8Array(4 + payload.length);
  out[0] = payload.length & 0xff;
  out[1] = (payload.length >> 8) & 0xff;
  out[2] = (payload.length >> 16) & 0xff;
  out[3] = seq;
  TypedArrayPrototypeSet(out, payload, 4);
  return out;
}

function parseHandshake(payload) {
  const cursor = new Cursor(payload);
  const protocol = cursor.byte();
  if (protocol === 0xff) throw errorFromPacket(payload);
  if (protocol !== 10) {
    throw new Error(`Unsupported MySQL protocol version ${protocol}`);
  }
  const serverVersion = cursor.cstring();
  cursor.skip(4); // connection id
  const salt1 = cursor.bytes(8);
  cursor.skip(1);
  let capabilities = cursor.int16();
  cursor.skip(1); // character set
  cursor.skip(2); // status
  capabilities |= cursor.int16() << 16;
  const authLength = cursor.byte();
  cursor.skip(10);
  const salt2Length = MathMax(13, authLength - 8);
  let salt2 = cursor.bytes(salt2Length);
  if (salt2[salt2.length - 1] === 0) {
    salt2 = TypedArrayPrototypeSubarray(salt2, 0, salt2.length - 1);
  }
  let plugin = "mysql_native_password";
  if (cursor.remaining > 0) {
    let rest = cursor.rest();
    if (rest[rest.length - 1] === 0) {
      rest = TypedArrayPrototypeSubarray(rest, 0, rest.length - 1);
    }
    plugin = textDecoder.decode(rest);
  }
  return {
    serverVersion,
    capabilities,
    scramble: concat([salt1, salt2]),
    plugin,
  };
}

function errorFromPacket(payload) {
  const cursor = new Cursor(payload);
  cursor.skip(1);
  const errno = cursor.int16();
  let sqlState = "HY000";
  if (cursor.peek() === 35) { // '#'
    cursor.skip(1);
    sqlState = textDecoder.decode(cursor.bytes(5));
  }
  return new MysqlError(textDecoder.decode(cursor.rest()), errno, sqlState);
}

function parseColumn(payload) {
  const cursor = new Cursor(payload);
  cursor.lenencBytes(); // catalog
  cursor.lenencBytes(); // schema
  cursor.lenencBytes(); // table
  cursor.lenencBytes(); // original table
  const name = cursor.lenencString();
  cursor.lenencBytes(); // original name
  cursor.lenenc(); // length of the fixed fields
  const charset = cursor.int16();
  cursor.skip(4); // column length
  const type = cursor.byte();
  const flags = cursor.int16();
  return { name, type, flags, charset };
}

class MysqlClient {
  #conn;
  #config;
  #queue = [];
  #waiting;
  #pending = [];
  #packetBuffer = new Uint8Array(0);
  #seq = 0;
  #closed = false;
  #closedPromise;
  #closeError;
  #lock = PromiseResolve();
  #tls = false;

  constructor(key, conn, config, tls, seq) {
    if (key !== constructorKey) throw new TypeError("Illegal constructor");
    this.#conn = conn;
    this.#config = config;
    this.#tls = tls;
    this.#seq = seq;
    this.#closedPromise = this.#readLoop();
  }

  static async open(config) {
    let conn = await connect({ hostname: config.hostname, port: config.port });
    // Without this, a small write that follows a small write waits for the
    // peer's delayed acknowledgement, about 40 ms per query.
    conn.setNoDelay(true);
    let tls = false;
    let seq;
    let handshake;
    try {
      const first = await readRawPacket(conn);
      handshake = parseHandshake(first.payload);
      seq = (first.seq + 1) & 0xff;
      const wantTls = config.ssl !== false;
      const canTls = (handshake.capabilities & CLIENT_SSL) !== 0;
      if (wantTls && !canTls && config.ssl !== "prefer") {
        throw new Error(
          "The server does not support TLS, which this connection requires",
        );
      }
      if (wantTls && canTls) {
        const request = new Writer().int32(clientCapabilities(config, true))
          .int32(MAX_PACKET).byte(45).bytes(new Uint8Array(23));
        await writeFully(conn, packet(seq, request.body()));
        seq = (seq + 1) & 0xff;
        conn = await startTls(conn, {
          hostname: config.hostname,
          caCerts: config.caCerts ?? [],
        });
        tls = true;
      }
    } catch (error) {
      try {
        conn.close();
      } catch {
        // Already closed.
      }
      throw error;
    }
    const client = new MysqlClient(constructorKey, conn, config, tls, seq);
    try {
      await client.#authenticate(handshake);
      await client.#command(
        new Writer().byte(0x03).bytes(
          core.encode("SET time_zone = '+00:00'"),
        ).body(),
        (client) => client.#readSimpleResult(),
      );
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  get closed() {
    return this.#closedPromise;
  }

  async #readLoop() {
    const chunk = new Uint8Array(32768);
    try {
      while (true) {
        const n = await this.#conn.read(chunk);
        if (n === null) break;
        this.#packetBuffer = concat([
          this.#packetBuffer,
          TypedArrayPrototypeSubarray(chunk, 0, n),
        ]);
        this.#splitPackets();
      }
    } catch (error) {
      if (!this.#closed) this.#closeError = error;
    } finally {
      this.#closed = true;
      this.#closeConn();
      const error = this.#closeError ??
        new Error("The MySQL connection is closed");
      this.#waiting?.reject(error);
      this.#waiting = undefined;
    }
  }

  /** Moves whole packets from the byte buffer to the packet queue,
   * reassembling payloads that were split at 16 MB. */
  #splitPackets() {
    while (this.#packetBuffer.length >= 4) {
      const b = this.#packetBuffer;
      const length = b[0] | (b[1] << 8) | (b[2] << 16);
      if (b.length < 4 + length) return;
      const payload = TypedArrayPrototypeSubarray(b, 4, 4 + length);
      const seq = b[3];
      this.#packetBuffer = TypedArrayPrototypeSubarray(b, 4 + length);
      ArrayPrototypePush(this.#pending, {
        payload,
        seq,
        more: length === MAX_PACKET,
      });
      this.#assemble();
    }
  }

  #assemble() {
    while (this.#pending.length > 0) {
      // Join a run of maximum-size packets with the packet that ends it.
      let end = -1;
      for (let i = 0; i < this.#pending.length; i++) {
        if (!this.#pending[i].more) {
          end = i;
          break;
        }
      }
      if (end === -1) return;
      const parts = [];
      let seq = 0;
      for (let i = 0; i <= end; i++) {
        const next = ArrayPrototypeShift(this.#pending);
        ArrayPrototypePush(parts, next.payload);
        seq = next.seq;
      }
      const message = { payload: concat(parts), seq };
      if (this.#waiting !== undefined) {
        const waiting = this.#waiting;
        this.#waiting = undefined;
        waiting.resolve(message);
      } else {
        ArrayPrototypePush(this.#queue, message);
      }
    }
  }

  async #nextPacket() {
    let message;
    if (this.#queue.length > 0) {
      message = ArrayPrototypeShift(this.#queue);
    } else {
      if (this.#closed) {
        throw this.#closeError ?? new Error("The MySQL connection is closed");
      }
      const waiter = PromiseWithResolvers();
      this.#waiting = waiter;
      message = await waiter.promise;
    }
    this.#seq = (message.seq + 1) & 0xff;
    return message.payload;
  }

  #closeConn() {
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }

  async #send(payload) {
    if (this.#closed) throw new Error("The MySQL connection is closed");
    let rest = payload;
    // Payloads of 16 MB or more are split, ending with a shorter packet
    // (possibly empty).
    while (true) {
      const part = TypedArrayPrototypeSubarray(rest, 0, MAX_PACKET);
      await writeFully(this.#conn, packet(this.#seq, part));
      this.#seq = (this.#seq + 1) & 0xff;
      if (part.length < MAX_PACKET) return;
      rest = TypedArrayPrototypeSubarray(rest, MAX_PACKET);
    }
  }

  async #authenticate(handshake) {
    const config = this.#config;
    let capabilities = clientCapabilities(config, this.#tls);
    capabilities &= handshake.capabilities | CLIENT_CONNECT_WITH_DB |
      CLIENT_SSL;
    if (config.database === undefined) {
      capabilities &= ~CLIENT_CONNECT_WITH_DB;
    }
    let plugin = handshake.plugin;
    let scramble = handshake.scramble;
    const response = new Writer().int32(capabilities).int32(MAX_PACKET)
      .byte(45).bytes(new Uint8Array(23)).cstring(config.username)
      .lenencBytes(authResponse(plugin, config.password, scramble));
    if (config.database !== undefined) response.cstring(config.database);
    response.cstring(plugin);
    await this.#send(response.body());

    while (true) {
      const payload = await this.#nextPacket();
      switch (payload[0]) {
        case 0x00:
          return;
        case 0xff:
          throw errorFromPacket(payload);
        case 0xfe: {
          // The server wants a different plugin.
          const cursor = new Cursor(payload);
          cursor.skip(1);
          plugin = cursor.cstring();
          let data = cursor.rest();
          if (data[data.length - 1] === 0) {
            data = TypedArrayPrototypeSubarray(data, 0, data.length - 1);
          }
          scramble = data;
          await this.#send(authResponse(plugin, config.password, scramble));
          break;
        }
        case 0x01: {
          if (plugin !== "caching_sha2_password") {
            throw new Error("Unexpected authentication data from the server");
          }
          if (payload[1] === 3) break; // fast authentication succeeded
          if (payload[1] === 4) {
            // The server needs the password itself, which is only sent
            // over TLS.
            if (!this.#tls) {
              throw new Error(
                'caching_sha2_password needs TLS (ssl: "require") the first time a user connects',
              );
            }
            await this.#send(core.encode(`${config.password}\0`));
            break;
          }
          throw new Error("Unexpected caching_sha2_password response");
        }
        default:
          throw new Error("Unexpected packet during MySQL authentication");
      }
    }
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

  /** Sends a command (restarting sequence numbers) and runs `read` for the
   * reply. */
  async #command(payload, read) {
    this.#seq = 0;
    this.#queue.length = 0;
    await this.#send(payload);
    return await read(this);
  }

  async #readSimpleResult() {
    const payload = await this.#nextPacket();
    if (payload[0] === 0xff) throw errorFromPacket(payload);
    return parseOk(payload);
  }

  /** Reads one result: an OK, or a result set with rows. Resolves to the
   * result and whether more results follow. */
  async #readResult(binary) {
    const first = await this.#nextPacket();
    if (first[0] === 0xff) throw errorFromPacket(first);
    if (first[0] === 0x00) {
      const ok = parseOk(first);
      return {
        result: {
          rows: [],
          fields: [],
          affectedRows: ok.affectedRows,
          insertId: ok.insertId,
        },
        more: (ok.status & SERVER_MORE_RESULTS_EXISTS) !== 0,
      };
    }
    if (first[0] === 0xfb) {
      throw new Error(
        "The server asked for a local file, which isn't supported",
      );
    }
    const count = new Cursor(first).lenenc();
    const columns = [];
    for (let i = 0; i < count; i++) {
      ArrayPrototypePush(columns, parseColumn(await this.#nextPacket()));
    }
    await this.#nextPacket(); // EOF after the column definitions
    const rows = [];
    let status = 0;
    while (true) {
      const payload = await this.#nextPacket();
      if (payload[0] === 0xff) throw errorFromPacket(payload);
      if (payload[0] === 0xfe && payload.length < 9) {
        status = payload[3] | (payload[4] << 8);
        break;
      }
      ArrayPrototypePush(
        rows,
        binary
          ? parseBinaryRow(payload, columns)
          : parseTextRow(payload, columns),
      );
    }
    return {
      result: {
        rows,
        fields: ArrayPrototypeMap(
          columns,
          (c) => ({ name: c.name, type: c.type }),
        ),
        affectedRows: 0,
        insertId: 0,
      },
      more: (status & SERVER_MORE_RESULTS_EXISTS) !== 0,
    };
  }

  async #query(text, params) {
    if (typeof text !== "string") {
      throw new TypeError("The query must be a string");
    }
    if (!ArrayIsArray(params)) {
      throw new TypeError("Query parameters must be an array");
    }
    // Prepare, execute, close.
    this.#seq = 0;
    this.#queue.length = 0;
    await this.#send(new Writer().byte(0x16).bytes(core.encode(text)).body());
    const prepared = await this.#nextPacket();
    if (prepared[0] === 0xff) throw errorFromPacket(prepared);
    const cursor = new Cursor(prepared);
    cursor.skip(1);
    const statementId = cursor.int32();
    const columnCount = cursor.int16();
    const paramCount = cursor.int16();
    for (let i = 0; i < paramCount; i++) await this.#nextPacket();
    if (paramCount > 0) await this.#nextPacket();
    for (let i = 0; i < columnCount; i++) await this.#nextPacket();
    if (columnCount > 0) await this.#nextPacket();
    try {
      if (params.length !== paramCount) {
        throw new TypeError(
          `The query has ${paramCount} parameters but ${params.length} values were given`,
        );
      }
      const execute = new Writer().byte(0x17).int32(statementId).byte(0)
        .int32(1);
      if (paramCount > 0) {
        const types = [];
        const values = new Writer();
        const nulls = new Uint8Array((paramCount + 7) >> 3);
        for (let i = 0; i < paramCount; i++) {
          if (encodeParam(params[i], types, values)) {
            nulls[i >> 3] |= 1 << (i & 7);
          }
        }
        execute.bytes(nulls).byte(1).bytes(new Uint8Array(types))
          .bytes(values.body());
      }
      this.#seq = 0;
      await this.#send(execute.body());
      const { result, more } = await this.#readResult(true);
      let remaining = more;
      while (remaining) remaining = (await this.#readResult(true)).more;
      return result;
    } finally {
      if (!this.#closed) {
        this.#seq = 0;
        try {
          await this.#send(new Writer().byte(0x19).int32(statementId).body());
        } catch {
          // The connection is gone; nothing to clean up.
        }
      }
    }
  }

  async #exec(text) {
    if (typeof text !== "string") {
      throw new TypeError("The SQL must be a string");
    }
    return await this.#command(
      new Writer().byte(0x03).bytes(core.encode(text)).body(),
      async (client) => {
        const results = [];
        let more = true;
        while (more) {
          const next = await client.#readResult(false);
          ArrayPrototypePush(results, next.result);
          more = next.more;
        }
        return results;
      },
    );
  }

  /** Runs one statement with `?` placeholders. Resolves to
   * `{ rows, fields, affectedRows, insertId }`. */
  query(text, params = []) {
    return this.#withLock(() => this.#query(text, params));
  }

  /** Runs a script of statements, without parameters, and resolves to a
   * result for each. */
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
      await this.#exec("START TRANSACTION");
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

  close() {
    if (this.#closed) return;
    this.#seq = 0;
    PromisePrototypeThen(
      this.#send(new Writer().byte(0x01).body()),
      () => this.#closeConn(),
      () => this.#closeConn(),
    );
    this.#closed = true;
  }

  [SymbolDispose]() {
    this.close();
  }
}

function clientCapabilities(config, tls) {
  let capabilities = CLIENT_LONG_PASSWORD | CLIENT_LONG_FLAG |
    CLIENT_PROTOCOL_41 | CLIENT_TRANSACTIONS | CLIENT_SECURE_CONNECTION |
    CLIENT_MULTI_STATEMENTS | CLIENT_MULTI_RESULTS | CLIENT_PS_MULTI_RESULTS |
    CLIENT_PLUGIN_AUTH | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA;
  if (config.database !== undefined) capabilities |= CLIENT_CONNECT_WITH_DB;
  if (tls) capabilities |= CLIENT_SSL;
  return capabilities;
}

function parseOk(payload) {
  const cursor = new Cursor(payload);
  cursor.skip(1);
  const affectedRows = cursor.lenenc();
  const insertId = cursor.lenenc();
  const status = cursor.int16();
  return { affectedRows, insertId, status };
}

function parseTextRow(payload, columns) {
  const cursor = new Cursor(payload);
  const row = {};
  for (let i = 0; i < columns.length; i++) {
    setProperty(
      row,
      columns[i].name,
      decodeText(cursor.lenencBytes(), columns[i]),
    );
  }
  return row;
}

function parseBinaryRow(payload, columns) {
  const cursor = new Cursor(payload);
  cursor.skip(1); // 0x00 header
  const bitmap = cursor.bytes((columns.length + 9) >> 3);
  const row = {};
  for (let i = 0; i < columns.length; i++) {
    const bit = i + 2;
    const isNull = (bitmap[bit >> 3] & (1 << (bit & 7))) !== 0;
    setProperty(
      row,
      columns[i].name,
      isNull ? null : decodeBinary(cursor, columns[i]),
    );
  }
  return row;
}

function buildTemplate(strings, values) {
  if (!ArrayIsArray(strings) || strings.length !== values.length + 1) {
    throw new TypeError("sql must be used as a tagged template");
  }
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `?${strings[i + 1]}`;
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

async function connectMysql(target, options) {
  return await MysqlClient.open(parseTarget(target, options));
}

const mysql = ObjectFreeze({ connect: connectMysql });

return { mysql, MysqlClient, MysqlError };
})();
