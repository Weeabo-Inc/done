// Copyright 2018-2026 the Deno authors. MIT license.

// Built-in assertions for `Deno.test`, so tests need no `jsr:@std/assert`
// import. `Deno.assert*` follows `@std/assert`, and `Deno.expect` follows the
// Jest-style `@std/expect`.

(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypePush,
  ArrayPrototypeSome,
  DatePrototypeGetTime,
  Error,
  ErrorCaptureStackTrace,
  MapPrototypeGet,
  MapPrototypeGetSize,
  MapPrototypeHas,
  MathAbs,
  MathPow,
  NumberIsNaN,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty,
  ObjectPrototypeIsPrototypeOf,
  ReflectOwnKeys,
  RegExpPrototypeTest,
  RegExpPrototypeToString,
  SafeArrayIterator,
  SafeMapIterator,
  SafeSetIterator,
  SetPrototypeGetSize,
  SetPrototypeHas,
  String,
  StringPrototypeIncludes,
  StringPrototypeReplaceAll,
  TypeError,
  TypedArrayPrototypeGetSymbolToStringTag,
  DatePrototype,
  MapPrototype,
  RegExpPrototype,
  SetPrototype,
  PromisePrototype,
  Proxy,
  ReflectApply,
  ReflectHas,
} = primordials;

const console = core.loadExtScript("ext:deno_web/01_console.js");

function format(value) {
  // Indent continuation lines so multi-line values line up under the label.
  return StringPrototypeReplaceAll(inspect(value), "\n", "\n    ");
}

function inspect(value) {
  return console.inspect(value, {
    depth: Infinity,
    sorted: true,
    trailingComma: true,
    compact: false,
    iterableLimit: Infinity,
    getters: true,
    strAbbreviateSize: Infinity,
  });
}

class AssertionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AssertionError";
  }
}

function fail(message, stackStart = fail) {
  const error = new AssertionError(message);
  ErrorCaptureStackTrace(error, stackStart);
  throw error;
}

function isKeyedCollection(x) {
  return ObjectPrototypeIsPrototypeOf(MapPrototype, x) ||
    ObjectPrototypeIsPrototypeOf(SetPrototype, x);
}

