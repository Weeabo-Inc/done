// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.toml`, `Deno.yaml` and `Deno.csv`: parse and stringify common data
// formats without a dependency.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_csv_parse,
  op_done_csv_stringify,
  op_done_toml_parse,
  op_done_toml_stringify,
  op_done_yaml_parse,
  op_done_yaml_stringify,
} = core.ops;
const {
  ArrayIsArray,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  JSONParse,
  JSONStringify,
  ObjectFreeze,
  ObjectKeys,
  SafeArrayIterator,
  SafeSet,
  SetPrototypeAdd,
  SetPrototypeHas,
  String,
  TypeError,
} = primordials;

function assertString(text, api) {
  if (typeof text !== "string") {
    throw new TypeError(`${api} expects a string`);
  }
}

// Values are normalized through JSON before crossing into Rust, so that
// `toJSON()` (for example on `Date`) is honoured and `undefined` is dropped
// exactly as `JSON.stringify` drops it.
function toJsonValue(value) {
  const json = JSONStringify(value);
  return json === undefined ? null : JSONParse(json);
}

const toml = ObjectFreeze({
  parse(text) {
    assertString(text, "Deno.toml.parse()");
    return op_done_toml_parse(text);
  },
  stringify(value) {
    return op_done_toml_stringify(toJsonValue(value));
  },
});

const yaml = ObjectFreeze({
  /** Parses the first document. Use `parseAll()` for multi-document
   * streams. */
  parse(text) {
    assertString(text, "Deno.yaml.parse()");
    return op_done_yaml_parse(text, false);
  },
  parseAll(text) {
    assertString(text, "Deno.yaml.parseAll()");
    return op_done_yaml_parse(text, true);
  },
  stringify(value) {
    return op_done_yaml_stringify(toJsonValue(value));
  },
});

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSONStringify(value);
  return String(value);
}

const csv = ObjectFreeze({
  /**
   * Parses CSV into an array of rows. With `{ header: true }` the first row is
   * used as keys and each row becomes an object.
   */
  parse(text, options = { __proto__: null }) {
    assertString(text, "Deno.csv.parse()");
    return op_done_csv_parse(text, {
      separator: options.separator,
      header: options.header ?? false,
      trim: options.trim ?? false,
    });
  },
  /**
   * Stringifies rows. Rows can be arrays, or objects; for objects a header row
   * is written first, from `options.columns` or from the keys of every row in
   * first-seen order.
   */
  stringify(rows, options = { __proto__: null }) {
    if (!ArrayIsArray(rows)) {
      throw new TypeError("Deno.csv.stringify() expects an array of rows");
    }
    let table;
    if (rows.length > 0 && !ArrayIsArray(rows[0])) {
      let columns = options.columns;
      if (columns === undefined) {
        columns = [];
        const seen = new SafeSet();
        for (const row of new SafeArrayIterator(rows)) {
          for (const key of new SafeArrayIterator(ObjectKeys(row))) {
            if (!SetPrototypeHas(seen, key)) {
              SetPrototypeAdd(seen, key);
              ArrayPrototypePush(columns, key);
            }
          }
        }
      }
      table = [ArrayPrototypeMap(columns, String)];
      for (const row of new SafeArrayIterator(rows)) {
        ArrayPrototypePush(
          table,
          ArrayPrototypeMap(columns, (column) => stringifyCell(row[column])),
        );
      }
    } else {
      table = ArrayPrototypeMap(
        rows,
        (row) => ArrayPrototypeMap(row, stringifyCell),
      );
    }
    return op_done_csv_stringify(table, options.separator ?? null);
  },
});

return { csv, toml, yaml };
})();
