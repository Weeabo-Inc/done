// Copyright 2018-2026 the Deno authors. MIT license.
import { assert, assertEquals, assertRejects } from "./test_util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A raw ustar entry, for archives `Deno.tar.create()` refuses to make. */
function rawEntry(
  name: string,
  { type = "0", data = "", linkName = "" } = {},
): Uint8Array {
  const body = encoder.encode(data);
  const header = new Uint8Array(512);
  const put = (offset: number, text: string) =>
    header.set(encoder.encode(text), offset);
  put(0, name);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, body.length.toString(8).padStart(11, "0") + "\0");
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, type);
  put(157, linkName);
  put(257, "ustar\0");
  put(263, "00");
  const sum = header.reduce((a, b) => a + b, 0);
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return new Uint8Array([...header, ...padded]);
}

function rawArchive(...entries: Uint8Array[]) {
  return new Uint8Array([
    ...entries.flatMap((e) => [...e]),
    ...new Uint8Array(1024),
  ]);
}

Deno.test(async function tarCreateAndRead() {
  const mtime = new Date("2026-01-02T03:04:05Z");
  for (const gzip of [false, true]) {
    const archive = await Deno.tar.create([
      { path: "dir", type: "directory", mtime },
      { path: "dir/a.txt", data: "hello", mode: 0o600, mtime },
      { path: "./dir/b.bin", data: new Uint8Array([1, 2, 3]), mtime },
      { path: "c.json", data: new Blob(['{"a":1}']), mtime },
      { path: "d.txt", data: new Uint8Array([7]).buffer, mtime },
      { path: "link", type: "symlink", linkName: "dir/a.txt", mtime },
      { path: `${"x".repeat(120)}/long.txt`, data: "long", mtime },
    ], { gzip });
    assert(archive instanceof Uint8Array);
    assertEquals(archive[0] === 0x1f && archive[1] === 0x8b, gzip);

    const entries = await Deno.tar.read(archive);
    assertEquals(entries.map((e) => [e.path, e.type]), [
      ["dir", "directory"],
      ["dir/a.txt", "file"],
      ["dir/b.bin", "file"],
      ["c.json", "file"],
      ["d.txt", "file"],
      ["link", "symlink"],
      [`${"x".repeat(120)}/long.txt`, "file"],
    ]);
    assertEquals(decoder.decode(entries[1].data), "hello");
    assertEquals(entries[1].mode, 0o600);
    assertEquals(entries[1].size, 5);
    assertEquals(entries[1].mtime, mtime);
    assertEquals(entries[0].mode, 0o755);
    assertEquals(entries[0].data, undefined);
    assertEquals(entries[2].data, new Uint8Array([1, 2, 3]));
    assertEquals(entries[2].mode, 0o644);
    assertEquals(decoder.decode(entries[3].data), '{"a":1}');
    assertEquals(entries[4].data, new Uint8Array([7]));
    assertEquals(entries[5].linkName, "dir/a.txt");
    assertEquals(decoder.decode(entries[6].data), "long");
  }
});

Deno.test(async function tarCreateFromRecord() {
  const archive = await Deno.tar.create({
    "a.txt": "a",
    "nested/b.txt": encoder.encode("b"),
  });
  const entries = await Deno.tar.read(new Blob([archive]));
  assertEquals(
    entries.map((e) => [e.path, decoder.decode(e.data)]),
    [["a.txt", "a"], ["nested/b.txt", "b"]],
  );
});

Deno.test(async function tarCreateRejectsUnsafePaths() {
  for (const path of ["/etc/passwd", "../up", "a/../../up", "C:\\x", ""]) {
    await assertRejects(
      () => Deno.tar.create([{ path, data: "x" }]),
      TypeError,
    );
  }
  await assertRejects(
    () => Deno.tar.create([{ path: "l", type: "symlink" }]),
    TypeError,
    "linkName",
  );
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => Deno.tar.create([{ path: "f", type: "fifo" as any }]),
    TypeError,
    "Unsupported",
  );
});

Deno.test(async function tarReadRejectsInvalidArchives() {
  await assertRejects(
    () => Deno.tar.read(new Uint8Array([0x1f, 0x8b, 1, 2, 3])),
    TypeError,
    "Invalid tar archive",
  );
  await assertRejects(
    () => Deno.tar.read(new Uint8Array(100).fill(1)),
    TypeError,
    "Invalid tar archive",
  );
});

