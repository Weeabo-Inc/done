// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.hash`: fast, synchronous, non-cryptographic hashes.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_hash_crc32,
  op_done_hash_digest,
  op_done_hash_digest_string,
  op_done_hash_xxh3,
  op_done_hash_xxh32,
  op_done_hash_xxh64,
} = core.ops;
const {
  ArrayBufferIsView,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  ArrayBufferPrototype,
  BigInt,
  TypeError,
  Uint8Array,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteOffset,
  TypedArrayPrototypeGetByteLength,
  DataViewPrototypeGetBuffer,
  DataViewPrototypeGetByteOffset,
  DataViewPrototypeGetByteLength,
  DataViewPrototype,
  StringPrototypeReplaceAll,
  StringPrototypeToLowerCase,
} = primordials;

function toBytes(data) {
  if (typeof data === "string") return core.encode(data);
  if (ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, data)) {
    return new Uint8Array(data);
  }
  if (ArrayBufferIsView(data)) {
    if (ObjectPrototypeIsPrototypeOf(DataViewPrototype, data)) {
      return new Uint8Array(
        DataViewPrototypeGetBuffer(data),
        DataViewPrototypeGetByteOffset(data),
        DataViewPrototypeGetByteLength(data),
      );
    }
    return new Uint8Array(
      TypedArrayPrototypeGetBuffer(data),
      TypedArrayPrototypeGetByteOffset(data),
      TypedArrayPrototypeGetByteLength(data),
    );
  }
  throw new TypeError(
    "Data to hash must be a string, an ArrayBuffer or an ArrayBufferView",
  );
}

function toBigIntSeed(seed) {
  return typeof seed === "bigint" ? seed : BigInt(seed ?? 0);
}

/** 32-bit xxHash. Returns a number. */
function xxhash32(data, seed = 0) {
  return op_done_hash_xxh32(toBytes(data), seed >>> 0);
}

/** 64-bit xxHash. Returns a bigint. */
function xxhash64(data, seed = 0n) {
  return op_done_hash_xxh64(toBytes(data), toBigIntSeed(seed));
}

/** 64-bit XXH3, the fastest of the xxHash family. Returns a bigint. */
function xxhash3(data, seed = 0n) {
  return op_done_hash_xxh3(toBytes(data), toBigIntSeed(seed));
}

/** CRC-32 (IEEE 802.3, as used by zip and gzip). Pass the previous result as
 * `initial` to hash data in chunks. Returns a number. */
function crc32(data, initial = 0) {
  return op_done_hash_crc32(toBytes(data), initial >>> 0);
}

/**
 * A cryptographic digest (MD5, SHA-1, SHA-256, SHA-384 or SHA-512), computed
 * synchronously. Returns bytes, or a string when `encoding` is `"hex"` or
 * `"base64"`. Algorithm names are case-insensitive, and `"SHA-256"` works as
 * well as `"sha256"`.
 */
function digest(algorithm, data, encoding) {
  if (typeof algorithm !== "string") {
    throw new TypeError("Digest algorithm must be a string");
  }
  const name = StringPrototypeReplaceAll(
    StringPrototypeToLowerCase(algorithm),
    "-",
    "",
  );
  const bytes = toBytes(data);
  return encoding === undefined
    ? op_done_hash_digest(name, bytes)
    : op_done_hash_digest_string(name, bytes, encoding);
}

const hash = ObjectFreeze({ crc32, digest, xxhash3, xxhash32, xxhash64 });

return { hash };
})();
