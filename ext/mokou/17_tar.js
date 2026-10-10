// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.tar`: create, read, pack and extract tar archives, optionally
// gzip-compressed. Archives are built and parsed in Rust (`archive.rs`); the
// file system is only touched here, through the permission-checked APIs.

(function () {
const { core, primordials } = __bootstrap;
const {
  op_done_tar_create,
  op_done_tar_read,
  op_fs_read_dir_async,
  op_fs_read_dir_async_next,
} = core.ops;
const {
  ArrayBufferIsView,
  ArrayBufferPrototype,
  ArrayFrom,
  ArrayPrototypeFilter,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  DataViewPrototype,
  DataViewPrototypeGetBuffer,
  DataViewPrototypeGetByteLength,
  DataViewPrototypeGetByteOffset,
  Date,
  DateNow,
  DatePrototype,
  DatePrototypeGetTime,
  Error,
  ErrorPrototype,
  MathFloor,
  NumberIsFinite,
  ObjectEntries,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  RegExpPrototypeTest,
  SafeArrayIterator,
  SafeRegExp,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  SymbolIterator,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  Uint8Array,
} = primordials;
const fs = core.loadExtScript("ext:deno_fs/30_fs.js");
const { pathFromURL } = core.loadExtScript("ext:deno_web/00_infra.js");
const { BlobPrototype } = core.loadExtScript("ext:deno_web/09_file.js");

const SEPARATORS = new SafeRegExp("[\\\\/]+");
const DRIVE = new SafeRegExp("^[A-Za-z]:");
const DEFAULT_MODE = {
  __proto__: null,
  file: 0o644,
  directory: 0o755,
  symlink: 0o777,
  link: 0o644,
};

/** Splits an archive path into its segments, refusing absolute paths and
 * `..`, which would point outside wherever the archive is extracted. */
function segments(path) {
  if (
    typeof path !== "string" || path === "" ||
    StringPrototypeIncludes(path, "\0")
  ) {
    throw new TypeError(`Invalid path in tar archive: ${path}`);
  }
  if (
    StringPrototypeStartsWith(path, "/") ||
    StringPrototypeStartsWith(path, "\\") ||
    RegExpPrototypeTest(DRIVE, path)
  ) {
    throw new TypeError(`Absolute path in tar archive: ${path}`);
  }
  const parts = ArrayPrototypeFilter(
    StringPrototypeSplit(path, SEPARATORS),
    (part) => part !== "" && part !== ".",
  );
  for (const part of new SafeArrayIterator(parts)) {
    if (part === "..") {
      throw new TypeError(`Path in tar archive leaves its root: ${path}`);
    }
  }
  return parts;
}

function normalizePath(path) {
  const parts = segments(path);
  if (parts.length === 0) {
    throw new TypeError(`Invalid path in tar archive: ${path}`);
  }
  return ArrayPrototypeJoin(parts, "/");
}

async function toBytes(data, what) {
  if (typeof data === "string") return core.encode(data);
  if (ArrayBufferIsView(data)) {
    if (ObjectPrototypeIsPrototypeOf(DataViewPrototype, data)) {
      return new Uint8Array(
        DataViewPrototypeGetBuffer(data),
        DataViewPrototypeGetByteOffset(data),
        DataViewPrototypeGetByteLength(data),
      );
    }
    return new Uint8Array(
      TypedArrayPrototypeGetBuffer(data),
      TypedArrayPrototypeGetByteOffset(data),
      TypedArrayPrototypeGetByteLength(data),
    );
  }
  if (ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, data)) {
    return new Uint8Array(data);
  }
  if (ObjectPrototypeIsPrototypeOf(BlobPrototype, data)) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError(
    `${what} must be a string, a Uint8Array, an ArrayBuffer or a Blob`,
  );
}

function toSeconds(mtime) {
  if (mtime === undefined) return MathFloor(DateNow() / 1000);
  const ms = ObjectPrototypeIsPrototypeOf(DatePrototype, mtime)
    ? DatePrototypeGetTime(mtime)
    : mtime;
  if (typeof ms !== "number" || !NumberIsFinite(ms) || ms < 0) {
    throw new TypeError("mtime must be a Date or a timestamp in milliseconds");
  }
  return MathFloor(ms / 1000);
}

async function normalizeEntry(init) {
  const type = init.type ?? "file";
  if (DEFAULT_MODE[type] === undefined) {
    throw new TypeError(
      `Unsupported tar entry type "${type}"; expected "file", "directory", "symlink" or "link"`,
    );
  }
  const entry = {
    path: normalizePath(init.path),
    type,
    mode: init.mode ?? DEFAULT_MODE[type],
    mtime: toSeconds(init.mtime),
    data: undefined,
    linkName: undefined,
  };
  if (type === "file") {
    entry.data = await toBytes(init.data ?? "", `Data for "${init.path}"`);
  } else if (type === "symlink" || type === "link") {
    if (typeof init.linkName !== "string" || init.linkName === "") {
      throw new TypeError(`"${init.path}" needs a linkName`);
    }
    entry.linkName = init.linkName;
  }
  return entry;
}

async function create(entries, options = { __proto__: null }) {
  const normalized = [];
  if (
    entries !== null && typeof entries === "object" &&
    typeof entries[SymbolIterator] !== "function"
  ) {
    for (
      const { 0: path, 1: data } of new SafeArrayIterator(
        ObjectEntries(entries),
      )
    ) {
      ArrayPrototypePush(normalized, await normalizeEntry({ path, data }));
    }
  } else {
    for (const init of new SafeArrayIterator(ArrayFrom(entries))) {
      ArrayPrototypePush(normalized, await normalizeEntry(init));
    }
  }
  return new Uint8Array(await op_done_tar_create(normalized, !!options.gzip));
}

async function read(data) {
  const entries = await op_done_tar_read(await toBytes(data, "The archive"));
  const result = [];
  for (const entry of new SafeArrayIterator(entries)) {
    let path = entry.path;
    while (path.length > 1 && StringPrototypeEndsWith(path, "/")) {
      path = StringPrototypeSlice(path, 0, -1);
    }
    const out = {
      path,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      mtime: new Date(entry.mtime * 1000),
    };
    if (entry.data !== undefined) out.data = new Uint8Array(entry.data);
    if (entry.linkName !== undefined) out.linkName = entry.linkName;
    ArrayPrototypePush(result, out);
  }
  return result;
}

function toPath(path, what) {
  const result = pathFromURL(path);
  if (typeof result !== "string") {
    throw new TypeError(`${what} must be a path string or a file: URL`);
  }
  return result;
}

async function pack(dir, options = { __proto__: null }) {
  const root = toPath(dir, "The directory");
  const filter = options.filter;
  const entries = [];
  async function walk(rel) {
    const names = [];
    const rid = await op_fs_read_dir_async(rel ? `${root}/${rel}` : root);
    try {
      while (true) {
        const entry = await op_fs_read_dir_async_next(rid);
        if (entry === null) break;
        ArrayPrototypePush(names, entry.name);
      }
    } finally {
      core.close(rid);
    }
    ArrayPrototypeSort(names);
    for (const name of new SafeArrayIterator(names)) {
      const path = rel ? `${rel}/${name}` : name;
      if (filter && !filter(path)) continue;
      const full = `${root}/${path}`;
      const info = await fs.lstat(full);
      const mtime = info.mtime ?? undefined;
      if (info.isSymlink) {
        ArrayPrototypePush(entries, {
          path,
          type: "symlink",
          linkName: await fs.readLink(full),
          mtime,
        });
      } else if (info.isDirectory) {
        ArrayPrototypePush(entries, {
          path,
          type: "directory",
          mode: info.mode === null ? undefined : info.mode & 0o7777,
          mtime,
        });
        await walk(path);
      } else if (info.isFile) {
        ArrayPrototypePush(entries, {
          path,
          type: "file",
          mode: info.mode === null ? undefined : info.mode & 0o7777,
          mtime,
          data: await fs.readFile(full),
        });
      }
    }
  }
  await walk("");
  return await create(entries, options);
}

async function extract(data, dir, options = { __proto__: null }) {
  const dest = toPath(dir, "The directory");
  const strip = options.strip ?? 0;
  if (typeof strip !== "number" || !NumberIsFinite(strip) || strip < 0) {
    throw new TypeError("strip must be a non-negative number");
  }
  const entries = await read(data);
  await fs.mkdir(dest, { recursive: true });
  const root = await fs.realPath(dest);
  const rootPrefix = StringPrototypeEndsWith(root, "/") ||
      StringPrototypeEndsWith(root, "\\")
    ? root
    : null;

  // Directories already created may be symlinks that existed before, so
  // each parent is resolved and checked to be inside the destination.
  async function checkInside(path, original) {
    const real = await fs.realPath(path);
    const inside = real === root ||
      (rootPrefix !== null
        ? StringPrototypeStartsWith(real, rootPrefix)
        : StringPrototypeStartsWith(real, `${root}/`) ||
          StringPrototypeStartsWith(real, `${root}\\`));
    if (!inside) {
      throw new Error(
        `Refusing to extract "${original}": it resolves outside ${dest}`,
      );
    }
  }
  function relative(path) {
    const parts = ArrayPrototypeSlice(segments(path), MathFloor(strip));
    return parts.length === 0 ? null : parts;
  }
  async function prepare(parts, original) {
    const parent = ArrayPrototypeJoin(
      [root, ...new SafeArrayIterator(ArrayPrototypeSlice(parts, 0, -1))],
      "/",
    );
    await fs.mkdir(parent, { recursive: true });
    await checkInside(parent, original);
    const target = `${parent}/${parts[parts.length - 1]}`;
    let existing = null;
    try {
      existing = await fs.lstat(target);
    } catch {
      // Doesn't exist yet.
    }
    if (existing?.isSymlink) {
      throw new Error(
        `Refusing to extract "${original}": ${target} is a symbolic link`,
      );
    }
    return target;
  }

  // Links are created last, so no entry is ever written through a link the
  // archive itself created.
  const links = [];
  const symlinks = [];
  for (const entry of new SafeArrayIterator(entries)) {
    const parts = relative(entry.path);
    if (parts === null) continue;
    switch (entry.type) {
      case "directory": {
        const target = await prepare(parts, entry.path);
        await fs.mkdir(target, { recursive: true, mode: entry.mode & 0o777 });
        break;
      }
      case "file": {
        const target = await prepare(parts, entry.path);
        await fs.writeFile(target, entry.data, { mode: entry.mode & 0o777 });
        await fs.utime(target, entry.mtime, entry.mtime);
        break;
      }
      case "symlink":
      case "link":
        ArrayPrototypePush(links, { entry, parts });
        break;
      default:
        // Devices, FIFOs and other special files are skipped.
        break;
    }
  }
  for (const { entry, parts } of new SafeArrayIterator(links)) {
    if (entry.type === "symlink") {
      // The target is relative to the link's directory and must stay inside
      // the destination.
      const resolved = [
        ...new SafeArrayIterator(ArrayPrototypeSlice(parts, 0, -1)),
      ];
      const target = entry.linkName;
      if (
        StringPrototypeStartsWith(target, "/") ||
        StringPrototypeStartsWith(target, "\\") ||
        RegExpPrototypeTest(DRIVE, target)
      ) {
        throw new Error(
          `Refusing to extract "${entry.path}": it links to the absolute path ${target}`,
        );
      }
      for (
        const part of new SafeArrayIterator(
          StringPrototypeSplit(target, SEPARATORS),
        )
      ) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
          if (resolved.length === 0) {
            throw new Error(
              `Refusing to extract "${entry.path}": it links outside ${dest}`,
            );
          }
          resolved.length--;
        } else {
          ArrayPrototypePush(resolved, part);
        }
      }
      const path = await prepare(parts, entry.path);
      await fs.symlink(target, path);
      ArrayPrototypePush(symlinks, { path, original: entry.path });
    } else {
      const sourceParts = relative(entry.linkName);
      if (sourceParts === null) continue;
      const source = `${root}/${ArrayPrototypeJoin(sourceParts, "/")}`;
      await checkInside(source, entry.path);
      const path = await prepare(parts, entry.path);
      await fs.link(source, path);
    }
  }
  // The check above is lexical, so a chain of links (`a/l1 -> ..` and
  // `a/l2 -> l1/../..`) can still lead outside. Resolve each link now that
  // they all exist, and remove the ones that do.
  let escaped = null;
  for (const { path, original } of new SafeArrayIterator(symlinks)) {
    try {
      await checkInside(path, original);
    } catch (error) {
      if (
        ObjectPrototypeIsPrototypeOf(ErrorPrototype, error) &&
        error.name === "NotFound"
      ) {
        // Dangling links point nowhere yet.
        continue;
      }
      escaped ??= error;
      await fs.remove(path);
    }
  }
  if (escaped !== null) throw escaped;
}

const tar = ObjectFreeze({ create, read, pack, extract });

return { tar };
})();
