// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertThrows } from "./test_util.ts";

const info = {} as Deno.ServeHandlerInfo;

async function call(
  handler: (
    req: Request,
    info: Deno.ServeHandlerInfo,
  ) => Response | Promise<Response>,
  method: string,
  path: string,
) {
  const res = await handler(
    new Request(`http://localhost${path}`, { method }),
    info,
  );
  return {
    status: res.status,
    body: await res.text(),
    allow: res.headers.get("allow"),
  };
}

Deno.test(async function doneRouter() {
  const handler = Deno.router({
    "GET /": () => new Response("home"),
    "GET /users/:id": (_req, { params, route }) =>
      new Response(`user ${params.id} via ${route}`),
    "POST /users": () => new Response("created", { status: 201 }),
    "/static/*": (req) => new Response(new URL(req.url).pathname),
  });
  assertEquals(await call(handler, "GET", "/"), {
    status: 200,
    body: "home",
    allow: null,
  });
  assertEquals(
    (await call(handler, "GET", "/users/42")).body,
    "user 42 via GET /users/:id",
  );
  assertEquals((await call(handler, "HEAD", "/users/42")).status, 200);
  assertEquals((await call(handler, "POST", "/users")).status, 201);
  assertEquals(
    (await call(handler, "DELETE", "/static/a/b.css")).body,
    "/static/a/b.css",
  );
  assertEquals(await call(handler, "DELETE", "/users"), {
    status: 405,
    body: "Method Not Allowed",
    allow: "POST",
  });
  assertEquals((await call(handler, "GET", "/nope")).status, 404);
});

Deno.test(async function doneRouterFallbackAndOrder() {
  const handler = Deno.router([
    ["GET /a/:x", () => new Response("first")],
    ["GET /a/b", () => new Response("second")],
  ], { fallback: () => new Response("fallback", { status: 418 }) });
  assertEquals((await call(handler, "GET", "/a/b")).body, "first");
  assertEquals((await call(handler, "GET", "/z")).status, 418);
});

Deno.test(function doneRouterValidation() {
  assertThrows(
    () => Deno.router({ "FETCH /": () => new Response() }),
    TypeError,
  );
  assertThrows(() => Deno.router({ "nope": () => new Response() }), TypeError);
  // @ts-expect-error handler must be a function
  assertThrows(() => Deno.router({ "/": 1 }), TypeError);
});
