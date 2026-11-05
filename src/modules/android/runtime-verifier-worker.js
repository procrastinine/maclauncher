const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os"), crypto = require("node:crypto");
const { parentPort } = require("node:worker_threads");
const Bundled = require("../shared/runtime/bundled-native");

// Only a bounded inventory of identities is retained, never payload bytes.
const cache = new Map(), CACHE_LIMIT = 4;
// Independent game workers reuse the same verified immutable payload. The
// index is outside every guest sandbox and retains only four fingerprints,
// never runtime bytes. A changed inode, ctime, mode or directory invalidates it.
const cacheDirectory = path.join(os.tmpdir(), "maclauncher-android-verification-" + process.getuid());
const cacheFile = path.join(cacheDirectory, "identities.json");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function privateDirectory() {
  try {
    fs.mkdirSync(cacheDirectory, { mode: 0o700 });
  } catch (error) { if (error.code !== "EEXIST") return false; }
  const stat = fs.lstatSync(cacheDirectory);
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}
function storedIdentities() {
  try {
    if (!privateDirectory()) return [];
    const fd = fs.openSync(cacheFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) return [];
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      return value.version === 1 && Array.isArray(value.entries) ? value.entries.filter(entry =>
        Array.isArray(entry) && entry.length === 2 && entry.every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))).slice(-CACHE_LIMIT) : [];
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}
function remember(key, identity) {
  let temporary;
  try {
    if (!privateDirectory()) return;
    const entries = storedIdentities().filter(entry => entry[0] !== key);
    entries.push([key, identity]);
    temporary = path.join(cacheDirectory, "write-" + crypto.randomUUID());
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: entries.slice(-CACHE_LIMIT) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, cacheFile);
  } catch { /* Cache availability never changes whether a payload can run. */ }
  finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
}
function snapshot(root, declaration, resolveDependency) {
  if (!Bundled.realDirectory(root)) throw new Error("Bundled runtime payload is missing.");
  const files = [], identities = [];
  function visit(relative, depth) {
    if (depth > 32) throw new Error("Bundled runtime directory nesting exceeds its limit.");
    const full = path.join(root, relative), stat = fs.lstatSync(full, { bigint: true });
    if (stat.isSymbolicLink()) {
      const target=declaration.aliases?.files?.[relative];
      const selected=target && typeof target==='object' ? resolveDependency(target,declaration.dependencies.find(dep=>dep.project===target.project)) : null;
      const local=typeof target==='string'&&Bundled.localMachO(declaration.files.find(file=>file.path===target))?path.join(root,target):null;
      const canonical=selected?.path || local || Bundled.appAlias(full);
      const managed=Bundled.isManagedDeclaration(declaration);
      if(!canonical || path.isAbsolute(fs.readlinkSync(full)) || (managed ?
          !fs.realpathSync(full).startsWith(fs.realpathSync(selected?.root || root)+path.sep) :
          fs.realpathSync(full)!==fs.realpathSync(canonical) || (selected || local) && fs.readlinkSync(full)!==path.relative(path.dirname(full),canonical)))throw new Error("Bundled runtime has undeclared dependency aliases or symlinks.");
      files.push(relative);identities.push(relative+':'+fs.readlinkSync(full)+':'+Bundled.fileIdentity(canonical));return;
    }
    if (stat.isDirectory()) {
      identities.push([relative, stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":"));
      for (const name of fs.readdirSync(full).sort()) visit(Bundled.relativeFile(path.posix.join(relative, name)), depth + 1);
    } else if (stat.isFile()) {
      identities.push(relative + ":" + Bundled.fileIdentity(full));
      files.push(relative);
      if (files.length > Bundled.LIMITS.files) throw new Error("Bundled runtime has too many files.");
    } else throw new Error("Bundled runtimes may contain only regular files and directories.");
  }
  visit("", 0);
  if (!Bundled.isManagedDeclaration(declaration) && JSON.stringify(files.sort()) !== JSON.stringify((declaration.aliases ? require("../shared/runtime/package-contract.cjs").logicalFiles(declaration,resolveDependency) : declaration.files).map(file => file.path).sort()))
    throw new Error("Bundled runtime file inventory differs from its manifest.");
  return JSON.stringify(identities);
}
function verify(root, declaration, dependencyFiles = {}, dependencyPackages=[]) {
  const resolveDependency=(target,dependency)=>{
    const selected=dependencyFiles[target.project+':'+target.path];
    if(!selected||!Bundled.isManagedDeclaration(declaration)&&JSON.stringify(selected.dependency)!==JSON.stringify(dependency))throw new Error("Android dependency selection changed.");
    return selected;
  };
  root = path.resolve(root);
  const dependencyResolve=require('../shared/runtime/package-dependencies').resolverFromFacts(dependencyPackages);
  const identity=()=>JSON.stringify([snapshot(root,declaration,resolveDependency),...dependencyPackages.map(item=>snapshot(item.root,item.declaration,dependencyResolve))]);
  const key = JSON.stringify([root, declaration, dependencyFiles,dependencyPackages,Bundled.isManagedDeclaration(declaration)]), before = identity();
  const persistentKey = digest(key), persistentIdentity = digest(before);
  if (cache.get(key) === before || storedIdentities().some(entry => entry[0] === persistentKey && entry[1] === persistentIdentity)) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.delete(key); cache.set(key, before);
    remember(persistentKey, persistentIdentity);
    return { cacheHit: true };
  }
  // A failed recheck must not retain an earlier successful verification.
  cache.delete(key);
  for(const item of dependencyPackages)Bundled.verifyPayload(item.root,item.declaration,dependencyResolve);
  Bundled.verifyPayload(root, declaration, resolveDependency);
  if (identity() !== before) throw new Error("Bundled runtime changed during verification.");
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, before);
  remember(persistentKey, persistentIdentity);
  return { cacheHit: false };
}
parentPort.on("message", ({ id, root, declaration, dependencyFiles,dependencyPackages,appBundle,managed }) => {
  if (managed) Bundled.managedDeclaration(declaration);
  for (const item of dependencyPackages || []) if (item.managed) Bundled.managedDeclaration(item.declaration);
  try { parentPort.postMessage({ id, result: appBundle ? Bundled.withAppBundle(appBundle,()=>verify(root,declaration,dependencyFiles,dependencyPackages)) : verify(root, declaration, dependencyFiles,dependencyPackages) }); }
  catch (error) { parentPort.postMessage({ id, error: { message: error.message, name: error.name, code: error.code } }); }
});
