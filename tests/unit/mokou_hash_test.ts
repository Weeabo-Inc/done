// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function doneHashCrc32() {
  // The standard CRC-32 check value.
  assertEquals(Deno.hash.crc32("123456789"), 0xcbf43926);
  assertEquals(Deno.hash.crc32(""), 0);
  // Chunked hashing matches one-shot hashing.
  const part = Deno.hash.crc32("12345");
  assertEquals(Deno.hash.crc32("6789", part), 0xcbf43926);
  assertEquals(
    Deno.hash.crc32(new TextEncoder().encode("123456789")),
    0xcbf43926,
  );
});

Deno.test(function doneHashXxhash() {
  // Reference values from the xxHash test vectors for empty input.
  assertEquals(Deno.hash.xxhash32(""), 0x02cc5d05);
  assertEquals(Deno.hash.xxhash64(""), 0xef46db3751d8e999n);
  assertEquals(Deno.hash.xxhash3(""), 0x2d06800538d394c2n);
  // Same input, same output, across input types.
  const bytes = new TextEncoder().encode("hello");
  assertEquals(Deno.hash.xxhash64("hello"), Deno.hash.xxhash64(bytes));
  assertEquals(
    Deno.hash.xxhash64("hello"),
    Deno.hash.xxhash64(bytes.buffer),
  );
  // Seeds change the result.
  assertEquals(
    Deno.hash.xxhash64("hello", 1n) !== Deno.hash.xxhash64("hello"),
    true,
  );
  assertEquals(Deno.hash.xxhash3("hello", 1), Deno.hash.xxhash3("hello", 1n));
});

Deno.test(function doneHashRejectsBadInput() {
  // @ts-expect-error invalid input
  assertThrows(() => Deno.hash.crc32(42), TypeError);
});

Deno.test(async function doneHashDigestMatchesWebCrypto() {
  const data = new TextEncoder().encode("The quick brown fox");
  for (
    const [name, webName] of [
      ["sha1", "SHA-1"],
      ["sha256", "SHA-256"],
      ["sha384", "SHA-384"],
      ["sha512", "SHA-512"],
    ] as const
  ) {
    const expected = new Uint8Array(
      await crypto.subtle.digest(webName, data),
    );
    assertEquals(Deno.hash.digest(name, data), expected);
    assertEquals(Deno.hash.digest(webName, data), expected);
  }
  assertEquals(
    Deno.hash.digest("md5", "abc", "hex"),
    "900150983cd24fb0d6963f7d28e17f72",
  );
  assertEquals(
    Deno.hash.digest("sha256", "abc", "base64"),
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
  );
});

Deno.test(function doneHashDigestRejectsUnknownNames() {
  // @ts-expect-error unsupported algorithm
  assertThrows(() => Deno.hash.digest("sha3-256", "x"), TypeError);
  // @ts-expect-error unsupported encoding
  assertThrows(() => Deno.hash.digest("sha256", "x", "utf8"), TypeError);
});
