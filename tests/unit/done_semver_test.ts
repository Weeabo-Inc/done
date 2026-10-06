// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function doneSemver() {
  assertEquals(Deno.semver.parse("1.2.3-beta.1+build.5"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ["beta", "1"],
    build: ["build", "5"],
  });
  assertEquals(Deno.semver.parse("v2.0.0").major, 2);
  assert(Deno.semver.valid("1.0.0"));
  assert(!Deno.semver.valid("1.0"));
  assertThrows(() => Deno.semver.parse("nope"), TypeError);

  assertEquals(Deno.semver.compare("1.0.0", "1.0.1"), -1);
  assertEquals(Deno.semver.compare("1.0.0", "1.0.0"), 0);
  assertEquals(Deno.semver.compare("1.0.0", "1.0.0-rc.1"), 1);
  assertEquals(
    Deno.semver.sort(["1.10.0", "1.2.0", "1.2.0-rc.1"]),
    ["1.2.0-rc.1", "1.2.0", "1.10.0"],
  );

  assert(Deno.semver.satisfies("1.4.2", "^1.2.0"));
  assert(!Deno.semver.satisfies("2.0.0", "^1.2.0"));
  assert(Deno.semver.satisfies("1.2.5", "~1.2.0"));
  assert(Deno.semver.satisfies("3.0.0", ">=2 <4"));
  assertEquals(
    Deno.semver.maxSatisfying(["1.0.0", "1.5.0", "2.0.0"], "^1"),
    "1.5.0",
  );
  assertEquals(Deno.semver.maxSatisfying(["1.0.0"], "^2"), undefined);
});

Deno.test(function doneUuid() {
  const v4 = Deno.uuid.v4();
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(v4),
    v4,
  );
  const a = Deno.uuid.v7();
  const b = Deno.uuid.v7();
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(a),
    a,
  );
  // v7 UUIDs sort by creation time.
  assert(a < b || a.slice(0, 13) === b.slice(0, 13));
  assert(Deno.uuid.validate(a));
  assert(!Deno.uuid.validate("not-a-uuid"));
});
