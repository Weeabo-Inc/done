// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.parseArgs()`: command line argument parsing for scripts, compatible
// with `parseArgs` from `jsr:@std/cli`.
//
//   const flags = Deno.parseArgs(Deno.args, {
//     boolean: ["help"],
//     string: ["name"],
//     alias: { h: "help", n: "name" },
//     default: { name: "world" },
//   });

(function () {
const { primordials } = __bootstrap;
const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  NumberIsNaN,
  Number,
  ObjectEntries,
  ObjectHasOwn,
  ObjectKeys,
  RegExpPrototypeTest,
  SafeArrayIterator,
  SafeMap,
  SafeRegExp,
  ArrayFrom,
  SafeSet,
  SafeSetIterator,
  MapPrototypeGet,
  MapPrototypeSet,
  SetPrototypeAdd,
  SetPrototypeHas,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
} = primordials;

const NUMBER_RE = new SafeRegExp(
  "^-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?$",
  "i",
);

function asList(value) {
  if (value === undefined) return [];
  return ArrayIsArray(value) ? value : [value];
}

function setNested(target, key, value, collect) {
  const parts = StringPrototypeSplit(key, ".");
  let obj = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === "__proto__" || part === "constructor") return;
    if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
    obj = obj[part];
  }
  const last = parts[parts.length - 1];
  if (last === "__proto__" || last === "constructor") return;
  if (collect) {
    if (!ObjectHasOwn(obj, last) || !ArrayIsArray(obj[last])) obj[last] = [];
    ArrayPrototypePush(obj[last], value);
  } else {
    obj[last] = value;
  }
}

