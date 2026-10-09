// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.semver`: semantic versions and npm-style ranges.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_semver_compare,
  op_done_semver_max_satisfying,
  op_done_semver_parse,
  op_done_semver_satisfies,
} = core.ops;
const { ArrayPrototypeSlice, ArrayPrototypeSort, ObjectFreeze } = primordials;

function parse(version) {
  return op_done_semver_parse(version);
}

/** Returns `true` if `version` is a valid semantic version. */
function valid(version) {
  try {
    op_done_semver_parse(version);
    return true;
  } catch {
    return false;
  }
}

/** Returns -1, 0 or 1, for use with `Array.prototype.sort()`. */
function compare(a, b) {
  return op_done_semver_compare(a, b);
}

function satisfies(version, range) {
  return op_done_semver_satisfies(version, range);
}

/** Returns the highest version in `versions` that satisfies `range`, or
 * `undefined`. */
function maxSatisfying(versions, range) {
  return op_done_semver_max_satisfying(versions, range) ?? undefined;
}

/** Returns a sorted copy of `versions`, lowest first. */
function sort(versions) {
  return ArrayPrototypeSort(ArrayPrototypeSlice(versions), compare);
}

const semver = ObjectFreeze({
  compare,
  maxSatisfying,
  parse,
  satisfies,
  sort,
  valid,
});

return { semver };
})();