/** Deep structural equality, as used by `assertEquals` and `toEqual`. */
function equal(a, b, strict = false, seen = new primordials.SafeWeakMap()) {
  if (ObjectIs(a, b)) return true;
  if (
    typeof a !== "object" || typeof b !== "object" || a === null || b === null
  ) {
    return typeof a === "number" && typeof b === "number" && NumberIsNaN(a) &&
      NumberIsNaN(b);
  }
  if (strict && ObjectGetPrototypeOf(a) !== ObjectGetPrototypeOf(b)) {
    return false;
  }
  if (seen.get(a) === b) return true;
  seen.set(a, b);

  if (ObjectPrototypeIsPrototypeOf(DatePrototype, a)) {
    return ObjectPrototypeIsPrototypeOf(DatePrototype, b) &&
      ObjectIs(DatePrototypeGetTime(a), DatePrototypeGetTime(b));
  }
  if (ObjectPrototypeIsPrototypeOf(RegExpPrototype, a)) {
    return ObjectPrototypeIsPrototypeOf(RegExpPrototype, b) &&
      RegExpPrototypeToString(a) === RegExpPrototypeToString(b);
  }
  const aTag = TypedArrayPrototypeGetSymbolToStringTag(a);
  if (aTag !== undefined) {
    if (aTag !== TypedArrayPrototypeGetSymbolToStringTag(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!ObjectIs(a[i], b[i])) return false;
    }
    return true;
  }
  if (isKeyedCollection(a) || isKeyedCollection(b)) {
    if (ObjectPrototypeIsPrototypeOf(MapPrototype, a)) {
      if (!ObjectPrototypeIsPrototypeOf(MapPrototype, b)) return false;
      if (MapPrototypeGetSize(a) !== MapPrototypeGetSize(b)) return false;
      for (const { 0: key, 1: value } of new SafeMapIterator(a)) {
        if (!MapPrototypeHas(b, key)) return false;
        if (!equal(value, MapPrototypeGet(b, key), strict, seen)) return false;
      }
      return true;
    }
    if (!ObjectPrototypeIsPrototypeOf(SetPrototype, b)) return false;
    if (SetPrototypeGetSize(a) !== SetPrototypeGetSize(b)) return false;
    for (const value of new SafeSetIterator(a)) {
      if (SetPrototypeHas(b, value)) continue;
      // Fall back to a deep search for object members.
      let found = false;
      for (const other of new SafeSetIterator(b)) {
        if (equal(value, other, strict, seen)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }
  if (ArrayIsArray(a) !== ArrayIsArray(b)) return false;

  const aKeys = strict ? ReflectOwnKeys(a) : ObjectKeys(a);
  const bKeys = strict ? ReflectOwnKeys(b) : ObjectKeys(b);
  if (strict && aKeys.length !== bKeys.length) return false;
  // Outside strict mode, keys whose value is `undefined` are ignored, so
  // `{ a: undefined }` equals `{}`.
  const hasValue = (obj, key) =>
    ObjectPrototypeHasOwnProperty(obj, key) && obj[key] !== undefined;
  for (const key of new SafeArrayIterator(aKeys)) {
    if (!strict && !hasValue(a, key)) continue;
    if (!ObjectPrototypeHasOwnProperty(b, key)) return false;
    if (!equal(a[key], b[key], strict, seen)) return false;
  }
  if (!strict) {
    for (const key of new SafeArrayIterator(bKeys)) {
      if (hasValue(b, key) && !ObjectPrototypeHasOwnProperty(a, key)) {
        return false;
      }
    }
  }
  if (ArrayIsArray(a) && a.length !== b.length) return false;
  return true;
}

function suffix(msg) {
  return msg ? `: ${msg}` : ".";
}

function assert(expr, msg = "") {
  if (!expr) fail(msg || "Expected expression to be truthy", assert);
}

function assertFalse(expr, msg = "") {
  if (expr) fail(msg || "Expected expression to be falsy", assertFalse);
}

function assertEquals(actual, expected, msg) {
  if (!equal(actual, expected)) {
    fail(
      `Values are not equal${suffix(msg)}\n\n    actual: ${
        format(actual)
      }\n  expected: ${format(expected)}`,
      assertEquals,
    );
  }
}

function assertNotEquals(actual, expected, msg) {
  if (equal(actual, expected)) {
    fail(
      `Expected actual: ${format(actual)} not to be: ${format(expected)}${
        suffix(msg)
      }`,
      assertNotEquals,
    );
  }
}

function assertStrictEquals(actual, expected, msg) {
  if (!ObjectIs(actual, expected)) {
    const sameShape = equal(actual, expected);
    fail(
      `Values are not strictly equal${suffix(msg)}\n\n    actual: ${
        format(actual)
      }\n  expected: ${format(expected)}${
        sameShape
          ? "\n\nThey have the same structure but are not the same reference."
          : ""
      }`,
      assertStrictEquals,
    );
  }
}

function assertNotStrictEquals(actual, expected, msg) {
  if (ObjectIs(actual, expected)) {
    fail(
      `Expected "actual" to not be strictly equal to: ${format(expected)}${
        suffix(msg)
      }`,
      assertNotStrictEquals,
    );
  }
}

function assertExists(actual, msg) {
  if (actual === undefined || actual === null) {
    fail(
      `Expected actual: "${actual}" to not be null or undefined${suffix(msg)}`,
      assertExists,
    );
  }
}

function assertInstanceOf(actual, expectedType, msg) {
  if (!ObjectPrototypeIsPrototypeOf(expectedType.prototype, actual)) {
    fail(
      `Expected object to be an instance of "${expectedType.name}"${
        suffix(msg)
      }`,
      assertInstanceOf,
    );
  }
}

function assertMatch(actual, expected, msg) {
  if (!RegExpPrototypeTest(expected, actual)) {
    fail(
      `Expected actual: "${actual}" to match: "${expected}"${suffix(msg)}`,
      assertMatch,
    );
  }
}

function assertStringIncludes(actual, expected, msg) {
  if (!StringPrototypeIncludes(actual, expected)) {
    fail(
      `Expected actual: "${actual}" to contain: "${expected}"${suffix(msg)}`,
      assertStringIncludes,
    );
  }
}

function assertArrayIncludes(actual, expected, msg) {
  const missing = [];
  for (const item of new SafeArrayIterator(expected)) {
    if (!ArrayPrototypeSome(actual, (a) => equal(a, item))) {
      ArrayPrototypePush(missing, item);
    }
  }
  if (missing.length > 0) {
    fail(
      `Expected actual: "${format(actual)}" to include: "${format(expected)}"${
        suffix(msg)
      }\nmissing: ${format(missing)}`,
      assertArrayIncludes,
    );
  }
}

function matchesObject(actual, expected) {
  if (typeof expected !== "object" || expected === null) {
    return equal(actual, expected);
  }
  if (typeof actual !== "object" || actual === null) return false;
  if (ArrayIsArray(expected)) {
    if (!ArrayIsArray(actual) || actual.length !== expected.length) {
      return false;
    }
    for (let i = 0; i < expected.length; i++) {
      if (!matchesObject(actual[i], expected[i])) return false;
    }
    return true;
  }
  for (const key of new SafeArrayIterator(ReflectOwnKeys(expected))) {
    if (!ReflectHas(actual, key)) return false;
    if (!matchesObject(actual[key], expected[key])) return false;
  }
  return true;
}

function assertObjectMatch(actual, expected, msg) {
  if (!matchesObject(actual, expected)) {
    fail(
      `Expected ${format(actual)} to match ${format(expected)}${suffix(msg)}`,
      assertObjectMatch,
    );
  }
}

function checkError(error, ErrorClass, msgIncludes, stackStart) {
  if (ErrorClass === undefined) return;
  if (!ObjectPrototypeIsPrototypeOf(ErrorClass.prototype, error)) {
    fail(
      `Expected error to be instance of "${ErrorClass.name}", but was "${
        error?.constructor?.name ?? typeof error
      }"`,
      stackStart,
    );
  }
  if (
    msgIncludes !== undefined &&
    !StringPrototypeIncludes(String(error?.message), msgIncludes)
  ) {
    fail(
      `Expected error message to include "${msgIncludes}", but got "${error?.message}"`,
      stackStart,
    );
  }
}

function assertThrows(fn, ErrorClass, msgIncludes, msg) {
  if (typeof ErrorClass === "string") {
    msg = ErrorClass;
    ErrorClass = undefined;
  }
  try {
    fn();
  } catch (error) {
    checkError(error, ErrorClass, msgIncludes, assertThrows);
    return error;
  }
  fail(`Expected function to throw${suffix(msg)}`, assertThrows);
}

async function assertRejects(fn, ErrorClass, msgIncludes, msg) {
  if (typeof ErrorClass === "string") {
    msg = ErrorClass;
    ErrorClass = undefined;
  }
  let promise;
  try {
    promise = fn();
  } catch (error) {
    fail(
      `Function throws when expected to reject: ${format(error)}${suffix(msg)}`,
      assertRejects,
    );
  }
  if (!ObjectPrototypeIsPrototypeOf(PromisePrototype, promise)) {
    fail(
      `Function returned a non-promise when expected to reject${suffix(msg)}`,
      assertRejects,
    );
  }
  try {
    await promise;
  } catch (error) {
    checkError(error, ErrorClass, msgIncludes, assertRejects);
    return error;
  }
  fail(`Expected function to reject${suffix(msg)}`, assertRejects);
}

function unreachable(msg) {
  fail(msg ?? "Unreachable code was reached", unreachable);
}

// --- expect ------------------------------------------------------------------

class Expectation {
  #value;
  #not;
  constructor(value, not = false) {
    this.#value = value;
    this.#not = not;
  }

  get not() {
    return new Expectation(this.#value, !this.#not);
  }

  get resolves() {
    return makeAsync(this.#value, this.#not, false);
  }

  get rejects() {
    return makeAsync(this.#value, this.#not, true);
  }

  #check(pass, message, stackStart) {
    if (pass === this.#not) {
      fail(
        this.#not ? `Expected not: ${message}` : `Expected: ${message}`,
        stackStart,
      );
    }
  }

  toBe(expected) {
    this.#check(
      ObjectIs(this.#value, expected),
      `${format(this.#value)} to be ${format(expected)}`,
      this.toBe,
    );
  }

  toEqual(expected) {
    this.#check(
      equal(this.#value, expected),
      `${format(this.#value)} to equal ${format(expected)}`,
      this.toEqual,
    );
  }

  toStrictEqual(expected) {
    this.#check(
      equal(this.#value, expected, true),
      `${format(this.#value)} to strictly equal ${format(expected)}`,
      this.toStrictEqual,
    );
  }

  toMatchObject(expected) {
    this.#check(
      matchesObject(this.#value, expected),
      `${format(this.#value)} to match object ${format(expected)}`,
      this.toMatchObject,
    );
  }

  toBeTruthy() {
    this.#check(
      !!this.#value,
      `${format(this.#value)} to be truthy`,
      this.toBeTruthy,
    );
  }

  toBeFalsy() {
    this.#check(
      !this.#value,
      `${format(this.#value)} to be falsy`,
      this.toBeFalsy,
    );
  }

  toBeNull() {
    this.#check(
      this.#value === null,
      `${format(this.#value)} to be null`,
      this.toBeNull,
    );
  }

  toBeUndefined() {
    this.#check(
      this.#value === undefined,
      `${format(this.#value)} to be undefined`,
      this.toBeUndefined,
    );
  }

  toBeDefined() {
    this.#check(
      this.#value !== undefined,
      `${format(this.#value)} to be defined`,
      this.toBeDefined,
    );
  }

  toBeNaN() {
    this.#check(
      NumberIsNaN(this.#value),
      `${format(this.#value)} to be NaN`,
      this.toBeNaN,
    );
  }

  toBeInstanceOf(expected) {
    this.#check(
      ObjectPrototypeIsPrototypeOf(expected.prototype, this.#value),
      `${format(this.#value)} to be an instance of ${expected.name}`,
      this.toBeInstanceOf,
    );
  }

  toBeGreaterThan(n) {
    this.#check(this.#value > n, `${this.#value} > ${n}`, this.toBeGreaterThan);
  }

  toBeGreaterThanOrEqual(n) {
    this.#check(
      this.#value >= n,
      `${this.#value} >= ${n}`,
      this.toBeGreaterThanOrEqual,
    );
  }

  toBeLessThan(n) {
    this.#check(this.#value < n, `${this.#value} < ${n}`, this.toBeLessThan);
  }

  toBeLessThanOrEqual(n) {
    this.#check(
      this.#value <= n,
      `${this.#value} <= ${n}`,
      this.toBeLessThanOrEqual,
    );
  }

  toBeCloseTo(n, digits = 2) {
    const pass = MathAbs(n - this.#value) < MathPow(10, -digits) / 2;
    this.#check(pass, `${this.#value} to be close to ${n}`, this.toBeCloseTo);
  }

  toContain(item) {
    const value = this.#value;
    const pass = typeof value === "string"
      ? StringPrototypeIncludes(value, item)
      : ArrayIsArray(value)
      ? ArrayPrototypeIncludes(value, item)
      : ObjectPrototypeIsPrototypeOf(SetPrototype, value)
      ? SetPrototypeHas(value, item)
      : false;
    this.#check(
      pass,
      `${format(value)} to contain ${format(item)}`,
      this.toContain,
    );
  }

  toContainEqual(item) {
    const pass = ArrayIsArray(this.#value) &&
      ArrayPrototypeSome(this.#value, (v) => equal(v, item));
    this.#check(
      pass,
      `${format(this.#value)} to contain an element equal to ${format(item)}`,
      this.toContainEqual,
    );
  }

  toHaveLength(length) {
    this.#check(
      this.#value?.length === length,
      `${format(this.#value)} to have length ${length}`,
      this.toHaveLength,
    );
  }

  toHaveProperty(key, ...rest) {
    const value = this.#value;
    const has = (typeof value === "object" && value !== null ||
      typeof value === "function") && ReflectHas(value, key);
    const pass = rest.length === 0
      ? has
      : has && equal(this.#value[key], rest[0]);
    this.#check(
      pass,
      `${format(this.#value)} to have property ${String(key)}`,
      this.toHaveProperty,
    );
  }

  toMatch(pattern) {
    const pass = typeof pattern === "string"
      ? StringPrototypeIncludes(this.#value, pattern)
      : RegExpPrototypeTest(pattern, this.#value);
    this.#check(pass, `"${this.#value}" to match ${pattern}`, this.toMatch);
  }

  toThrow(expected) {
    if (typeof this.#value !== "function") {
      throw new TypeError("toThrow() expects a function");
    }
    let threw = false;
    let error;
    try {
      this.#value();
    } catch (e) {
      threw = true;
      error = e;
    }
    this.#check(
      threw && errorMatches(error, expected),
      `function to throw${
        expected === undefined ? "" : ` ${format(expected)}`
      }`,
      this.toThrow,
    );
  }
}

