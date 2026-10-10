// Copyright 2018-2026 the Deno authors. MIT license.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./test_util.ts";

const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

Deno.test(function s3PresignMatchesAwsExample() {
  // The example from the AWS docs on query-string authentication.
  const s3 = new Deno.S3Client({
    ...credentials,
    region: "us-east-1",
    bucket: "examplebucket",
    endpoint: "https://s3.amazonaws.com",
    virtualHostedStyle: true,
  });
  assertEquals(
    s3.presign("test.txt", {
      expiresIn: 86400,
      date: new Date("2013-05-24T00:00:00Z"),
    }),
    "https://examplebucket.s3.amazonaws.com/test.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

Deno.test(function s3OptionsAreValidated() {
  assertThrows(
    () =>
      new Deno.S3Client({ ...credentials, bucket: "b" }).presign("k", {
        expiresIn: 604801,
      }),
    TypeError,
    "expiresIn",
  );
  const s3 = new Deno.S3Client({ ...credentials, bucket: "b" });
  assertThrows(() => s3.file(""), TypeError);
  assertThrows(() => s3.file("a/../b"), TypeError, '".."');
  // AWS defaults to virtual-hosted URLs, in the configured region.
  assert(
    s3.presign("a b+c.txt").startsWith(
      "https://b.s3.us-east-1.amazonaws.com/a%20b%2Bc.txt?",
    ),
  );
});

// --- A small in-memory S3 server that checks every signature ---------------

const encoder = new TextEncoder();

async function hmac(key: Uint8Array | string, data: string) {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)),
  );
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recomputes the SigV4 signature of a request, independently of Mokou's
 * implementation, the way S3 does when it receives one. */
async function expectedSignature(
  req: Request,
  url: URL,
  body: Uint8Array<ArrayBuffer>,
) {
  const auth = req.headers.get("authorization")!;
  const signedHeaders = auth.match(/SignedHeaders=([^,]+)/)![1].split(";");
  const amzDate = req.headers.get("x-amz-date")!;
  const payloadHash = req.headers.get("x-amz-content-sha256")!;
  assertEquals(payloadHash, await sha256Hex(body));
  const query = [...url.searchParams]
    .map(([k, v]) =>
      `${encodeURIComponent(k)}=${
        encodeURIComponent(v).replace(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        )
      }`
    )
    .sort()
    .join("&");
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${req.headers.get(name)!.trim()}\n`)
    .join("");
  const canonicalRequest = [
    req.method,
    url.pathname,
    query,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${amzDate.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(encoder.encode(canonicalRequest)),
  ].join("\n");
  let key = await hmac(
    `AWS4${credentials.secretAccessKey}`,
    amzDate.slice(0, 8),
  );
  for (const part of ["us-east-1", "s3", "aws4_request"]) {
    key = await hmac(key, part);
  }
  return toHex(await hmac(key, stringToSign));
}

function xmlEscape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function startMockS3() {
  const objects = new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; type: string }
  >();
  const requests: string[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    const signature = req.headers.get("authorization")!.match(
      /Signature=([0-9a-f]+)/,
    )![1];
    if (signature !== await expectedSignature(req, url, body)) {
      return new Response(
        "<Error><Code>SignatureDoesNotMatch</Code><Message>Bad signature</Message></Error>",
        { status: 403 },
      );
    }
    const [, bucket, ...rest] = url.pathname.split("/");
    assertEquals(bucket, "test-bucket");
    const key = decodeURIComponent(rest.join("/"));
    requests.push(`${req.method} ${key}${url.search}`);
    if (req.method === "PUT") {
      objects.set(key, {
        body,
        type: req.headers.get("content-type") ?? "binary/octet-stream",
      });
      return new Response(null, { headers: { etag: '"etag"' } });
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && key === "") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      const max = Number(url.searchParams.get("max-keys") ?? 1000);
      const after = url.searchParams.get("continuation-token") ?? "";
      let keys = [...objects.keys()].sort().filter((k) =>
        k.startsWith(prefix) && k > after
      );
      const prefixes = new Set<string>();
      if (delimiter) {
        keys = keys.filter((k) => {
          const i = k.indexOf(delimiter, prefix.length);
          if (i === -1) return true;
          prefixes.add(k.slice(0, i + 1));
          return false;
        });
      }
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          page.map((k) =>
            `<Contents><Key>${xmlEscape(k)}</Key><Size>${
              objects.get(k)!.body.length
            }</Size><LastModified>2026-01-02T03:04:05.000Z</LastModified><ETag>&quot;etag&quot;</ETag></Contents>`
          ).join("") +
          [...prefixes].map((p) =>
            `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`
          ).join("") +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated
            ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>`
            : "") +
          `</ListBucketResult>`,
      );
    }
    const object = objects.get(key);
    if (!object) {
      return new Response(
        req.method === "HEAD"
          ? null
          : "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>",
        { status: 404 },
      );
    }
    let data = object.body;
    const range = req.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      data = data.slice(
        Number(range[1]),
        range[2] ? Number(range[2]) + 1 : undefined,
      );
    }
    const headers = {
      "content-type": object.type,
      "content-length": String(object.body.length),
      "last-modified": "Fri, 02 Jan 2026 03:04:05 GMT",
      etag: '"etag"',
    };
    if (req.method === "HEAD") return new Response(null, { headers });
    return new Response(data, {
      status: range ? 206 : 200,
      headers: { ...headers, "content-length": String(data.length) },
    });
  });
  const s3 = new Deno.S3Client({
    ...credentials,
    region: "us-east-1",
    bucket: "test-bucket",
    endpoint: `http://127.0.0.1:${server.addr.port}`,
  });
  return { s3, server, requests };
}

