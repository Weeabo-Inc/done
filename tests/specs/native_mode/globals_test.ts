Deno.test("native globals", () => {
  if (typeof setTimeout(() => {}, 0) !== "number") {
    throw new Error("expected a number");
  }
  if (typeof (globalThis as any).process !== "undefined") {
    throw new Error("process should not be defined");
  }
});