Deno.test(
  { permissions: { read: true, write: true } },
  async function tarPackAndExtract() {
    const src = await Deno.makeTempDir();
    const dest = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${src}/sub/deep`, { recursive: true });
      await Deno.writeTextFile(`${src}/top.txt`, "top");
      await Deno.writeTextFile(`${src}/sub/deep/x.txt`, "x");
      await Deno.writeTextFile(`${src}/skip.log`, "skip");
      if (Deno.build.os !== "windows") {
        await Deno.chmod(`${src}/top.txt`, 0o751);
        await Deno.symlink("deep/x.txt", `${src}/sub/link`);
      }
      const archive = await Deno.tar.pack(src, {
        gzip: true,
        filter: (path) => !path.endsWith(".log"),
      });
      const paths = (await Deno.tar.read(archive)).map((e) => e.path);
      assertEquals(
        paths,
        Deno.build.os === "windows"
          ? ["sub", "sub/deep", "sub/deep/x.txt", "top.txt"]
          : ["sub", "sub/deep", "sub/deep/x.txt", "sub/link", "top.txt"],
      );

      await Deno.tar.extract(archive, dest);
      assertEquals(await Deno.readTextFile(`${dest}/top.txt`), "top");
      assertEquals(await Deno.readTextFile(`${dest}/sub/deep/x.txt`), "x");
      if (Deno.build.os !== "windows") {
        assertEquals((await Deno.stat(`${dest}/top.txt`)).mode! & 0o777, 0o751);
        assertEquals(await Deno.readLink(`${dest}/sub/link`), "deep/x.txt");
        assertEquals(await Deno.readTextFile(`${dest}/sub/link`), "x");
      }
      const srcMtime = (await Deno.stat(`${src}/top.txt`)).mtime!;
      assertEquals(
        (await Deno.stat(`${dest}/top.txt`)).mtime!.getTime(),
        Math.floor(srcMtime.getTime() / 1000) * 1000,
      );

      // `strip` drops leading segments.
      const stripped = await Deno.makeTempDir();
      await Deno.tar.extract(archive, stripped, { strip: 1 });
      assertEquals(await Deno.readTextFile(`${stripped}/deep/x.txt`), "x");
      await Deno.remove(stripped, { recursive: true });
    } finally {
      await Deno.remove(src, { recursive: true });
      await Deno.remove(dest, { recursive: true });
    }
  },
);

Deno.test(
  { permissions: { read: true, write: true } },
  async function tarExtractStaysInsideTheDirectory() {
    const dest = await Deno.makeTempDir();
    const outside = await Deno.makeTempDir();
    try {
      const attempts: [Uint8Array, string][] = [
        [rawArchive(rawEntry("../evil.txt", { data: "x" })), "leaves its root"],
        [rawArchive(rawEntry("/abs.txt", { data: "x" })), "Absolute path"],
        [
          rawArchive(rawEntry("ln", { type: "2", linkName: "/etc/passwd" })),
          "absolute path",
        ],
        [
          rawArchive(rawEntry("a/ln", { type: "2", linkName: "../../x" })),
          "links outside",
        ],
        [
          rawArchive(rawEntry("hard", { type: "1", linkName: "../x" })),
          "leaves its root",
        ],
      ];
      for (const [archive, message] of attempts) {
        await assertRejects(
          () => Deno.tar.extract(archive, dest),
          Error,
          message,
        );
      }
      // Links inside the directory are fine.
      await Deno.tar.extract(
        rawArchive(
          rawEntry("a/file.txt", { data: "ok" }),
          rawEntry("a/ln", { type: "2", linkName: "../a/file.txt" }),
        ),
        dest,
      );
      if (Deno.build.os !== "windows") {
        assertEquals(await Deno.readTextFile(`${dest}/a/ln`), "ok");
        // An existing symlink pointing outside can't be written through.
        await Deno.symlink(outside, `${dest}/out`);
        await assertRejects(
          () =>
            Deno.tar.extract(
              rawArchive(rawEntry("out/x.txt", { data: "x" })),
              dest,
            ),
          Error,
          "resolves outside",
        );
        await assertRejects(
          () =>
            Deno.tar.extract(rawArchive(rawEntry("out", { data: "x" })), dest),
          Error,
          "is a symbolic link",
        );
      }
      // A chain of links that each look inside, but together lead outside.
      const chained = await Deno.makeTempDir({ dir: outside });
      await assertRejects(
        () =>
          Deno.tar.extract(
            rawArchive(
              rawEntry("a/keep.txt", { data: "x" }),
              rawEntry("a/l1", { type: "2", linkName: ".." }),
              rawEntry("a/l2", { type: "2", linkName: "l1/../.." }),
            ),
            chained,
          ),
        Error,
        "resolves outside",
      );
      assertEquals(await Deno.readLink(`${chained}/a/l1`), "..");
      await assertRejects(
        () => Deno.lstat(`${chained}/a/l2`),
        Deno.errors.NotFound,
      );
      await Deno.remove(chained, { recursive: true });
      assertEquals([...Deno.readDirSync(outside)], []);
    } finally {
      await Deno.remove(dest, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
);

Deno.test(
  { permissions: { read: true, write: false } },
  async function tarExtractNeedsWritePermission() {
    const archive = await Deno.tar.create({ "a.txt": "a" });
    await assertRejects(
      () => Deno.tar.extract(archive, "never-written"),
      Deno.errors.NotCapable,
    );
  },
);
