Deno.test("fails", () => {
  Deno.assertEquals({ a: 1 }, { a: 2 });
});
