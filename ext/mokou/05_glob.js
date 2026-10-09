// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.glob()` / `Deno.globSync()`: native filesystem globbing.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_glob } = core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeMap,
  ObjectPrototypeIsPrototypeOf,
  PromiseResolve,
  TypeError,
} = primordials;
const { pathFromURL } = core.loadExtScript("ext:deno_web/00_infra.js");
const { URLPrototype } = core.loadExtScript("ext:deno_web/00_url.js");

function toPatterns(patterns) {
  const list = ArrayIsArray(patterns) ? patterns : [patterns];
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") {
      throw new TypeError("Glob patterns must be strings");
    }
  }
  return list;
}

/**
 * Returns the entries under `options.root` (default: the current directory)
 * that match one of `patterns`. Paths are relative to the root and always use
 * `/`. Hidden files are skipped unless `includeHidden` is set or a pattern
 * names them explicitly.
 */
function globSync(patterns, options = { __proto__: null }) {
  let root = options.root ?? ".";
  if (ObjectPrototypeIsPrototypeOf(URLPrototype, root)) {
    root = pathFromURL(root);
  }
  const entries = op_done_glob({
    root,
    patterns: toPatterns(patterns),
    exclude: options.exclude === undefined ? [] : toPatterns(options.exclude),
    includeDirs: options.includeDirs ?? false,
    includeHidden: options.includeHidden ?? false,
    followSymlinks: options.followSymlinks ?? false,
    caseInsensitive: options.caseInsensitive ?? false,
  });
  return options.withFileTypes
    ? entries
    : ArrayPrototypeMap(entries, (entry) => entry.path);
}

function glob(patterns, options) {
  try {
    return PromiseResolve(globSync(patterns, options));
  } catch (error) {
    return primordials.PromiseReject(error);
  }
}

return { glob, globSync };
})();