function parseArgs(args, options = { __proto__: null }) {
  const {
    "--": doubleDash = false,
    alias = {},
    boolean = false,
    default: defaults = {},
    stopEarly = false,
    string = [],
    collect = [],
    negatable = [],
    unknown: unknownFn = undefined,
  } = options;

  // Each name maps to every name it is an alias of, including itself.
  const aliases = new SafeMap();
  const addAlias = (a, b) => {
    let set = MapPrototypeGet(aliases, a);
    if (set === undefined) {
      set = new SafeSet([a]);
      MapPrototypeSet(aliases, a, set);
    }
    SetPrototypeAdd(set, b);
  };
  for (
    const { 0: key, 1: value } of new SafeArrayIterator(ObjectEntries(alias))
  ) {
    for (const name of new SafeArrayIterator(asList(value))) {
      addAlias(key, name);
      addAlias(name, key);
    }
  }
  const namesOf = (key) => {
    const set = MapPrototypeGet(aliases, key);
    return set === undefined ? [key] : ArrayFrom(new SafeSetIterator(set));
  };
  const expand = (list) => {
    const out = new SafeSet();
    for (const key of new SafeArrayIterator(list)) {
      for (const name of new SafeArrayIterator(namesOf(key))) {
        SetPrototypeAdd(out, name);
      }
    }
    return out;
  };

  const allBooleans = boolean === true;
  const booleans = expand(
    typeof boolean === "boolean" ? [] : asList(boolean),
  );
  const strings = expand(asList(string));
  const collects = expand(asList(collect));
  const negatables = expand(asList(negatable));
  const isKnown = (key) =>
    allBooleans || SetPrototypeHas(booleans, key) ||
    SetPrototypeHas(strings, key) ||
    MapPrototypeGet(aliases, key) !== undefined ||
    ObjectHasOwn(defaults, key);

  const result = { _: [] };
  const seen = new SafeSet();

  const set = (key, value, arg) => {
    if (
      unknownFn !== undefined && !isKnown(key) &&
      unknownFn(arg, key, value) === false
    ) {
      return;
    }
    for (const name of new SafeArrayIterator(namesOf(key))) {
      setNested(result, name, value, SetPrototypeHas(collects, key));
      SetPrototypeAdd(seen, name);
    }
  };
  const coerce = (key, value) => {
    if (SetPrototypeHas(strings, key)) return value;
    if (RegExpPrototypeTest(NUMBER_RE, value)) {
      const n = Number(value);
      if (!NumberIsNaN(n)) return n;
    }
    return value;
  };
  const isBoolean = (key) =>
    !SetPrototypeHas(strings, key) &&
    (allBooleans || SetPrototypeHas(booleans, key));
  const pushPositional = (arg) => {
    if (unknownFn !== undefined && unknownFn(arg) === false) return;
    ArrayPrototypePush(
      result._,
      SetPrototypeHas(strings, "_") ? arg : coerce("_", arg),
    );
  };

  let rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest = ArrayPrototypeSlice(args, i + 1);
      break;
    }
    if (StringPrototypeStartsWith(arg, "--") && arg.length > 2) {
      const eq = StringPrototypeIndexOf(arg, "=");
      if (eq !== -1) {
        const key = StringPrototypeSlice(arg, 2, eq);
        const value = StringPrototypeSlice(arg, eq + 1);
        set(
          key,
          isBoolean(key) ? value !== "false" : coerce(key, value),
          arg,
        );
        continue;
      }
      const key = StringPrototypeSlice(arg, 2);
      if (
        StringPrototypeStartsWith(key, "no-") &&
        SetPrototypeHas(negatables, StringPrototypeSlice(key, 3))
      ) {
        set(StringPrototypeSlice(key, 3), false, arg);
        continue;
      }
      const next = args[i + 1];
      if (isBoolean(key)) {
        if (next === "true" || next === "false") {
          set(key, next === "true", arg);
          i++;
        } else {
          set(key, true, arg);
        }
      } else if (
        next !== undefined && !StringPrototypeStartsWith(next, "-")
      ) {
        set(key, coerce(key, next), arg);
        i++;
      } else {
        set(key, SetPrototypeHas(strings, key) ? "" : true, arg);
      }
      continue;
    }
    if (StringPrototypeStartsWith(arg, "-") && arg.length > 1 && arg !== "-") {
      const letters = StringPrototypeSlice(arg, 1);
      for (let j = 0; j < letters.length; j++) {
        const key = letters[j];
        const restOfArg = StringPrototypeSlice(letters, j + 1);
        if (restOfArg[0] === "=") {
          set(key, coerce(key, StringPrototypeSlice(restOfArg, 1)), arg);
          break;
        }
        if (
          !isBoolean(key) && restOfArg.length > 0 &&
          (SetPrototypeHas(strings, key) ||
            RegExpPrototypeTest(NUMBER_RE, restOfArg))
        ) {
          set(key, coerce(key, restOfArg), arg);
          break;
        }
        if (j === letters.length - 1) {
          const next = args[i + 1];
          if (
            !isBoolean(key) && next !== undefined &&
            !StringPrototypeStartsWith(next, "-")
          ) {
            set(key, coerce(key, next), arg);
            i++;
          } else if (isBoolean(key) && (next === "true" || next === "false")) {
            set(key, next === "true", arg);
            i++;
          } else {
            set(key, SetPrototypeHas(strings, key) ? "" : true, arg);
          }
        } else {
          set(key, true, arg);
        }
      }
      continue;
    }
    pushPositional(arg);
    if (stopEarly) {
      rest = ArrayPrototypeSlice(args, i + 1);
      for (const r of new SafeArrayIterator(rest)) pushPositional(r);
      rest = [];
      break;
    }
  }

  // Booleans that were never passed default to false.
  for (const key of new SafeSetIterator(booleans)) {
    if (!SetPrototypeHas(seen, key) && !ObjectHasOwn(defaults, key)) {
      setNested(result, key, false, false);
    }
  }
  for (const key of new SafeArrayIterator(ObjectKeys(defaults))) {
    if (!SetPrototypeHas(seen, key)) {
      for (const name of new SafeArrayIterator(namesOf(key))) {
        if (!SetPrototypeHas(seen, name)) {
          setNested(result, name, defaults[key], false);
        }
      }
    }
  }
  // Collect options that were never passed default to an empty array.
  for (const key of new SafeSetIterator(collects)) {
    if (
      !SetPrototypeHas(seen, key) && !ObjectHasOwn(defaults, key) &&
      !ArrayPrototypeIncludes(ObjectKeys(result), key)
    ) {
      result[key] = [];
    }
  }

  if (doubleDash) {
    result["--"] = rest;
  } else {
    for (const r of new SafeArrayIterator(rest)) {
      ArrayPrototypePush(result._, r);
    }
  }
  return result;
}

return { parseArgs };
})();
