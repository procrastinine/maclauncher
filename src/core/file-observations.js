const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const FileSignature = require("../modules/shared/file-signature");
const { hasFineChangeTime } = require("../modules/shared/file-time");

const observations = new AsyncLocalStorage();
const original = Object.fromEntries(["statSync", "lstatSync", "realpathSync", "opendirSync", "openSync", "readSync", "fstatSync", "closeSync"].map(name => [name, fs[name]]));
const MAX_HASH_BYTES = 16 * 1024 ** 2;
const budget = () => ({ bytes: 32 * 1024 ** 2, names: 8192 });
let installed = false;
function changeStamp(stat) { return `${FileSignature.signature(stat)}:${stat.ctimeNs ?? stat.ctimeMs}`; }
function coarseContents(file, stat, remaining) {
  if (stat.isDirectory()) {
    const directory = original.opendirSync(file), names = [];
    try {
      for (let entry; (entry = directory.readSync());) {
        if (--remaining.names < 0) return null;
        names.push([entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink(), entry.isBlockDevice(), entry.isCharacterDevice(), entry.isFIFO(), entry.isSocket()]);
      }
    } finally { directory.closeSync(); }
    return crypto.createHash("sha256").update(JSON.stringify(names.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))).digest("hex");
  }
  if (!stat.isFile() || stat.size > MAX_HASH_BYTES || stat.size > remaining.bytes) return null;
  remaining.bytes -= stat.size;
  const descriptor = original.openSync(file, fs.constants.O_RDONLY);
  try {
    if (changeStamp(original.fstatSync(descriptor)) !== changeStamp(stat)) return null;
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < stat.size;) {
      const read = original.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!read) return null;
      hash.update(buffer.subarray(0, read)); offset += read;
    }
    return changeStamp(original.fstatSync(descriptor)) === changeStamp(stat) ? hash.digest("hex") : null;
  } finally { original.closeSync(descriptor); }
}
function identity(file, remaining = budget()) {
  try {
    const link = original.lstatSync(file), stat = original.statSync(file);
    // Location signatures ignore mount metadata. Observed reads additionally
    // need change evidence; coarse timestamps require bounded content facts.
    const content = hasFineChangeTime(stat) ? stat.ctimeMs : coarseContents(file, stat, remaining);
    if (content === null) return null;
    return [FileSignature.signature(stat), stat.mode,
      link.isSymbolicLink() ? original.realpathSync(file) : null, content];
  } catch (error) { return error.code === "ENOENT" || error.code === "ENOTDIR" ? [error.code] : null; }
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function observe(value) {
  const scope = observations.getStore();
  if (!scope || typeof value !== "string" || value.includes("\0")) return;
  const file = path.resolve(value);
  if (!scope.roots.some(root => inside(root, file)) || scope.excluded.some(root => inside(root, file)) || scope.files.has(file)) return;
  if (scope.files.size >= 8192) { scope.overflow = true; return; }
  scope.files.set(file, identity(file, scope.remaining));
}
function install() {
  if (installed) return; installed = true;
  // Only scopes established by metadata analysis record reads. This is installed
  // in the backend worker; Electron's fs and runtime execution remain untouched.
  for (const method of ["statSync", "lstatSync", "existsSync", "readFileSync", "readdirSync", "opendirSync", "realpathSync", "readlinkSync"]) {
    const delegate = fs[method];
    fs[method] = function (...args) { observe(args[0]); return Reflect.apply(delegate, this, args); };
  }
  const open = fs.openSync;
  fs.openSync = function (...args) {
    if (args[1] == null || typeof args[1] === "string" && /^r/.test(args[1]) || typeof args[1] === "number" && (args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) observe(args[0]);
    return Reflect.apply(open, this, args);
  };
  for (const method of ["stat", "lstat", "readFile", "readdir", "opendir", "realpath", "readlink", "access"]) {
    const delegate = fs.promises[method];
    fs.promises[method] = function (...args) { observe(args[0]); return Reflect.apply(delegate, this, args); };
  }
}
async function recordReads({ roots, excluded = [] }, run) {
  install();
  const scope = { roots: roots.map(root => path.resolve(root)), excluded: excluded.map(root => path.resolve(root)), files: new Map(), overflow: false, remaining: budget() };
  const value = await observations.run(scope, run);
  return { value, files: [...scope.files], cacheable: !scope.overflow && unchanged([...scope.files]) };
}
function unchanged(files) {
  const remaining = budget();
  return Array.isArray(files) && files.length > 0 && files.length <= 8192 && files.every(item =>
    Array.isArray(item) && item.length === 2 && item[1] !== null && typeof item[0] === "string" && path.isAbsolute(item[0]) &&
    JSON.stringify(identity(item[0], remaining)) === JSON.stringify(item[1]));
}

module.exports = { recordReads, unchanged, identity };
