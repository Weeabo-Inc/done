// Copyright 2018-2026 the Deno authors. MIT license.

import { core, internals, primordials } from "ext:core/mod.js";
import {
  op_net_listen_udp,
  op_net_listen_unixpacket,
  op_runtime_cpu_usage,
  op_runtime_memory_usage,
} from "ext:core/ops";

const timers = core.loadExtScript("ext:deno_web/02_timers.js");
const httpClient = core.loadExtScript("ext:deno_fetch/22_http_client.js");
const console = core.loadExtScript("ext:deno_web/01_console.js");
const ffi = core.loadExtScript("ext:deno_ffi/00_ffi.js");
const net = core.loadExtScript("ext:deno_net/01_net.js");
const tls = core.loadExtScript("ext:deno_net/02_tls.js");
// `Deno.serve` is the eager loader chain into 22_body -> 06_streams (the
// 208 KB web streams polyfill). Defer until first access so programs that
// don't use Deno.serve don't pay the parse cost at startup.
let _serveImpl;
function lazyServe() {
  return _serveImpl ??
    (_serveImpl = core.loadExtScript("ext:deno_http/00_serve.ts"));
}
// Deno.serveHttp and Deno.upgradeWebSocket each chain through
// 23_request -> 22_body -> 06_streams (208 KB). Defer both.
let _httpImpl;
function lazyHttp() {
  return _httpImpl ??
    (_httpImpl = core.loadExtScript("ext:deno_http/01_http.js"));
}
let _websocketImpl;
function lazyWebsocket() {
  return _websocketImpl ??
    (_websocketImpl = core.loadExtScript("ext:deno_http/02_websocket.ts"));
}
const errors = core.loadExtScript("ext:runtime/01_errors.js");
const version = core.loadExtScript("ext:runtime/01_version.ts");
const permissions = core.loadExtScript("ext:runtime/10_permissions.js");
const io = core.loadExtScript("ext:deno_io/12_io.js");
const fs = core.loadExtScript("ext:deno_fs/30_fs.js");
const os = core.loadExtScript("ext:deno_os/30_os.js");
const fsEvents = core.loadExtScript("ext:runtime/40_fs_events.js");
// Deno.Command / Deno.run / etc.: 40_process.js extends ReadableStream at
// module body, which pulls 06_streams.js (208 KB). Defer.
let _processImpl;
function lazyProcess() {
  return _processImpl ??
    (_processImpl = core.loadExtScript("ext:deno_process/40_process.js"));
}
const signals = core.loadExtScript("ext:deno_os/40_signals.js");
const tty = core.loadExtScript("ext:runtime/40_tty.js");
// Deno.Kv is a niche API and pulls 06_streams. Defer.
let _kvImpl;
function lazyKv() {
  return _kvImpl ?? (_kvImpl = core.loadExtScript("ext:deno_kv/01_db.ts"));
}
// `Deno.cron`, `Deno.UnsafeWindowSurface`, `Deno.telemetry` are rarely used
// and their backing modules (`01_cron.ts`, `02_surface.js`, `telemetry.ts`)
// are several KB of bytecode + closures each in the snapshot heap. Defer the
// `loadExtScript()` calls so they don't materialize at snapshot build time:
// only on first property access at runtime.
let _cron;
const lazyCron = () =>
  _cron ?? (_cron = core.loadExtScript("ext:deno_cron/01_cron.ts"));
let _surface;
const lazySurface = () =>
  _surface ??
    (_surface = core.loadExtScript("ext:deno_canvas/02_surface.js"));
let _telemetry;
const lazyTelemetry = () =>
  _telemetry ??
    (_telemetry = core.loadExtScript("ext:deno_telemetry/telemetry.ts"));
import { unstableIds } from "ext:deno_features/flags.js";
const { loadWebGPU } = core.loadExtScript("ext:deno_webgpu/00_init.js");
import { bundle } from "ext:deno_bundle_runtime/bundle.ts";

const { ObjectDefineProperty, Float64Array } = primordials;

