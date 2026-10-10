// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertThrows } from "./test_util.ts";

const { expect, mock } = Deno;

Deno.test(function mockFnRecordsCalls() {
  const add = mock.fn((a: number, b: number) => a + b);
  assertEquals(add.name, "mock");
  assertEquals(add(1, 2), 3);
  assertEquals(add.call({ self: 1 }, 3, 4), 7);
  assertEquals(add.mock.calls, [[1, 2], [3, 4]]);
  assertEquals(add.mock.lastCall, [3, 4]);
  assertEquals(add.mock.results, [
    { type: "return", value: 3 },
    { type: "return", value: 7 },
  ]);
  assertEquals(add.mock.contexts[1], { self: 1 });
  assert(mock.isMock(add));
  assert(!mock.isMock(() => {}));

  const empty = mock.fn();
  assertEquals(empty("x"), undefined);
  assertEquals(empty.name, "mock");

  function named() {}
  assertEquals(mock.fn(named).name, "named");
});

Deno.test(function mockFnRecordsThrowsAndConstructs() {
  const boom = mock.fn(() => {
    throw new RangeError("boom");
  });
  assertThrows(() => boom(), RangeError);
  assertEquals(boom.mock.results[0].type, "throw");
  assert(boom.mock.results[0].value instanceof RangeError);

  class Point {
    constructor(public x: number) {}
  }
  const MockPoint = mock.fn(Point as unknown as (x: number) => Point);
  const p = new MockPoint(5);
  assert(p instanceof Point);
  assert(p instanceof MockPoint);
  assertEquals(p.x, 5);
  assertEquals(MockPoint.mock.instances, [p]);
});

Deno.test(async function mockImplementations() {
  const f = mock.fn((): number => 0);
  f.mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValue(9);
  assertEquals([f(), f(), f(), f()], [1, 2, 9, 9]);
  f.mockImplementation(() => 5).mockImplementationOnce(() => 4);
  assertEquals([f(), f()], [4, 5]);

  const load = mock.fn((): Promise<string> => Promise.resolve("real"));
  load.mockResolvedValueOnce("once").mockRejectedValue(new Error("down"));
  assertEquals(await load(), "once");
  await load().then(
    () => assert(false),
    (e) => assertEquals(e.message, "down"),
  );

  f.mockClear();
  assertEquals(f.mock.calls, []);
  assertEquals(f(), 5);
  // Reset goes back to the original implementation.
  f.mockReset();
  assertEquals(f.mock.calls, []);
  assertEquals(f(), 0);
});

Deno.test(function mockSpyOn() {
  const counter = {
    count: 0,
    increment(by: number) {
      this.count += by;
      return this.count;
    },
  };
  const spy = mock.spyOn(counter, "increment");
  assertEquals(counter.increment(2), 2);
  assertEquals(counter.count, 2);
  expect(spy).toHaveBeenCalledWith(2);
  assertEquals(spy.mock.contexts, [counter]);
  // Spying twice returns the same mock.
  assert(mock.spyOn(counter, "increment") === spy);

  spy.mockImplementation(() => -1);
  assertEquals(counter.increment(5), -1);
  assertEquals(counter.count, 2);

  spy.mockRestore();
  assert(!mock.isMock(counter.increment));
  assertEquals(counter.increment(1), 3);
  assert(Object.hasOwn(counter, "increment"));

  // Inherited methods are shadowed, then the shadow is removed.
  class Greeter {
    greet() {
      return "hi";
    }
  }
  const g = new Greeter();
  const greet = mock.spyOn(g, "greet").mockReturnValue("mocked");
  assertEquals(g.greet(), "mocked");
  const logSpy = mock.spyOn(console, "log").mockImplementation(() => {});
  // deno-lint-ignore no-console
  console.log("hidden");
  expect(logSpy).toHaveBeenCalledWith("hidden");
  mock.restoreAll();
  assertEquals(g.greet(), "hi");
  assert(!Object.hasOwn(g, "greet"));
  // deno-lint-ignore no-console
  assert(!mock.isMock(console.log));
  greet.mockRestore(); // Restoring twice is harmless.

  assertThrows(
    () => mock.spyOn(counter, "count" as never),
    TypeError,
    "not a function",
  );
});

Deno.test(function mockMatchers() {
  const f = mock.fn((x: number, _y?: number) => x * 2);
  expect(f).not.toHaveBeenCalled();
  f(1);
  f(2, 3);
  expect(f).toHaveBeenCalled();
  expect(f).toHaveBeenCalledTimes(2);
  expect(f).toHaveBeenCalledWith(1);
  expect(f).toHaveBeenCalledWith(2, 3);
  expect(f).not.toHaveBeenCalledWith(3);
  expect(f).toHaveBeenLastCalledWith(2, 3);
  expect(f).toHaveBeenNthCalledWith(1, 1);
  expect(f).toHaveReturned();
  expect(f).toHaveReturnedTimes(2);
  expect(f).toHaveReturnedWith(4);
  expect(f).toHaveLastReturnedWith(4);
  expect(f).not.toHaveLastReturnedWith(2);

  const err = assertThrows(
    () => expect(f).toHaveBeenCalledTimes(3),
    Deno.AssertionError,
  );
  assert(err.message.includes("called 3 times, but it was called 2 times"));
  assertThrows(
    () => expect(f).toHaveBeenCalledWith({ deep: true }),
    Deno.AssertionError,
    "calls: [",
  );
  assertThrows(
    () => expect(() => {}).toHaveBeenCalled(),
    TypeError,
    "expects a mock function",
  );
});
