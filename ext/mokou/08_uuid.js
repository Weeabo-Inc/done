// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.uuid`: random (v4) and time-ordered (v7) UUIDs.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_uuid_v4, op_done_uuid_v7 } = core.ops;
const { ObjectFreeze, RegExpPrototypeTest, SafeRegExp } = primordials;

const UUID_RE = new SafeRegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "i",
);

const uuid = ObjectFreeze({
  v4: () => op_done_uuid_v4(),
  v7: () => op_done_uuid_v7(),
  validate: (value) =>
    typeof value === "string" && RegExpPrototypeTest(UUID_RE, value),
});

return { uuid };
})();
