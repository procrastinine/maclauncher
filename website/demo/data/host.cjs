// Loaded before the demo data generator: presents one fixed host, an Apple
// Silicon Mac on macOS 26 with an empty home folder, so the data is the same
// on every machine. Other child processes and the network are refused, and the
// file system outside this checkout and the temporary profile looks empty, so
// nothing from the machine running it (installed apps, stores, settings)
// reaches the site.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const util = require("node:util");
const childProcess = require("node:child_process");

const MACOS = "26.0";
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-demo-home-"));
process.on("exit", () => fs.rmSync(process.env.HOME, { recursive: true, force: true }));
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "arm64" });
os.release = () => "25.0.0";
os.platform = () => "darwin";
os.arch = () => "arm64";

// The two host probes the launcher runs answer as that Mac would: the macOS
// version, and Metal graphics hardware with MetalFX support for every effect.
const metalfx = minimumMacOS => ({ supported: true, metal4Supported: true, minimumMacOS, minScale: 1, maxScale: 3 });
const gpu = { name: "Apple M4", registryID: "4294968296" };
const capabilities = { spatial: metalfx("13.0"), temporal: metalfx("13.0"), denoised: metalfx("26.0"), interpolation: metalfx("26.0") };
const ANSWERS = {
  sw_vers: `${MACOS}\n`,
  "maclauncher-graphics-hardware": JSON.stringify({ schema: 1, device: gpu, devices: [{ ...gpu, isDefault: true, metalfx: capabilities }], metalfx: capabilities })
};
const answer = file => ANSWERS[path.basename(String(file))];
const refused = file => Object.assign(new Error(`The demo data generator does not run ${file}.`), { code: "ENOENT" });
childProcess.execFileSync = (file, args, options) => {
  const text = answer(file);
  if (text === undefined) throw refused(file);
  const encoding = (Array.isArray(args) ? options : args)?.encoding;
  return encoding && encoding !== "buffer" ? text : Buffer.from(text);
};
childProcess.execFile = (file, ...rest) => {
  const callback = rest.findLast(item => typeof item === "function"), text = answer(file);
  const error = text === undefined ? refused(file) : null;
  const child = { on() { return child; }, once() { return child; }, kill() {}, stdout: null, stderr: null, pid: undefined };
  if (callback) queueMicrotask(() => callback(error, text || "", ""));
  return child;
};
childProcess.execFile[util.promisify.custom] = file => {
  const text = answer(file);
  return text === undefined ? Promise.reject(refused(file)) : Promise.resolve({ stdout: text, stderr: "" });
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "fork"]) {
  childProcess[name] = file => { throw refused(file); };
}

const roots = [...new Set([path.resolve(__dirname, "../../.."), os.tmpdir()].flatMap(root => {
  try { return [root, fs.realpathSync(root)]; } catch { return [root]; }
}))];
// Folders above an allowed root can be inspected (some code checks every
// parent for symlinks) but not listed or read.
const outside = (target, inspect = false) => {
  const value = target instanceof URL ? target.pathname : typeof target === "string" ? target : null;
  if (value === null) return false;
  const absolute = path.resolve(value);
  return !roots.some(root => absolute === root || absolute.startsWith(root + path.sep) ||
    inspect && (absolute === path.sep || root.startsWith(absolute + path.sep)));
};
const INSPECT = new Set(["statSync", "lstatSync", "realpathSync", "stat", "lstat", "realpath"]);
const missing = target => Object.assign(new Error(`ENOENT: no such file or directory, '${target}'`), { code: "ENOENT", errno: -2, path: String(target) });
for (const name of ["statSync", "lstatSync", "readdirSync", "readFileSync", "accessSync", "openSync", "opendirSync", "readlinkSync", "realpathSync"]) {
  const original = fs[name];
  const blocked = target => outside(target, INSPECT.has(name));
  const guarded = function (target, ...rest) { if (blocked(target)) throw missing(target); return original.call(this, target, ...rest); };
  if (original.native) guarded.native = function (target, ...rest) { if (blocked(target)) throw missing(target); return original.native.call(this, target, ...rest); };
  fs[name] = guarded;
}
const existsSync = fs.existsSync;
fs.existsSync = target => !outside(target, true) && existsSync(target);
for (const name of ["stat", "lstat", "readdir", "readFile", "access", "open", "opendir", "readlink", "realpath"]) {
  const original = fs.promises[name];
  fs.promises[name] = (target, ...rest) => outside(target, INSPECT.has(name)) ? Promise.reject(missing(target)) : original(target, ...rest);
  const callbackOriginal = fs[name];
  fs[name] = (target, ...rest) => {
    if (!outside(target, INSPECT.has(name))) return callbackOriginal(target, ...rest);
    const callback = rest.findLast(item => typeof item === "function");
    queueMicrotask(() => callback?.(missing(target)));
  };
}

// Nothing reaches the network: the data describes a launcher that has not
// refreshed or signed in to anything.
const offline = () => Object.assign(new Error("The demo data generator does not use the network."), { code: "ENETUNREACH" });
globalThis.fetch = () => Promise.reject(offline());
for (const module of [require("node:http"), require("node:https")]) {
  module.request = module.get = () => { throw offline(); };
}
for (const module of [require("node:net"), require("node:tls")]) {
  module.connect = module.createConnection = () => { throw offline(); };
}
