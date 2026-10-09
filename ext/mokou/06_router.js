// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.router()`: a `URLPattern` based route table that produces a
// `Deno.serve()` handler, so small servers need no router dependency.
//
//   Deno.serve(Deno.router({
//     "GET /": () => new Response("home"),
//     "GET /users/:id": (_req, { params }) => Response.json({ id: params.id }),
//     "/static/*": serveStatic,
//   }));

(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ObjectEntries,
  ObjectFreeze,
  SafeArrayIterator,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeToUpperCase,
  StringPrototypeStartsWith,
  TypeError,
} = primordials;
const { URLPattern } = core.loadExtScript("ext:deno_web/01_urlpattern.js");

const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
];

function compile(key, handler) {
  if (typeof handler !== "function") {
    throw new TypeError(`Handler for route "${key}" must be a function`);
  }
  let method = null;
  let pathname = key;
  const space = StringPrototypeIndexOf(key, " ");
  if (space !== -1) {
    method = StringPrototypeToUpperCase(StringPrototypeSlice(key, 0, space));
    pathname = StringPrototypeSlice(key, space + 1);
    if (!ArrayPrototypeIncludes(METHODS, method)) {
      throw new TypeError(`Unknown HTTP method "${method}" in route "${key}"`);
    }
  }
  if (!StringPrototypeStartsWith(pathname, "/")) {
    throw new TypeError(`Route "${key}" must start with "/"`);
  }
  return { method, pattern: new URLPattern({ pathname }), handler, key };
}

function notFound() {
  return new Response("Not Found", { status: 404 });
}

/**
 * Builds a request handler from a route table. Keys are `"METHOD /path"` or
 * `"/path"` (any method), with `URLPattern` syntax for the path. Routes are
 * tried in order; the first match wins. A route that matches the path but not
 * the method yields `405 Method Not Allowed` with an `Allow` header.
 */
function router(routes, options = { __proto__: null }) {
  const compiled = [];
  const entries = ArrayIsArray(routes) ? routes : ObjectEntries(routes);
  for (const { 0: key, 1: handler } of new SafeArrayIterator(entries)) {
    ArrayPrototypePush(compiled, compile(key, handler));
  }
  const fallback = options.fallback ?? notFound;

  return function handle(request, info) {
    const allowed = [];
    for (const route of new SafeArrayIterator(compiled)) {
      const match = route.pattern.exec(request.url);
      if (match === null) continue;
      const method = request.method;
      if (
        route.method !== null && route.method !== method &&
        !(route.method === "GET" && method === "HEAD")
      ) {
        if (!ArrayPrototypeIncludes(allowed, route.method)) {
          ArrayPrototypePush(allowed, route.method);
        }
        continue;
      }
      return route.handler(request, {
        params: ObjectFreeze({ ...match.pathname.groups }),
        info,
        route: route.key,
      });
    }
    if (allowed.length > 0) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: ArrayPrototypeJoin(allowed, ", ") },
      });
    }
    return fallback(request, info);
  };
}

return { router };
})();
