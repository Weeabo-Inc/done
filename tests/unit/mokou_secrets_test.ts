// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertRejects } from "./test_util.ts";

// The in-memory store, so tests never touch the machine's real credentials.
function useMemoryStore() {
  Deno.env.set("MOKOU_SECRETS_BACKEND", "memory");
}

Deno.test(
  { permissions: { sys: ["secrets"], env: true } },
  async function secretsRoundTrip() {
    useMemoryStore();
    const key = { service: "mokou-test", name: "token" };
    assertEquals(await Deno.secrets.get(key), null);
    await Deno.secrets.set({ ...key, value: "s3cr3t ✓" });
    assertEquals(await Deno.secrets.get(key), "s3cr3t ✓");
    await Deno.secrets.set({ ...key, value: "rotated" });
    assertEquals(await Deno.secrets.get(key), "rotated");
    // Service and name together identify a secret.
    assertEquals(await Deno.secrets.get({ ...key, name: "other" }), null);
    assertEquals(
      await Deno.secrets.get({ service: "other", name: key.name }),
      null,
    );
    assertEquals(await Deno.secrets.delete(key), true);
    assertEquals(await Deno.secrets.delete(key), false);
    assertEquals(await Deno.secrets.get(key), null);
  },
);

Deno.test(
  { permissions: { sys: ["secrets"], env: true } },
  async function secretsValidatesArguments() {
    useMemoryStore();
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => Deno.secrets.get("token" as any),
      TypeError,
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => Deno.secrets.get({ service: "s" } as any),
      TypeError,
    );
    await assertRejects(
      () => Deno.secrets.get({ service: "", name: "n" }),
      TypeError,
      "non-empty",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => Deno.secrets.set({ service: "s", name: "n", value: 1 as any }),
      TypeError,
      "value",
    );
  },
);

Deno.test(
  { permissions: { sys: ["hostname"], env: true } },
  async function secretsNeedSysPermission() {
    useMemoryStore();
    const key = { service: "mokou-test", name: "token" };
    await assertRejects(() => Deno.secrets.get(key), Deno.errors.NotCapable);
    await assertRejects(
      () => Deno.secrets.set({ ...key, value: "v" }),
      Deno.errors.NotCapable,
    );
    await assertRejects(() => Deno.secrets.delete(key), Deno.errors.NotCapable);
  },
);

Deno.test(async function secretsPermissionCanBeQueried() {
  const status = await Deno.permissions.query({ name: "sys", kind: "secrets" });
  assertEquals(typeof status.state, "string");
});
