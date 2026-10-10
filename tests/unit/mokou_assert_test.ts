// Copyright 2018-2026 the Deno authors. MIT license.
import * as std from "./test_util.ts";

Deno.test(function doneAssertPasses() {
  Deno.assert(true);
  Deno.assertFalse(0);
  Deno.assertEquals({ a: [1, { b: 2 }], c: new Set([1]) }, {
    a: [1, { b: 2 }],
    c: new Set([1]),
  });
  Deno.assertEquals(new Map([["a", 1]]), new Map([["a", 1]]));
  Deno.assertEquals(new Date(0), new Date(0));
  Deno.assertEquals(/a/g, /a/g);
  Deno.assertEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]));
  Deno.assertEquals(NaN, NaN);
  Deno.assertEquals({ a: undefined }, {});
  Deno.assertNotEquals({ a: 1 }, { a: 2 });
  Deno.assertStrictEquals(1, 1);
  Deno.assertNotStrictEquals({}, {});
  Deno.assertExists(0);
  Deno.assertInstanceOf(new TypeError(), Error);
  Deno.assertMatch("hello", /ell/);
  Deno.assertStringIncludes("hello", "ll");
  Deno.assertArrayIncludes([1, { a: 1 }], [{ a: 1 }]);
  Deno.assertObjectMatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } });
});

Deno.test(function doneAssertFails() {
  const e = std.assertThrows(
    () => Deno.assertEquals({ a: 1 }, { a: 2 }),
    Deno.AssertionError,
    "Values are not equal",
  );
  std.assertEquals(e.name, "AssertionError");
  std.assertThrows(
    () => Deno.assert(false, "nope"),
    Deno.AssertionError,
    "nope",
  );
  std.assertThrows(() => Deno.assertEquals([1], [1, 2]), Deno.AssertionError);
  std.assertThrows(
    () => Deno.assertEquals(new Set([1]), new Set([2])),
    Deno.AssertionError,
  );
  std.assertThrows(() => Deno.assertStrictEquals({}, {}), Deno.AssertionError);
  std.assertThrows(() => Deno.assertExists(null), Deno.AssertionError);
  std.assertThrows(() => Deno.fail("boom"), Deno.AssertionError, "boom");
  std.assertThrows(() => Deno.unreachable(), Deno.AssertionError);
});

Deno.test(async function doneAssertThrowsAndRejects() {
  const err = Deno.assertThrows(
    () => {
      throw new RangeError("out of range");
    },
    RangeError,
    "range",
  );
  std.assertEquals(err.message, "out of range");
  std.assertThrows(
    () => Deno.assertThrows(() => {}),
    Deno.AssertionError,
    "Expected function to throw",
  );
  std.assertThrows(
    () =>
      Deno.assertThrows(() => {
        throw new TypeError("x");
      }, RangeError),
    Deno.AssertionError,
  );
  await Deno.assertRejects(
    () => Promise.reject(new TypeError("bad")),
    TypeError,
  );
  await std.assertRejects(
    () => Deno.assertRejects(() => Promise.resolve()),
    Deno.AssertionError,
  );
});

Deno.test(async function doneExpect() {
  Deno.expect(1 + 1).toBe(2);
  Deno.expect({ a: 1 }).toEqual({ a: 1 });
  Deno.expect({ a: 1 }).not.toBe({ a: 1 });
  Deno.expect({ a: 1, b: 2 }).toMatchObject({ a: 1 });
  Deno.expect([1, 2, 3]).toContain(2);
  Deno.expect([{ a: 1 }]).toContainEqual({ a: 1 });
  Deno.expect("abc").toHaveLength(3);
  Deno.expect("abc").toMatch(/b/);
  Deno.expect(0.1 + 0.2).toBeCloseTo(0.3);
  Deno.expect(5).toBeGreaterThan(4);
  Deno.expect(null).toBeNull();
  Deno.expect(undefined).toBeUndefined();
  Deno.expect({ a: { b: 1 } }).toHaveProperty("a");
  Deno.expect(() => {
    throw new TypeError("boom");
  }).toThrow(TypeError);
  Deno.expect(() => {
    throw new Error("boom");
  }).toThrow("bo");
  await Deno.expect(Promise.resolve(3)).resolves.toBe(3);
  await Deno.expect(Promise.reject(new Error("x"))).rejects.toThrow("x");

  std.assertThrows(() => Deno.expect(1).toBe(2), Deno.AssertionError);
  std.assertThrows(() => Deno.expect(1).not.toBe(1), Deno.AssertionError);
  await std.assertRejects(
    () => Deno.expect(Promise.resolve(1)).rejects.toThrow(),
    Deno.AssertionError,
  );
});

Deno.test(function deepEqualsMatchesAssertEquals() {
  const { assertEquals } = std;
  assertEquals(
    Deno.deepEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
    true,
  );
  assertEquals(Deno.deepEquals([1, 2], [2, 1]), false);
  assertEquals(Deno.deepEquals(NaN, NaN), true);
  assertEquals(
    Deno.deepEquals(new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])),
    true,
  );
  assertEquals(
    Deno.deepEquals(new Set([{ a: 1 }]), new Set([{ a: 2 }])),
    false,
  );
  assertEquals(Deno.deepEquals(new Date(1), new Date(1)), true);
  assertEquals(Deno.deepEquals(new Uint8Array([1]), new Uint8Array([1])), true);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclic2: Record<string, unknown> = {};
  cyclic2.self = cyclic2;
  assertEquals(Deno.deepEquals(cyclic, cyclic2), true);

  // Loose by default, like `assertEquals`; `strict` is like `toStrictEqual`.
  assertEquals(Deno.deepEquals({ a: undefined }, {}), true);
  assertEquals(Deno.deepEquals({ a: undefined }, {}, true), false);
  class A {
    x = 1;
  }
  assertEquals(Deno.deepEquals(new A(), { x: 1 }), true);
  assertEquals(Deno.deepEquals(new A(), { x: 1 }, true), false);
});
