// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.cookies`: read `Cookie` headers and write `Set-Cookie` headers, with
// the validation RFC 6265 and browsers require.

(function () {
const { primordials } = __bootstrap;
const {
  ArrayPrototypePush,
  DatePrototype,
  DatePrototypeGetTime,
  DatePrototypeToUTCString,
  Date,
  JSONStringify,
  NumberIsFinite,
  NumberIsInteger,
  NumberParseInt,
  ObjectFreeze,
  ObjectHasOwn,
  ObjectPrototypeIsPrototypeOf,
  RegExpPrototypeTest,
  SafeRegExp,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  StringPrototypeToLowerCase,
  StringPrototypeTrim,
  TypeError,
} = primordials;

// RFC 6265 section 4.1.1.
const NAME = new SafeRegExp("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$");
const VALUE = new SafeRegExp(
  '^("?)[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]*\\1$',
);
const PATH = new SafeRegExp("^[\\x20-\\x3A\\x3C-\\x7E]*$");
const DOMAIN = new SafeRegExp("^\\.?[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*$");
const SAME_SITE = {
  __proto__: null,
  strict: "Strict",
  lax: "Lax",
  none: "None",
};

/** Accepts `Headers`, or a `Request` or `Response` and uses its headers. */
function headersOf(source, api) {
  const headers = typeof source?.get === "function" ? source : source?.headers;
  if (typeof headers?.get !== "function") {
    throw new TypeError(`${api} expects Headers, a Request or a Response`);
  }
  return headers;
}

/** Parses a `Cookie` header into names and values. The first cookie with a
 * name wins, since browsers send the most specific path first. */
function parse(header) {
  if (typeof header !== "string") {
    throw new TypeError("Deno.cookies.parse() expects a string");
  }
  const cookies = { __proto__: null };
  const pairs = StringPrototypeSplit(header, ";");
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const eq = StringPrototypeIndexOf(pair, "=");
    if (eq === -1) continue;
    const name = StringPrototypeTrim(StringPrototypeSlice(pair, 0, eq));
    if (name === "" || ObjectHasOwn(cookies, name)) continue;
    cookies[name] = StringPrototypeTrim(StringPrototypeSlice(pair, eq + 1));
  }
  return { ...cookies };
}

function invalid(message) {
  return new TypeError(`Invalid cookie: ${message}`);
}

/** Serializes a cookie into a `Set-Cookie` header value. */
function serialize(cookie) {
  if (cookie === null || typeof cookie !== "object") {
    throw new TypeError("A cookie must be an object");
  }
  const { name, value = "" } = cookie;
  if (typeof name !== "string" || !RegExpPrototypeTest(NAME, name)) {
    throw invalid(`name ${JSONStringify(name)} is not a valid token`);
  }
  if (typeof value !== "string" || !RegExpPrototypeTest(VALUE, value)) {
    throw invalid(
      `value of "${name}" contains characters cookies can't hold; ` +
        "encode it, for example with encodeURIComponent()",
    );
  }
  let out = `${name}=${value}`;
  const secure = cookie.secure === true;

  if (StringPrototypeStartsWith(name, "__Secure-") && !secure) {
    throw invalid(`"${name}" starts with __Secure- so it needs secure: true`);
  }
  if (StringPrototypeStartsWith(name, "__Host-")) {
    if (!secure || cookie.path !== "/" || cookie.domain !== undefined) {
      throw invalid(
        `"${name}" starts with __Host- so it needs secure: true, path: "/" and no domain`,
      );
    }
  }

  if (secure) out += "; Secure";
  if (cookie.httpOnly) out += "; HttpOnly";
  if (cookie.partitioned) {
    if (!secure) throw invalid("partitioned cookies need secure: true");
    out += "; Partitioned";
  }
  if (cookie.maxAge !== undefined) {
    if (!NumberIsInteger(cookie.maxAge)) {
      throw invalid("maxAge must be an integer number of seconds");
    }
    out += `; Max-Age=${cookie.maxAge}`;
  }
  if (cookie.domain !== undefined) {
    if (
      typeof cookie.domain !== "string" ||
      !RegExpPrototypeTest(DOMAIN, cookie.domain)
    ) {
      throw invalid(`domain ${JSONStringify(cookie.domain)}`);
    }
    out += `; Domain=${cookie.domain}`;
  }
  if (cookie.sameSite !== undefined) {
    const sameSite = SAME_SITE[
      StringPrototypeToLowerCase(
        `${cookie.sameSite}`,
      )
    ];
    if (!sameSite) {
      throw invalid('sameSite must be "Strict", "Lax" or "None"');
    }
    if (sameSite === "None" && !secure) {
      throw invalid('sameSite: "None" needs secure: true');
    }
    out += `; SameSite=${sameSite}`;
  }
  if (cookie.path !== undefined) {
    if (
      typeof cookie.path !== "string" || !RegExpPrototypeTest(PATH, cookie.path)
    ) {
      throw invalid(`path ${JSONStringify(cookie.path)}`);
    }
    out += `; Path=${cookie.path}`;
  }
  if (cookie.expires !== undefined) {
    const time = ObjectPrototypeIsPrototypeOf(DatePrototype, cookie.expires)
      ? DatePrototypeGetTime(cookie.expires)
      : cookie.expires;
    if (typeof time !== "number" || !NumberIsFinite(time)) {
      throw invalid("expires must be a Date or a timestamp in milliseconds");
    }
    out += `; Expires=${DatePrototypeToUTCString(new Date(time))}`;
  }
  const unparsed = cookie.unparsed ?? [];
  for (let i = 0; i < unparsed.length; i++) {
    out += `; ${unparsed[i]}`;
  }
  return out;
}

/** Parses one `Set-Cookie` header value into a cookie object. */
function parseSetCookie(header) {
  const parts = StringPrototypeSplit(header, ";");
  const first = parts[0];
  const eq = StringPrototypeIndexOf(first, "=");
  if (eq === -1) return null;
  const cookie = {
    name: StringPrototypeTrim(StringPrototypeSlice(first, 0, eq)),
    value: StringPrototypeTrim(StringPrototypeSlice(first, eq + 1)),
  };
  if (cookie.name === "") return null;
  for (let i = 1; i < parts.length; i++) {
    const part = StringPrototypeTrim(parts[i]);
    if (part === "") continue;
    const index = StringPrototypeIndexOf(part, "=");
    const key = StringPrototypeToLowerCase(
      index === -1
        ? part
        : StringPrototypeTrim(StringPrototypeSlice(part, 0, index)),
    );
    const value = index === -1
      ? ""
      : StringPrototypeTrim(StringPrototypeSlice(part, index + 1));
    switch (key) {
      case "expires": {
        const date = new Date(value);
        if (NumberIsFinite(DatePrototypeGetTime(date))) cookie.expires = date;
        break;
      }
      case "max-age": {
        const seconds = NumberParseInt(value, 10);
        if (NumberIsFinite(seconds)) cookie.maxAge = seconds;
        break;
      }
      case "domain":
        cookie.domain = value;
        break;
      case "path":
        cookie.path = value;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "partitioned":
        cookie.partitioned = true;
        break;
      case "samesite": {
        const sameSite = SAME_SITE[StringPrototypeToLowerCase(value)];
        if (sameSite) cookie.sameSite = sameSite;
        break;
      }
      default:
        cookie.unparsed ??= [];
        ArrayPrototypePush(cookie.unparsed, part);
    }
  }
  return cookie;
}

/** The cookies a request sent, from its `Cookie` header. */
function get(source) {
  return parse(headersOf(source, "Deno.cookies.get()").get("cookie") ?? "");
}

/** Adds a `Set-Cookie` header for `cookie`. */
function set(target, cookie) {
  headersOf(target, "Deno.cookies.set()").append(
    "set-cookie",
    serialize(cookie),
  );
}

/** Tells the client to delete a cookie by setting it to expire. Pass the same
 * `path` and `domain` the cookie was set with. */
function deleteCookie(target, name, attributes = { __proto__: null }) {
  set(target, {
    name,
    value: "",
    path: attributes.path,
    domain: attributes.domain,
    secure: attributes.secure,
    httpOnly: attributes.httpOnly,
    partitioned: attributes.partitioned,
    sameSite: attributes.sameSite,
    expires: 0,
    maxAge: 0,
  });
}

/** The cookies a response sets, from its `Set-Cookie` headers. */
function getSetCookies(source) {
  const headers = headersOf(source, "Deno.cookies.getSetCookies()");
  const values = headers.getSetCookie();
  const cookies = [];
  for (let i = 0; i < values.length; i++) {
    const cookie = parseSetCookie(values[i]);
    if (cookie) ArrayPrototypePush(cookies, cookie);
  }
  return cookies;
}

const cookies = ObjectFreeze({
  delete: deleteCookie,
  get,
  getSetCookies,
  parse,
  serialize,
  set,
});

return { cookies };
})();
