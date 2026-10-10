// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.S3Client`: an S3 client over `fetch()`, with AWS Signature Version 4.
// Works with AWS S3 and S3-compatible stores (Cloudflare R2, MinIO, ...).

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_hash_digest_string,
  op_done_hmac_sha256,
  op_get_env,
} = core.ops;
const {
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypeSort,
  Date,
  DatePrototypeGetTime,
  DatePrototypeToISOString,
  Error,
  JSONParse,
  NumberIsFinite,
  NumberIsInteger,
  NumberPrototypeToString,
  NumberParseInt,
  ArrayBufferIsView,
  ArrayBufferPrototype,
  ObjectKeys,
  ObjectPrototypeIsPrototypeOf,
  RegExpPrototypeExec,
  SafeRegExp,
  String,
  StringFromCodePoint,
  StringPrototypeCharCodeAt,
  StringPrototypeReplace,
  StringPrototypeReplaceAll,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeToUpperCase,
  StringPrototypeTrim,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint8Array,
  encodeURIComponent,
} = primordials;

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RESERVED = new SafeRegExp("[!'()*]", "g");
const COLONS = new SafeRegExp(":", "g");

/** RFC 3986 encoding, which SigV4 requires (stricter than
 * `encodeURIComponent`). */
function encode(text) {
  return StringPrototypeReplace(
    encodeURIComponent(text),
    RESERVED,
    (c) =>
      `%${
        StringPrototypeToUpperCase(
          NumberPrototypeToString(StringPrototypeCharCodeAt(c, 0), 16),
        )
      }`,
  );
}

function encodeKey(key) {
  if (typeof key !== "string" || key === "") {
    throw new TypeError("An S3 key must be a non-empty string");
  }
  const segments = StringPrototypeSplit(key, "/");
  for (let i = 0; i < segments.length; i++) {
    // URLs resolve "." and ".." segments, so such keys can't be addressed.
    if (segments[i] === "." || segments[i] === "..") {
      throw new TypeError(
        `S3 keys with "." or ".." path segments are not supported: ${key}`,
      );
    }
  }
  return ArrayPrototypeJoin(ArrayPrototypeMap(segments, encode), "/");
}

function sha256Hex(bytes) {
  return op_done_hash_digest_string("sha256", bytes, "hex");
}

function hmac(key, text) {
  return op_done_hmac_sha256(
    typeof key === "string" ? core.encode(key) : key,
    core.encode(text),
  );
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? "0" : "") +
      NumberPrototypeToString(bytes[i], 16);
  }
  return out;
}

/** "20130524T000000Z" */
function amzDate(date) {
  return StringPrototypeReplace(
    StringPrototypeReplaceAll(
      StringPrototypeSlice(DatePrototypeToISOString(date), 0, 19),
      "-",
      "",
    ),
    COLONS,
    "",
  ) + "Z";
}

function canonicalQuery(params) {
  const pairs = ArrayPrototypeMap(
    params,
    ({ 0: name, 1: value }) => `${encode(name)}=${encode(value)}`,
  );
  ArrayPrototypeSort(pairs);
  return ArrayPrototypeJoin(pairs, "&");
}

class S3Error extends Error {
  /** The S3 error code, such as `"NoSuchKey"` or `"AccessDenied"`. */
  code;
  /** The HTTP status. */
  status;

  constructor(message, code, status) {
    super(message);
    this.name = "S3Error";
    this.code = code;
    this.status = status;
  }
}

const XML_ENTITIES = new SafeRegExp(
  "&(?:#(\\d+)|#x([0-9a-fA-F]+)|(\\w+));",
  "g",
);
const NAMED_ENTITIES = {
  __proto__: null,
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text) {
  return StringPrototypeReplace(
    text,
    XML_ENTITIES,
    (match, dec, hexCode, name) => {
      if (dec) return StringFromCodePoint(NumberParseInt(dec, 10));
      if (hexCode) {
        return StringFromCodePoint(NumberParseInt(hexCode, 16));
      }
      return NAMED_ENTITIES[name] ?? match;
    },
  );
}

/** The text of every `<tag>` element directly in `xml`, in order. S3's list
 * responses are flat enough that this is all the XML parsing needed. */
function elements(xml, tag) {
  const pattern = new SafeRegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out = [];
  let match;
  while ((match = RegExpPrototypeExec(pattern, xml)) !== null) {
    ArrayPrototypePush(out, match[1]);
  }
  return out;
}