function errorMatches(error, expected) {
  if (expected === undefined) return true;
  if (typeof expected === "function") {
    return ObjectPrototypeIsPrototypeOf(expected.prototype, error);
  }
  const message = String(error?.message);
  if (typeof expected === "string") {
    return StringPrototypeIncludes(message, expected);
  }
  if (ObjectPrototypeIsPrototypeOf(RegExpPrototype, expected)) {
    return RegExpPrototypeTest(expected, message);
  }
  return equal(error, expected);
}

function makeAsync(value, not, rejects) {
  const settle = async () => {
    let resolved;
    try {
      resolved = await value;
    } catch (error) {
      if (!rejects) {
        fail(
          `Expected promise to resolve, but it rejected with ${format(error)}`,
        );
      }
      return error;
    }
    if (rejects) {
      fail(
        `Expected promise to reject, but it resolved to ${format(resolved)}`,
      );
    }
    return resolved;
  };
  return new Proxy({}, {
    get(_target, name) {
      return async (...args) => {
        const settled = await settle();
        if (rejects && name === "toThrow") {
          // `rejects.toThrow(X)` checks the rejection reason itself.
          const pass = errorMatches(settled, args[0]);
          if (pass === not) {
            fail(
              `Expected${not ? " not" : ""}: promise to reject with ${
                format(args[0])
              }`,
            );
          }
          return;
        }
        const expectation = new Expectation(settled, not);
        return ReflectApply(expectation[name], expectation, args);
      };
    },
  });
}

function expect(value) {
  return new Expectation(value);
}

return {
  AssertionError,
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertInstanceOf,
  assertMatch,
  assertNotEquals,
  assertNotStrictEquals,
  assertObjectMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
  equal,
  expect,
  fail,
  unreachable,
};
})();
