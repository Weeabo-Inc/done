// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.csrf`: stateless, signed CSRF tokens. The token format is described
// in `csrf.rs`.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_csrf_generate, op_done_csrf_verify } = core.ops;
const {
  ArrayBufferIsView,
  DateNow,
  MathFloor,
  NumberIsFinite,
  ObjectFreeze,
  TypeError,
  TypedArrayPrototypeGetByteLength,
  Uint8Array,
} = primordials;

const DAY = 24 * 60 * 60 * 1000;
const EMPTY = new Uint8Array(0);

function bytes(value, name) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return core.encode(value);
  if (ArrayBufferIsView(value)) return value;
  throw new TypeError(`${name} must be a string or a Uint8Array`);
}

function secretOf(options) {
  const secret = bytes(options.secret, "secret");
  if (secret !== undefined && TypedArrayPrototypeGetByteLength(secret) === 0) {
    throw new TypeError("secret must not be empty");
  }
  return secret;
}

function duration(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !NumberIsFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds`);
  }
  return MathFloor(value);
}

function generate(options = { __proto__: null }) {
  const now = DateNow();
  return op_done_csrf_generate(
    secretOf(options),
    bytes(options.context, "context") ?? EMPTY,
    now,
    now + duration(options.expiresIn, DAY, "expiresIn"),
  );
}

function verify(token, options = { __proto__: null }) {
  if (typeof token !== "string") return false;
  return op_done_csrf_verify(
    token,
    secretOf(options),
    bytes(options.context, "context") ?? EMPTY,
    DateNow(),
    duration(options.maxAge, 0, "maxAge"),
  );
}

const csrf = ObjectFreeze({ generate, verify });

return { csrf };
})();
