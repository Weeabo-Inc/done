// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertThrows } from "./test_util.ts";

const secret = "a-secret-of-at-least-thirty-two-bytes";

Deno.test(function csrfRoundTrip() {
  const token = Deno.csrf.generate({ secret });
  assertEquals(token.length, 86);
  assert(/^[A-Za-z0-9_-]+$/.test(token));
  assert(Deno.csrf.verify(token, { secret }));
  assert(Deno.csrf.verify(token, { secret: new TextEncoder().encode(secret) }));
  // Each token is different.
  assert(Deno.csrf.generate({ secret }) !== token);
});

Deno.test(function csrfDefaultSecret() {
  const token = Deno.csrf.generate();
  assert(Deno.csrf.verify(token));
  assert(!Deno.csrf.verify(token, { secret }));
  assert(!Deno.csrf.verify(Deno.csrf.generate({ secret })));
});

Deno.test(function csrfRejectsInvalidTokens() {
  const token = Deno.csrf.generate({ secret });
  assert(!Deno.csrf.verify(token, { secret: "another-secret" }));
  for (const bad of ["", "abc", token + "A", token.slice(1), undefined, 1]) {
    assert(!Deno.csrf.verify(bad, { secret }));
  }
  // Changing any character of the token invalidates it.
  for (let i = 0; i < token.length - 1; i++) {
    const c = token[i] === "A" ? "B" : "A";
    const tampered = token.slice(0, i) + c + token.slice(i + 1);
    assert(!Deno.csrf.verify(tampered, { secret }), `position ${i}`);
  }
});

Deno.test(function csrfIsBoundToContext() {
  const token = Deno.csrf.generate({ secret, context: "session-1" });
  assert(Deno.csrf.verify(token, { secret, context: "session-1" }));
  assert(!Deno.csrf.verify(token, { secret, context: "session-2" }));
  assert(!Deno.csrf.verify(token, { secret }));
});

Deno.test(function csrfExpires() {
  const expired = Deno.csrf.generate({ secret, expiresIn: 1 });
  const start = Date.now();
  while (Date.now() - start < 5) { /* wait */ }
  assert(!Deno.csrf.verify(expired, { secret }));

  const token = Deno.csrf.generate({ secret });
  assert(Deno.csrf.verify(token, { secret, maxAge: 60_000 }));
  const old = Deno.csrf.generate({ secret });
  const t = Date.now();
  while (Date.now() - t < 5) { /* wait */ }
  assert(!Deno.csrf.verify(old, { secret, maxAge: 1 }));
});

Deno.test(function csrfValidatesOptions() {
  assertThrows(() => Deno.csrf.generate({ secret: "" }), TypeError, "empty");
  assertThrows(() => Deno.csrf.generate({ expiresIn: -1 }), TypeError);
  assertThrows(
    () => Deno.csrf.generate({ secret: 1 as unknown as string }),
    TypeError,
  );
  assertThrows(() => Deno.csrf.verify("x", { maxAge: NaN }), TypeError);
});