function element(xml, tag) {
  const found = elements(xml, tag)[0];
  return found === undefined ? undefined : decodeXml(found);
}

async function errorFrom(response, key) {
  const text =
    response.status === 404 && response.headers.get("content-length") === "0"
      ? ""
      : await response.text();
  const code = element(text, "Code") ??
    (response.status === 404 ? "NoSuchKey" : `HTTP${response.status}`);
  const message = element(text, "Message") ??
    (response.statusText || `S3 request failed`);
  return new S3Error(
    `${message}${key ? ` (key: ${key})` : ""}`,
    code,
    response.status,
  );
}

async function toBytes(data) {
  if (typeof data === "string") return core.encode(data);
  if (ArrayBufferIsView(data)) {
    if (TypedArrayPrototypeGetSymbolToStringTag(data) === undefined) {
      // A DataView.
      return new Uint8Array(await new Response(data).arrayBuffer());
    }
    return new Uint8Array(
      TypedArrayPrototypeGetBuffer(data),
      TypedArrayPrototypeGetByteOffset(data),
      TypedArrayPrototypeGetByteLength(data),
    );
  }
  if (ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, data)) {
    return new Uint8Array(data);
  }
  // Blob, File, ReadableStream, Response, Request and FormData: let a
  // Response read them. S3 needs the length up front, so it is buffered.
  if (data !== null && typeof data === "object") {
    if (typeof data.bytes === "function") return await data.bytes();
    return await new Response(data).bytes();
  }
  throw new TypeError(
    "S3 data must be a string, bytes, a Blob, a ReadableStream or a Response",
  );
}

function env(name) {
  return op_get_env(name) ?? undefined;
}

class S3Client {
  #accessKeyId;
  #secretAccessKey;
  #sessionToken;
  #region;
  #endpoint;
  #bucket;
  #virtualHostedStyle;

