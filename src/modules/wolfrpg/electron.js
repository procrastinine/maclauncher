const fs = require("node:fs");
const path = require("node:path");
const { prepareBrowserGlobals } = require("../shared/web/preload/nwjs-compat");
const { atomicWrite, assertOwnDirectory } = require("../shared/writable-input");

function bridgeSaves(virtualFS, directory, projectId) {
  const mount = "/data0/" + projectId + "-Save";
  const originalSync = virtualFS.syncfs.bind(virtualFS);
  let restoring = false, initialized = false;
  const knownFiles = new Set();
  function walkDisk(root, relative = "", files = [], limits = { count: 0, bytes: 0 }) {
    if (relative.split("/").length > 32 || ++limits.count > 100000) throw new Error("Save folder exceeds the storage limit.");
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Save files must not be aliases.");
      if (entry.isDirectory()) walkDisk(root, name, files, limits);
      else if (entry.isFile()) {
        const source = path.join(root, name), stat = fs.statSync(source);
        limits.bytes += stat.size;
        if (stat.size > 64 * 1024 ** 2 || files.length >= 10000 || limits.bytes > 1024 ** 3) throw new Error("Save folder exceeds the storage limit.");
        files.push({ name, source });
      }
    }
    return files;
  }
  function restore() {
    if (!virtualFS.analyzePath(mount).exists || !fs.existsSync(directory)) return;
    for (const entry of walkDisk(directory)) {
      const target = mount + "/" + entry.name;
      virtualFS.mkdirTree(path.posix.dirname(target));
      virtualFS.writeFile(target, fs.readFileSync(entry.source));
      knownFiles.add(entry.name);
    }
    initialized = true;
  }
  function flush() {
    if (restoring || !initialized || !virtualFS.analyzePath(mount).exists) return;
    assertOwnDirectory(directory, directory);
    let count = 0, totalBytes = 0;
    const currentFiles = new Set();
    function visit(root, relative = "", depth = 0) {
      if (depth > 32) throw new Error("Save folder is too deep.");
      for (const name of virtualFS.readdir(root)) {
        if (name === "." || name === "..") continue;
        if (/[\\/\0]/.test(name)) throw new Error("Invalid save filename.");
        const source = root + "/" + name, next = relative ? relative + "/" + name : name;
        const stat = virtualFS.stat(source);
        if (virtualFS.isDir(stat.mode)) visit(source, next, depth + 1);
        else {
          if (++count > 10000 || stat.size > 64 * 1024 ** 2) throw new Error("Save folder exceeds the storage limit.");
          totalBytes += stat.size;
          if (totalBytes > 1024 ** 3) throw new Error("Save folder exceeds the storage limit.");
          currentFiles.add(next);
          const bytes = Buffer.from(virtualFS.readFile(source)), dest = path.join(directory, next);
          // The original IndexedDB sync retains its behavior. Disk storage
          // makes saves independent of the local host's temporary port.
          let unchanged = false;
          try { unchanged = fs.lstatSync(dest).isFile() && fs.readFileSync(dest).equals(bytes); } catch {}
          if (!unchanged) atomicWrite(dest, bytes, { root: directory });
        }
      }
    }
    visit(mount);
    for (const name of knownFiles) if (!currentFiles.has(name)) {
      const file = path.join(directory, name);
      assertOwnDirectory(directory, path.dirname(file), { create: false });
      fs.rmSync(file, { force: true });
    }
    knownFiles.clear();
    for (const name of currentFiles) knownFiles.add(name);
  }
  virtualFS.syncfs = function syncfs(populate, callback) {
    if (typeof populate === "function") { callback = populate; populate = false; }
    callback ||= () => {};
    if (!populate) {
      try { flush(); } catch (error) { callback(error); return; }
      return originalSync(false, callback);
    }
    restoring = true;
    return originalSync(true, error => {
      try { if (!error) { restore(); initialized = true; } } catch (restoreError) { error = restoreError; }
      restoring = false; callback(error);
    });
  };
  return { flush, restore };
}
function install({ config, exposeInMainWorld }, target = globalThis) {
  prepareBrowserGlobals(target);
  let bridge;
  const directory = config.saveDir || path.join(config.gameDataDir, "modules", "wolfrpg", "saves");
  const api = {
    configure(runtime) {
      if (!runtime || runtime.__maclauncherWolfConfigured) return;
      runtime.__maclauncherWolfConfigured = true;
      if (config.gameArguments?.length) runtime.arguments = [...(runtime.arguments || []), ...config.gameArguments];
      runtime.preRun ||= [];
      runtime.preRun.push(() => {
        const relative = path.relative(config.gameDataDir, directory);
        assertOwnDirectory(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) ? directory : config.gameDataDir, directory);
        bridge = bridgeSaves(target.FS, directory, runtime.projectId);
      });
      const setStatus = runtime.setStatus;
      let starting = false;
      runtime.setStatus = function setRuntimeStatus(text) {
        setStatus?.call(this, text);
        if (text === "" && !starting) {
          starting = true;
          target.setTimeout(() => { target.initializeGame?.(); runtime.canvas?.focus(); }, 0);
        }
      };
    }
  };
  if (typeof exposeInMainWorld === "function") exposeInMainWorld("MacLauncherWolf", api);
  else target.MacLauncherWolf = api;
  const timer = target.setInterval(() => { try { bridge?.flush(); } catch (error) { console.error("[WOLF RPG] Save storage failed:", error.message); } }, 1000);
  target.addEventListener("beforeunload", () => { target.clearInterval(timer); bridge?.flush(); });
}
module.exports = { install, bridgeSaves };
