// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.secrets`: passwords and tokens in the OS credential store. See
// `secrets.rs`.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_secrets_delete,
  op_done_secrets_get,
  op_done_secrets_set,
} = core.ops;
const { ObjectFreeze, TypeError } = primordials;

function key(options, method) {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      `Deno.secrets.${method}() expects an object with service and name`,
    );
  }
  const { service, name } = options;
  if (typeof service !== "string" || typeof name !== "string") {
    throw new TypeError(
      `Deno.secrets.${method}() needs service and name strings`,
    );
  }
  return { service, name };
}

async function get(options) {
  const { service, name } = key(options, "get");
  return (await op_done_secrets_get(service, name)) ?? null;
}

async function set(options) {
  const { service, name } = key(options, "set");
  if (typeof options.value !== "string") {
    throw new TypeError("Deno.secrets.set() needs a value string");
  }
  await op_done_secrets_set(service, name, options.value);
}

function deleteSecret(options) {
  const { service, name } = key(options, "delete");
  return op_done_secrets_delete(service, name);
}

const secrets = ObjectFreeze({ get, set, delete: deleteSecret });

return { secrets };
})();
