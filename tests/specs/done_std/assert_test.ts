Deno.test("built-in asserts", () => {
  Deno.assertEquals({ a: [1, 2] }, { a: [1, 2] });
  Deno.expect("done").toMatch(/one/);
});