  constructor(options = { __proto__: null }) {
    // The environment is only read when no credentials are passed, so an
    // app that configures the client itself needs no --allow-env.
    const fromEnv = options.accessKeyId === undefined &&
      options.secretAccessKey === undefined;
    const read = (...names) => {
      if (!fromEnv) return undefined;
      for (let i = 0; i < names.length; i++) {
        const value = env(names[i]);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    this.#accessKeyId = options.accessKeyId ??
      read("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID");
    this.#secretAccessKey = options.secretAccessKey ??
      read("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY");
    this.#sessionToken = options.sessionToken ??
      read("S3_SESSION_TOKEN", "AWS_SESSION_TOKEN");
    this.#region = options.region ??
      read("S3_REGION", "AWS_REGION", "AWS_DEFAULT_REGION") ?? "us-east-1";
    const endpoint = options.endpoint ??
      read("S3_ENDPOINT", "AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL");
    this.#bucket = options.bucket ?? read("S3_BUCKET", "AWS_BUCKET");
    if (!this.#accessKeyId || !this.#secretAccessKey) {
      throw new TypeError(
        "S3 credentials are missing: pass accessKeyId and secretAccessKey, " +
          "or set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
      );
    }
    if (!this.#bucket) {
      throw new TypeError("No S3 bucket: pass bucket, or set S3_BUCKET");
    }
    // AWS itself defaults to virtual-hosted URLs; other S3-compatible
    // stores usually expect path-style ones.
    this.#virtualHostedStyle = options.virtualHostedStyle ??
      (endpoint === undefined);
    this.#endpoint = endpoint === undefined
      ? new URL(`https://s3.${this.#region}.amazonaws.com`)
      : new URL(endpoint);
  }

  get bucket() {
    return this.#bucket;
  }

  get region() {
    return this.#region;
  }

  /** The origin and path for `key` (or for the bucket when `key` is
   * undefined), already encoded. */
  #location(key) {
    const encodedKey = key === undefined ? "" : encodeKey(key);
    if (this.#virtualHostedStyle) {
      const host = `${this.#bucket}.${this.#endpoint.host}`;
      return {
        origin: `${this.#endpoint.protocol}//${host}`,
        host,
        path: `/${encodedKey}`,
      };
    }
    const bucket = encode(this.#bucket);
    return {
      origin: this.#endpoint.origin,
      host: this.#endpoint.host,
      path: key === undefined ? `/${bucket}` : `/${bucket}/${encodedKey}`,
    };
  }

  #signingKey(dateStamp) {
    const date = hmac(`AWS4${this.#secretAccessKey}`, dateStamp);
    const region = hmac(date, this.#region);
    const service = hmac(region, "s3");
    return hmac(service, "aws4_request");
  }

  #signature(method, path, query, headers, payloadHash, date) {
    const names = ArrayPrototypeSort(ObjectKeys(headers));
    let canonicalHeaders = "";
    for (let i = 0; i < names.length; i++) {
      canonicalHeaders += `${names[i]}:${
        StringPrototypeTrim(String(headers[names[i]]))
      }\n`;
    }
    const signedHeaders = ArrayPrototypeJoin(names, ";");
    const canonicalRequest = ArrayPrototypeJoin([
      method,
      path,
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ], "\n");
    const timestamp = amzDate(date);
    const dateStamp = StringPrototypeSlice(timestamp, 0, 8);
    const scope = `${dateStamp}/${this.#region}/s3/aws4_request`;
    const stringToSign = ArrayPrototypeJoin([
      "AWS4-HMAC-SHA256",
      timestamp,
      scope,
      sha256Hex(core.encode(canonicalRequest)),
    ], "\n");
    return {
      signature: hex(hmac(this.#signingKey(dateStamp), stringToSign)),
      signedHeaders,
      scope,
      timestamp,
    };
  }

  async #request(method, key, options = { __proto__: null }) {
    const { origin, host, path } = this.#location(key);
    const params = options.query ?? [];
    const query = canonicalQuery(params);
    const body = options.body;
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256Hex(body);
    const date = new Date();
    const headers = {
      __proto__: null,
      "host": host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate(date),
      ...options.headers,
    };
    if (this.#sessionToken) {
      headers["x-amz-security-token"] = this.#sessionToken;
    }
    const { signature, signedHeaders, scope } = this.#signature(
      method,
      path,
      query,
      headers,
      payloadHash,
      date,
    );
    const requestHeaders = { __proto__: null, ...headers };
    delete requestHeaders.host;
    requestHeaders.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await fetch(
      `${origin}${path}${query ? `?${query}` : ""}`,
      {
        method,
        headers: requestHeaders,
        body,
        signal: options.signal,
      },
    );
    if (!response.ok && !(options.allow404 && response.status === 404)) {
      throw await errorFrom(response, key);
    }
    return response;
  }

  /** Uploads `data` to `key`, replacing any existing object. */
  async write(key, data, options = { __proto__: null }) {
    const body = await toBytes(data);
    const headers = { __proto__: null };
    const type = options.type ??
      (typeof data?.type === "string" && data.type ? data.type : undefined);
    if (type) headers["content-type"] = type;
    if (options.cacheControl) headers["cache-control"] = options.cacheControl;
    const response = await this.#request("PUT", key, {
      body,
      headers,
      signal: options.signal,
    });
    await response.body?.cancel();
    return { etag: response.headers.get("etag") ?? undefined };
  }

  /** Downloads `key` and returns the response, so the body can be streamed.
   * Throws `Deno.S3Error` (code `"NoSuchKey"`) when it doesn't exist. */
  get(key, options = { __proto__: null }) {
    const headers = { __proto__: null };
    if (options.range) {
      const { start = 0, end } = options.range;
      headers.range = `bytes=${start}-${end ?? ""}`;
    }
    return this.#request("GET", key, { headers, signal: options.signal });
  }

  /** Deletes `key`. Deleting a key that doesn't exist succeeds. */
  async delete(key, options = { __proto__: null }) {
    const response = await this.#request("DELETE", key, {
      signal: options.signal,
    });
    await response.body?.cancel();
  }

  /** Whether `key` exists. */
  async exists(key, options = { __proto__: null }) {
    const response = await this.#request("HEAD", key, {
      allow404: true,
      signal: options.signal,
    });
    await response.body?.cancel();
    return response.ok;
  }

  /** Size, last modification time, ETag and content type of `key`. */
  async stat(key, options = { __proto__: null }) {
    const response = await this.#request("HEAD", key, {
      signal: options.signal,
    });
    await response.body?.cancel();
    const headers = response.headers;
    return {
      size: NumberParseInt(headers.get("content-length") ?? "0", 10),
      lastModified: new Date(headers.get("last-modified") ?? 0),
      etag: headers.get("etag") ?? undefined,
      type: headers.get("content-type") ?? undefined,
    };
  }

  /** Lists objects (ListObjectsV2), at most 1000 per call. Pass
   * `nextContinuationToken` back as `continuationToken` for the next page. */
  async list(options = { __proto__: null }) {
    const query = [["list-type", "2"]];
    if (options.prefix !== undefined) {
      ArrayPrototypePush(query, ["prefix", options.prefix]);
    }
    if (options.delimiter !== undefined) {
      ArrayPrototypePush(query, ["delimiter", options.delimiter]);
    }
    if (options.maxKeys !== undefined) {
      if (!NumberIsInteger(options.maxKeys) || options.maxKeys < 1) {
        throw new TypeError("maxKeys must be a positive integer");
      }
      ArrayPrototypePush(query, ["max-keys", String(options.maxKeys)]);
    }
    if (options.startAfter !== undefined) {
      ArrayPrototypePush(query, ["start-after", options.startAfter]);
    }
    if (options.continuationToken !== undefined) {
      ArrayPrototypePush(query, [
        "continuation-token",
        options.continuationToken,
      ]);
    }
    const response = await this.#request("GET", undefined, {
      query,
      signal: options.signal,
    });
    const xml = await response.text();
    const contents = ArrayPrototypeMap(elements(xml, "Contents"), (item) => ({
      key: element(item, "Key"),
      size: NumberParseInt(element(item, "Size") ?? "0", 10),
      lastModified: new Date(element(item, "LastModified") ?? 0),
      etag: element(item, "ETag"),
    }));
    const commonPrefixes = ArrayPrototypeMap(
      elements(xml, "CommonPrefixes"),
      (item) => element(item, "Prefix"),
    );
    return {
      contents,
      commonPrefixes,
      isTruncated: element(xml, "IsTruncated") === "true",
      nextContinuationToken: element(xml, "NextContinuationToken"),
    };
  }

  /**
   * A presigned URL that lets anyone holding it `GET` (or, with
   * `method: "PUT"`, upload) `key` until it expires, without credentials.
   * Signing is local and synchronous.
   */
  presign(key, options = { __proto__: null }) {
    const method = options.method ?? "GET";
    const expiresIn = options.expiresIn ?? 86400;
    if (!NumberIsInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
      throw new TypeError(
        "expiresIn must be a whole number of seconds from 1 to 604800 (7 days)",
      );
    }
    const date = options.date ?? new Date();
    if (!NumberIsFinite(DatePrototypeGetTime(date))) {
      throw new TypeError("date must be a valid Date");
    }
    const { origin, host, path } = this.#location(key);
    const timestamp = amzDate(date);
    const scope = `${
      StringPrototypeSlice(timestamp, 0, 8)
    }/${this.#region}/s3/aws4_request`;
    const headers = { __proto__: null, host };
    if (options.type) headers["content-type"] = options.type;
    const params = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.#accessKeyId}/${scope}`],
      ["X-Amz-Date", timestamp],
      ["X-Amz-Expires", String(expiresIn)],
      [
        "X-Amz-SignedHeaders",
        ArrayPrototypeJoin(ArrayPrototypeSort(ObjectKeys(headers)), ";"),
      ],
    ];
    if (this.#sessionToken) {
      ArrayPrototypePush(params, ["X-Amz-Security-Token", this.#sessionToken]);
    }
    const query = canonicalQuery(params);
    const { signature } = this.#signature(
      method,
      path,
      query,
      headers,
      "UNSIGNED-PAYLOAD",
      date,
    );
    return `${origin}${path}?${query}&X-Amz-Signature=${signature}`;
  }

  /** A handle on one object, with the client's methods bound to its key. */
  file(key) {
    encodeKey(key);
    return new S3File(this, key);
  }
}

class S3File {
  #client;
  #key;

  constructor(client, key) {
    this.#client = client;
    this.#key = key;
  }

  get key() {
    return this.#key;
  }

  get(options) {
    return this.#client.get(this.#key, options);
  }

  async text() {
    return await (await this.get()).text();
  }

  async json() {
    return JSONParse(await this.text());
  }

  async bytes() {
    return await (await this.get()).bytes();
  }

  async arrayBuffer() {
    return await (await this.get()).arrayBuffer();
  }

  async stream() {
    return (await this.get()).body;
  }

  write(data, options) {
    return this.#client.write(this.#key, data, options);
  }

  delete(options) {
    return this.#client.delete(this.#key, options);
  }

  exists(options) {
    return this.#client.exists(this.#key, options);
  }

  stat(options) {
    return this.#client.stat(this.#key, options);
  }

  presign(options) {
    return this.#client.presign(this.#key, options);
  }
}

return { S3Client, S3Error };
})();