const loadQuic = core.createLazyLoader("ext:deno_net/03_quic.js");
const loadWebTransport = core.createLazyLoader(
  "ext:deno_web/webtransport.js",
);

// Each entry here is a property on `internals` (i.e. `Deno[Deno.internal]`)
// that's defined at module body time by a `lazy_loaded_js` polyfill (e.g.
// `internals.serveHttpOnListener = ...` at the end of `00_serve.ts`). When
// the lazy script hasn't loaded yet, the property is `undefined` and any
// caller that captured it (Deno's own unit tests, user code reaching into
// `Deno[Deno.internal]`) sees `undefined`. Define a configurable accessor
// here so the first read triggers the lazy load and the polyfill's own
// `internals.X = value;` assignment then replaces this accessor with a
// plain data property via the setter. After the first read it costs the
// same as a direct property access.
function defineLazyInternal(name, specifier) {
  ObjectDefineProperty(internals, name, {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() {
      core.loadExtScript(specifier);
      // The script body's `internals.X = value;` ran during loadExtScript;
      // our setter below replaced this accessor with a data property, so
      // this read goes to that data property and returns the real value.
      return internals[name];
    },
    set(value) {
      ObjectDefineProperty(internals, name, {
        __proto__: null,
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
}

// `ext:deno_http/00_serve.ts` (registers serve internals at module body).
defineLazyInternal("addTrailers", "ext:deno_http/00_serve.ts");
defineLazyInternal("serveHttpOnListener", "ext:deno_http/00_serve.ts");
defineLazyInternal("serveHttpOnConnection", "ext:deno_http/00_serve.ts");
// `ext:deno_cron/01_cron.ts` registers `internals.formatToCronSchedule` /
// `internals.parseScheduleToString` at module body. Now that cron is lazy
// (see `lazyCron` below), expose these via the same accessor pattern so
// `cron_test.ts` (which destructures them from `Deno[Deno.internal]`) and
// any user code reaching in keep working.
defineLazyInternal("formatToCronSchedule", "ext:deno_cron/01_cron.ts");
defineLazyInternal("parseScheduleToString", "ext:deno_cron/01_cron.ts");
// `ext:deno_http/02_websocket.ts`.
defineLazyInternal(
  "buildCaseInsensitiveCommaValueFinder",
  "ext:deno_http/02_websocket.ts",
);
// `ext:deno_fetch/23_request.js`.
defineLazyInternal("getCachedAbortSignal", "ext:deno_fetch/23_request.js");
// `ext:deno_process/40_process.js` (registers process internals at module body).
defineLazyInternal("getExtraPipeRids", "ext:deno_process/40_process.js");
defineLazyInternal("getIpcPipeRid", "ext:deno_process/40_process.js");
defineLazyInternal("kExtraStdio", "ext:deno_process/40_process.js");

// the out buffer for `cpuUsage` and `memoryUsage`
const usageBuffer = new Float64Array(4);

const denoNs = {
  Process: undefined,
  run: undefined,
  isatty: tty.isatty,
  writeFileSync: fs.writeFileSync,
  writeFile: fs.writeFile,
  writeTextFileSync: fs.writeTextFileSync,
  writeTextFile: fs.writeTextFile,
  readTextFile: fs.readTextFile,
  readTextFileSync: fs.readTextFileSync,
  readFile: fs.readFile,
  readFileSync: fs.readFileSync,
  watchFs: fsEvents.watchFs,
  chmodSync: fs.chmodSync,
  chmod: fs.chmod,
  chown: fs.chown,
  chownSync: fs.chownSync,
  copyFileSync: fs.copyFileSync,
  cwd: fs.cwd,
  makeTempDirSync: fs.makeTempDirSync,
  makeTempDir: fs.makeTempDir,
  makeTempFileSync: fs.makeTempFileSync,
  makeTempFile: fs.makeTempFile,
  cpuUsage: () => {
    op_runtime_cpu_usage(usageBuffer);
    const { 0: system, 1: user } = usageBuffer;
    return {
      system,
      user,
    };
  },
  memoryUsage: () => {
    op_runtime_memory_usage(usageBuffer);
    const {
      0: rss,
      1: heapTotal,
      2: heapUsed,
      3: external,
    } = usageBuffer;
    return {
      rss,
      heapTotal,
      heapUsed,
      external,
    };
  },
  mkdirSync: fs.mkdirSync,
  mkdir: fs.mkdir,
  chdir: fs.chdir,
  copyFile: fs.copyFile,
  readDirSync: fs.readDirSync,
  readDir: fs.readDir,
  readLinkSync: fs.readLinkSync,
  readLink: fs.readLink,
  realPathSync: fs.realPathSync,
  realPath: fs.realPath,
  removeSync: fs.removeSync,
  remove: fs.remove,
  renameSync: fs.renameSync,
  rename: fs.rename,
  version: version.version,
  build: core.build,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  stat: fs.stat,
  lstat: fs.lstat,
  truncateSync: fs.truncateSync,
  truncate: fs.truncate,
  errors: errors.errors,
  inspect: console.inspect,
  env: os.env,
  exit: os.exit,
  execPath: os.execPath,
  SeekMode: io.SeekMode,
  FsFile: fs.FsFile,
  open: fs.open,
  openSync: fs.openSync,
  create: fs.create,
  createSync: fs.createSync,
  stdin: io.stdin,
  stdout: io.stdout,
  stderr: io.stderr,
  connect: net.connect,
  listen: net.listen,
  loadavg: os.loadavg,
  connectTls: tls.connectTls,
  listenTls: tls.listenTls,
  startTls: tls.startTls,
  symlink: fs.symlink,
  symlinkSync: fs.symlinkSync,
  link: fs.link,
  linkSync: fs.linkSync,
  permissions: permissions.permissions,
  Permissions: permissions.Permissions,
  PermissionStatus: permissions.PermissionStatus,
  serveHttp: undefined,
  serve: undefined,
  resolveDns: net.resolveDns,
  upgradeWebSocket: undefined,
  utime: fs.utime,
  utimeSync: fs.utimeSync,
  kill: undefined,
  addSignalListener: signals.addSignalListener,
  removeSignalListener: signals.removeSignalListener,
  refTimer: timers.refTimer,
  unrefTimer: timers.unrefTimer,
  osRelease: os.osRelease,
  osUptime: os.osUptime,
  hostname: os.hostname,
  systemMemoryInfo: os.systemMemoryInfo,
  networkInterfaces: os.networkInterfaces,
  consoleSize: tty.consoleSize,
  gid: os.gid,
  uid: os.uid,
  Command: undefined,
  ChildProcess: undefined,
  spawn: undefined,
  spawnAndWait: undefined,
  spawnAndWaitSync: undefined,
  dlopen: ffi.dlopen,
  UnsafeCallback: ffi.UnsafeCallback,
  UnsafePointer: ffi.UnsafePointer,
  UnsafePointerView: ffi.UnsafePointerView,
  UnsafeFnPointer: ffi.UnsafeFnPointer,
  umask: fs.umask,
  HttpClient: httpClient.HttpClient,
  createHttpClient: httpClient.createHttpClient,
  get telemetry() {
    return lazyTelemetry().telemetry;
  },
};

core.defineGlobalProperties(denoNs, {
  Process: core.propWritableLazyLoaded(
    (process) => process.Process,
    lazyProcess,
  ),
  run: core.propWritableLazyLoaded((process) => process.run, lazyProcess),
  serveHttp: core.propWritableLazyLoaded((http) => http.serveHttp, lazyHttp),
  serve: core.propWritableLazyLoaded((serve) => serve.serve, lazyServe),
  upgradeWebSocket: core.propWritableLazyLoaded(
    (websocket) => websocket.upgradeWebSocket,
    lazyWebsocket,
  ),
  kill: core.propWritableLazyLoaded((process) => process.kill, lazyProcess),
  Command: core.propWritableLazyLoaded(
    (process) => process.Command,
    lazyProcess,
  ),
  ChildProcess: core.propWritableLazyLoaded(
    (process) => process.ChildProcess,
    lazyProcess,
  ),
  spawn: core.propWritableLazyLoaded((process) => process.spawn, lazyProcess),
  spawnAndWait: core.propWritableLazyLoaded(
    (process) => process.spawnAndWait,
    lazyProcess,
  ),
  spawnAndWaitSync: core.propWritableLazyLoaded(
    (process) => process.spawnAndWaitSync,
    lazyProcess,
  ),
});

const denoNsUnstableById = { __proto__: null };

denoNsUnstableById[unstableIds.bundle] = {
  bundle,
};

// denoNsUnstableById[unstableIds.broadcastChannel] = { __proto__: null }

denoNsUnstableById[unstableIds.cron] = {
  get cron() {
    return lazyCron().cron;
  },
};

denoNsUnstableById[unstableIds.kv] = {
  get openKv() {
    return lazyKv().openKv;
  },
  get AtomicOperation() {
    return lazyKv().AtomicOperation;
  },
  get Kv() {
    return lazyKv().Kv;
  },
  get KvU64() {
    return lazyKv().KvU64;
  },
  get KvListIterator() {
    return lazyKv().KvListIterator;
  },
};

denoNsUnstableById[unstableIds.net] = {
  listenDatagram: net.createListenDatagram(
    op_net_listen_udp,
    op_net_listen_unixpacket,
  ),
};

core.defineGlobalProperties(denoNsUnstableById[unstableIds.net], {
  connectQuic: core.propWritableLazyLoaded((q) => q.connectQuic, loadQuic),
  QuicEndpoint: core.propWritableLazyLoaded((q) => q.QuicEndpoint, loadQuic),
  QuicBidirectionalStream: core.propWritableLazyLoaded(
    (q) => q.QuicBidirectionalStream,
    loadQuic,
  ),
  QuicConn: core.propWritableLazyLoaded((q) => q.QuicConn, loadQuic),
  QuicListener: core.propWritableLazyLoaded((q) => q.QuicListener, loadQuic),
  QuicReceiveStream: core.propWritableLazyLoaded(
    (q) => q.QuicReceiveStream,
    loadQuic,
  ),
  QuicSendStream: core.propWritableLazyLoaded(
    (q) => q.QuicSendStream,
    loadQuic,
  ),
  QuicIncoming: core.propWritableLazyLoaded((q) => q.QuicIncoming, loadQuic),
  upgradeWebTransport: core.propWritableLazyLoaded(
    (wt) => wt.upgradeWebTransport,
    loadWebTransport,
  ),
});

// denoNsUnstableById[unstableIds.unsafeProto] = { __proto__: null }

denoNsUnstableById[unstableIds.webgpu] = {
  get UnsafeWindowSurface() {
    return lazySurface().UnsafeWindowSurface;
  },
};
core.defineGlobalProperties(denoNsUnstableById[unstableIds.webgpu], {
  webgpu: core.propWritableLazyLoaded(
    (webgpu) => webgpu.denoNsWebGPU,
    loadWebGPU,
  ),
});

// denoNsUnstableById[unstableIds.workerOptions] = { __proto__: null }

// Mokou's built-in standard library (ext/mokou). Each API is loaded on first
// access, so programs that don't use it pay nothing at startup.
function lazyScript(specifier) {
  let mod;
  return () => mod ?? (mod = core.loadExtScript(specifier));
}
const loadMokouAssert = lazyScript("ext:deno_mokou/00_assert.js");
const loadMokouSqlite = lazyScript("ext:deno_mokou/01_sqlite.js");
const loadMokouPassword = lazyScript(
  "ext:deno_mokou/02_password.js",
);
const loadMokouHash = lazyScript("ext:deno_mokou/03_hash.js");
const loadMokouFormats = lazyScript("ext:deno_mokou/04_formats.js");
const loadMokouGlob = lazyScript("ext:deno_mokou/05_glob.js");
const loadMokouRouter = lazyScript("ext:deno_mokou/06_router.js");
const loadMokouSemver = lazyScript("ext:deno_mokou/07_semver.js");
const loadMokouUuid = lazyScript("ext:deno_mokou/08_uuid.js");
const loadMokouParseArgs = lazyScript(
  "ext:deno_mokou/09_parse_args.js",
);
const loadMokouShell = lazyScript("ext:deno_mokou/10_shell.js");
const loadMokouAnsi = lazyScript("ext:deno_mokou/11_ansi.js");
const loadMokouCookies = lazyScript("ext:deno_mokou/12_cookies.js");
const loadMokouJson = lazyScript("ext:deno_mokou/13_json.js");
const loadMokouS3 = lazyScript("ext:deno_mokou/14_s3.js");
const loadMokouHtml = lazyScript("ext:deno_mokou/15_html.js");
const loadMokouCsrf = lazyScript("ext:deno_mokou/16_csrf.js");
const loadMokouTar = lazyScript("ext:deno_mokou/17_tar.js");
const loadMokouTranspile = lazyScript("ext:deno_mokou/18_transpile.js");

function lazyProps(names, loader, target = { __proto__: null }) {
  const props = { __proto__: null };
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    props[name] = core.propWritableLazyLoaded((mod) => mod[name], loader);
  }
  core.defineGlobalProperties(target, props);
  return target;
}

denoNsUnstableById[unstableIds.assert] = lazyProps([
  "AssertionError",
  "assert",
  "assertArrayIncludes",
  "assertEquals",
  "assertExists",
  "assertFalse",
  "assertInstanceOf",
  "assertMatch",
  "assertNotEquals",
  "assertNotStrictEquals",
  "assertObjectMatch",
  "assertRejects",
  "assertStrictEquals",
  "assertStringIncludes",
  "assertThrows",
  "deepEquals",
  "expect",
  "fail",
  "mock",
  "unreachable",
], loadMokouAssert);
denoNsUnstableById[unstableIds.sqlite] = lazyProps(
  ["openSqlite", "SqliteDatabase"],
  loadMokouSqlite,
);
denoNsUnstableById[unstableIds.password] = lazyProps(
  ["password"],
  loadMokouPassword,
);
denoNsUnstableById[unstableIds.hash] = lazyProps(["hash"], loadMokouHash);
denoNsUnstableById[unstableIds.formats] = lazyProps(
  ["json5", "jsonc", "jsonl"],
  loadMokouJson,
  lazyProps(["csv", "toml", "yaml"], loadMokouFormats),
);
denoNsUnstableById[unstableIds.glob] = lazyProps(
  ["glob", "globSync"],
  loadMokouGlob,
);
denoNsUnstableById[unstableIds.router] = lazyProps(["router"], loadMokouRouter);
denoNsUnstableById[unstableIds.semver] = lazyProps(["semver"], loadMokouSemver);
denoNsUnstableById[unstableIds.uuid] = lazyProps(["uuid"], loadMokouUuid);
denoNsUnstableById[unstableIds.parseArgs] = lazyProps(
  ["parseArgs"],
  loadMokouParseArgs,
);
denoNsUnstableById[unstableIds.ansi] = lazyProps(["ansi"], loadMokouAnsi);
denoNsUnstableById[unstableIds.cookies] = lazyProps(
  ["cookies"],
  loadMokouCookies,
);
denoNsUnstableById[unstableIds.html] = lazyProps(
  ["escapeHTML", "markdown"],
  loadMokouHtml,
);
denoNsUnstableById[unstableIds.csrf] = lazyProps(["csrf"], loadMokouCsrf);
denoNsUnstableById[unstableIds.tar] = lazyProps(["tar"], loadMokouTar);
denoNsUnstableById[unstableIds.transpile] = lazyProps(
  ["transpile"],
  loadMokouTranspile,
);
denoNsUnstableById[unstableIds.s3] = lazyProps(
  ["S3Client", "S3Error"],
  loadMokouS3,
);
denoNsUnstableById[unstableIds.shell] = lazyProps(
  ["$", "ShellError"],
  loadMokouShell,
);

export { denoNs, denoNsUnstableById, unstableIds };
