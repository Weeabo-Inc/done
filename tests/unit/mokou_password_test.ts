// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertRejects } from "./test_util.ts";

Deno.test(async function donePasswordArgon2() {
  const hash = await Deno.password.hash("hunter2", {
    memoryCost: 64,
    timeCost: 1,
  });
  assert(hash.startsWith("$argon2id$v=19$m=64,t=1,p=1$"), hash);
  assert(await Deno.password.verify("hunter2", hash));
  assert(!await Deno.password.verify("hunter3", hash));
  // Salts are random.
  const again = await Deno.password.hash("hunter2", {
    memoryCost: 64,
    timeCost: 1,
  });
  assert(again !== hash);
});

Deno.test(async function donePasswordDefaults() {
  const hash = await Deno.password.hash("correct horse battery staple");
  assert(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"), hash);
  assert(await Deno.password.verify("correct horse battery staple", hash));
});

Deno.test(async function donePasswordBcrypt() {
  const hash = await Deno.password.hash("hunter2", {
    algorithm: "bcrypt",
    cost: 4,
  });
  assert(hash.startsWith("$2b$04$"), hash);
  assert(await Deno.password.verify("hunter2", hash));
  assert(!await Deno.password.verify("hunter3", hash));
});

Deno.test(async function donePasswordKnownHash() {
  // From the Argon2 reference implementation's README.
  assert(
    await Deno.password.verify(
      "password",
      "$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG",
    ),
  );
});

Deno.test(async function donePasswordErrors() {
  await assertRejects(
    () => Deno.password.verify("x", "not a hash"),
    TypeError,
    "Unrecognized password hash format",
  );
  await assertRejects(
    // @ts-expect-error invalid algorithm
    () => Deno.password.hash("x", { algorithm: "md5" }),
    TypeError,
    "Unsupported password hashing algorithm",
  );
  await assertRejects(
    () => Deno.password.hash("x".repeat(73), { algorithm: "bcrypt", cost: 4 }),
    RangeError,
  );
  assertEquals(typeof Deno.password.hash, "function");
});
