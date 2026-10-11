const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const observations = new AsyncLocalStorage();
const original = { statSync: fs.statSync, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync };
let installed = false;
function identity(file) {
  try {
    const link = original.lstatSync(file), stat = original.statSync(file);
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      link.isSymbolicLink() ? original.realpathSync(file) : null];
  } catch (error) { return [error.code || "unreadable"]; }
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
  scope.files.set(file, identity(file));
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
  const scope = { roots: roots.map(root => path.resolve(root)), excluded: excluded.map(root => path.resolve(root)), files: new Map(), overflow: false };
  const value = await observations.run(scope, run);
  return { value, files: [...scope.files], cacheable: !scope.overflow && unchanged([...scope.files]) };
}
function unchanged(files) {
  return Array.isArray(files) && files.length > 0 && files.length <= 8192 && files.every(item =>
    Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && path.isAbsolute(item[0]) &&
    JSON.stringify(identity(item[0])) === JSON.stringify(item[1]));
}

module.exports = { recordReads, unchanged, identity };