Deno.test(
  { permissions: { net: true } },
  async function s3ReadWriteDelete() {
    const { s3, server, requests } = startMockS3();
    try {
      const file = s3.file("dir/hello world.txt");
      assertEquals(await file.exists(), false);
      assertEquals(
        await file.write("Hello, S3!", { type: "text/plain" }),
        { etag: '"etag"' },
      );
      assertEquals(await file.exists(), true);
      assertEquals(await file.text(), "Hello, S3!");
      const stat = await file.stat();
      assertEquals(stat.size, 10);
      assertEquals(stat.type, "text/plain");
      assertEquals(stat.lastModified, new Date("2026-01-02T03:04:05Z"));

      const ranged = await s3.get("dir/hello world.txt", {
        range: { start: 7, end: 8 },
      });
      assertEquals(await ranged.text(), "S3");

      await s3.write(
        "data.json",
        new Blob(['{"a":1}'], { type: "application/json" }),
      );
      assertEquals(await s3.file("data.json").json(), { a: 1 });
      assertEquals((await s3.stat("data.json")).type, "application/json");
      await s3.write("bytes.bin", new Uint8Array([1, 2, 3]));
      assertEquals(
        await s3.file("bytes.bin").bytes(),
        new Uint8Array([1, 2, 3]),
      );
      await s3.write(
        "stream.txt",
        ReadableStream.from([encoder.encode("str"), encoder.encode("eam")]),
      );
      assertEquals(await s3.file("stream.txt").text(), "stream");

      await file.delete();
      assertEquals(await file.exists(), false);
      const error = await assertRejects(() => file.text(), Deno.S3Error);
      assertEquals(error.code, "NoSuchKey");
      assertEquals(error.status, 404);
      assert(requests.includes("PUT dir/hello world.txt"));
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  { permissions: { net: true } },
  async function s3List() {
    const { s3, server } = startMockS3();
    try {
      for (const key of ["a/1.txt", "a/2.txt", "a/sub/3.txt", "b & c.txt"]) {
        await s3.write(key, "x");
      }
      const all = await s3.list();
      assertEquals(all.contents.map((c) => c.key), [
        "a/1.txt",
        "a/2.txt",
        "a/sub/3.txt",
        "b & c.txt",
      ]);
      assertEquals(all.contents[0].size, 1);
      assertEquals(all.contents[0].etag, '"etag"');
      assertEquals(all.isTruncated, false);

      const folders = await s3.list({ prefix: "a/", delimiter: "/" });
      assertEquals(folders.contents.map((c) => c.key), ["a/1.txt", "a/2.txt"]);
      assertEquals(folders.commonPrefixes, ["a/sub/"]);

      const first = await s3.list({ maxKeys: 2 });
      assertEquals(first.isTruncated, true);
      const second = await s3.list({
        maxKeys: 2,
        continuationToken: first.nextContinuationToken,
      });
      assertEquals(second.contents.map((c) => c.key), [
        "a/sub/3.txt",
        "b & c.txt",
      ]);
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  { permissions: { net: true } },
  async function s3SignatureErrorsSurface() {
    const { server } = startMockS3();
    try {
      const wrong = new Deno.S3Client({
        ...credentials,
        secretAccessKey: "not-the-secret",
        bucket: "test-bucket",
        endpoint: `http://127.0.0.1:${server.addr.port}`,
      });
      const error = await assertRejects(
        () => wrong.write("k", "v"),
        Deno.S3Error,
        "Bad signature",
      );
      assertEquals(error.code, "SignatureDoesNotMatch");
      assertEquals(error.status, 403);
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(function s3SessionTokenIsSigned() {
  const s3 = new Deno.S3Client({
    ...credentials,
    sessionToken: "token/with+chars",
    bucket: "b",
  });
  const url = new URL(s3.presign("k"));
  assertEquals(
    url.searchParams.get("X-Amz-Security-Token"),
    "token/with+chars",
  );
});

Deno.test(
  { permissions: { env: false } },
  function s3WithCredentialsDoesNotReadTheEnvironment() {
    const s3 = new Deno.S3Client({ ...credentials, bucket: "b" });
    assertEquals(s3.region, "us-east-1");
  },
);

Deno.test(
  { permissions: { env: true } },
  function s3IsConfiguredFromTheEnvironment() {
    const vars = {
      S3_ACCESS_KEY_ID: credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      S3_BUCKET: "env-bucket",
      S3_REGION: "eu-west-1",
    };
    for (const [name, value] of Object.entries(vars)) Deno.env.set(name, value);
    try {
      const s3 = new Deno.S3Client();
      assertEquals(s3.bucket, "env-bucket");
      assertEquals(s3.region, "eu-west-1");
    } finally {
      for (const name of Object.keys(vars)) Deno.env.delete(name);
    }
  },
);
