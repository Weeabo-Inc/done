// Copyright 2018-2026 the Deno authors. MIT license.
import { assertEquals, assertThrows } from "./test_util.ts";

Deno.test(function cookiesParse() {
  assertEquals(Deno.cookies.parse("a=1; b = two ;c=; a=ignored; bad"), {
    a: "1",
    b: "two",
    c: "",
  });
  assertEquals(Deno.cookies.parse(""), {});
});

Deno.test(function cookiesGetFromRequest() {
  const req = new Request("http://localhost/", {
    headers: { cookie: "session=abc; theme=dark" },
  });
  assertEquals(Deno.cookies.get(req), { session: "abc", theme: "dark" });
  assertEquals(Deno.cookies.get(new Headers()), {});
});

Deno.test(function cookiesSerialize() {
  assertEquals(
    Deno.cookies.serialize({
      name: "id",
      value: "42",
      secure: true,
      httpOnly: true,
      partitioned: true,
      maxAge: 3600,
      domain: "example.com",
      sameSite: "Strict",
      path: "/app",
      expires: Date.UTC(2030, 0, 1),
      unparsed: ["Priority=High"],
    }),
    "id=42; Secure; HttpOnly; Partitioned; Max-Age=3600; Domain=example.com; " +
      "SameSite=Strict; Path=/app; Expires=Tue, 01 Jan 2030 00:00:00 GMT; " +
      "Priority=High",
  );
  assertEquals(
    Deno.cookies.serialize({ name: "q", value: '"quoted"' }),
    'q="quoted"',
  );
});

Deno.test(function cookiesValidation() {
  const cases: [Deno.cookies.Cookie, string][] = [
    [{ name: "a b", value: "1" }, "not a valid token"],
    [{ name: "a", value: "x;y" }, "encodeURIComponent"],
    [{ name: "a", value: "1", path: "/;x" }, "path"],
    [{ name: "a", value: "1", maxAge: 1.5 }, "maxAge"],
    [{ name: "a", value: "1", partitioned: true }, "secure"],
    [{ name: "a", value: "1", sameSite: "None" }, "secure"],
    [{ name: "__Secure-a", value: "1" }, "__Secure-"],
    [{ name: "__Host-a", value: "1", secure: true }, "__Host-"],
    [
      {
        name: "__Host-a",
        value: "1",
        secure: true,
        path: "/",
        domain: "x.com",
      },
      "__Host-",
    ],
  ];
  for (const [cookie, message] of cases) {
    assertThrows(() => Deno.cookies.serialize(cookie), TypeError, message);
  }
  // A valid __Host- cookie.
  Deno.cookies.serialize({
    name: "__Host-a",
    value: "1",
    secure: true,
    path: "/",
  });
});

Deno.test(function cookiesSetDeleteAndRead() {
  const headers = new Headers();
  Deno.cookies.set(headers, { name: "a", value: "1", path: "/" });
  Deno.cookies.set(headers, { name: "b", value: "2", maxAge: 10 });
  Deno.cookies.delete(headers, "old", { path: "/", domain: "example.com" });
  assertEquals(headers.getSetCookie(), [
    "a=1; Path=/",
    "b=2; Max-Age=10",
    "old=; Max-Age=0; Domain=example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]);
  const res = new Response(null, { headers });
  assertEquals(Deno.cookies.getSetCookies(res), [
    { name: "a", value: "1", path: "/" },
    { name: "b", value: "2", maxAge: 10 },
    {
      name: "old",
      value: "",
      maxAge: 0,
      domain: "example.com",
      path: "/",
      expires: new Date(0),
    },
  ]);
});

Deno.test(function cookiesGetSetCookiesKeepsUnknownAttributes() {
  const headers = new Headers({
    "set-cookie": "x=1; SameSite=lax; Priority=High; Secure",
  });
  assertEquals(Deno.cookies.getSetCookies(headers), [
    {
      name: "x",
      value: "1",
      sameSite: "Lax",
      unparsed: ["Priority=High"],
      secure: true,
    },
  ]);
});
