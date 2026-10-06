// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.password`: password hashing with Argon2id (default) or bcrypt.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_password_hash, op_done_password_verify } = core.ops;
const { ObjectFreeze, TypeError } = primordials;

function assertString(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
}

/**
 * Hashes a password. The result is a self-describing string (PHC format for
 * Argon2, modular crypt format for bcrypt) that includes the algorithm, its
 * parameters and a random salt, so it can be stored as-is.
 */
function hash(password, options = { __proto__: null }) {
  assertString(password, "password");
  return op_done_password_hash(password, options);
}

/** Checks a password against a hash produced by `hash()` or another
 * Argon2/bcrypt implementation. */
function verify(password, hash) {
  assertString(password, "password");
  assertString(hash, "hash");
  return op_done_password_verify(password, hash);
}

const password = ObjectFreeze({ hash, verify });

return { password };
})();
