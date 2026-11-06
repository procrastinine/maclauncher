const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("./local-native");
const { hasFineChangeTime } = require("../file-time");
const { fileDigest } = require("./verified-identity");
const PE = require("./pe-exports");
const { versionAtLeast } = require("./host-capabilities");
const run = promisify(execFile);

const LIMITS = Object.freeze({ manifestBytes: 8 * 1024 * 1024, files: 20000, fileBytes: 256 * 1024 * 1024, bytes: 1024 * 1024 * 1024 });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const appBundleContext = new (require('node:async_hooks').AsyncLocalStorage)();
function appBundleRoot(){
 const scoped=appBundleContext.getStore();if(scoped)return scoped;
 const match=/^(.*\.app)\/Contents\/Resources\//.exec(__filename);
 return match?fs.realpathSync(match[1]):null;
}
function withAppBundle(root,operation){
 const real=fs.realpathSync(root);if(!real.endsWith('.app'))throw new Error('Application verification needs its exact bundle.');
 return appBundleContext.run(real,operation);
}
function dependencyResolver(root,manifest){
 const P=require('./package-dependencies');
 const context=P.contextForPayload(root);
 if(context.declaration)return context.resolveDependency;
 const bundle=appBundleRoot(),resources=bundle?path.join(bundle,'Contents/Resources'):require('./included-helpers').SOURCE_RESOURCES;
 if(path.resolve(root).startsWith(path.join(resources,'native-runtimes')+path.sep))
  return require('./included-package-dependencies').context(resources,{verification:'status'}).resolveDependencies(manifest.dependencies).resolveDependency;
 throw new Error('A package dependency needs its exact installed sealed file.');
}

// Display refreshes share parsed manifests. Full verification repeats every
// policy check; precise unchanged file identities can reuse their digest.
const manifestCache = new Map();
const dependencyContexts = new WeakMap();
// Managed archives are digest-bound catalog downloads, not app-lock inventories.
const managedDeclarations = new WeakSet();
function managedDeclaration(declaration) { managedDeclarations.add(declaration); return declaration; }
const isManagedDeclaration = declaration => managedDeclarations.has(declaration);
function rememberDependencies(declaration,resolveDependency){if(declaration&&resolveDependency)dependencyContexts.set(declaration,resolveDependency);}
const MANIFEST_CACHE_LIMIT = 128;

// App assembly may share a file between sealed included packages. Only a
// relative leaf alias inside the same real app bundle is accepted here; the
// caller still checks the original logical path's sealed bytes and inventory.
function appAlias(file) {
  const root = appBundleRoot();
  if (!root) return null;
  const absolute = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  if (!absolute.startsWith(path.join(root,'Contents')+path.sep) || !fs.lstatSync(absolute).isSymbolicLink()) return null;
  let current = absolute;
  for (let depth = 0; depth < 64; depth++) {
    realDirectory(path.dirname(current));
    const stat = fs.lstatSync(current);
    if (!stat.isSymbolicLink()) {
      if (!stat.isFile()) throw new Error("Application alias target must be a regular file.");
      return current;
    }
    const target = fs.readlinkSync(current);
    if (path.isAbsolute(target)) throw new Error("Application aliases must be relative.");
    current = path.resolve(path.dirname(current), target);
    if (!current.startsWith(root + path.sep)) throw new Error("Application alias escapes its bundle.");
  }
  throw new Error("Application alias is cyclic.");
}

function fileIdentity(file, { maximum = LIMITS.fileBytes } = {}) {
  if (!realDirectory(path.dirname(file))) throw new Error("Bundled runtime directory is missing.");
  const stat = fs.lstatSync(appAlias(file) || file, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(maximum)) throw new Error("Bundled runtime file is not regular or exceeds its limit.");
  const identity = [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
  // Coarse change times cannot authorize byte-verification cache reuse.
  return hasFineChangeTime(stat) ? identity : identity + ":" + readRegular(file, maximum).sha256;
}

function clearManifestCache(directory) {
  const root = directory && path.resolve(directory);
  for (const file of manifestCache.keys()) {
    if (!root || file === root || file.startsWith(root + path.sep)) manifestCache.delete(file);
  }
}

function readManifest(file, expected, { cached = false } = {}) {
  const absolute = path.resolve(file);
  const identity = cached ? fileIdentity(absolute, { maximum: LIMITS.manifestBytes }) : null;
  let stored = cached && manifestCache.get(absolute);
  if (!stored || stored.identity !== identity) {
    const content = readRegular(absolute, LIMITS.manifestBytes);
    const manifest = validateManifest(JSON.parse(content.bytes));
    stored = { identity, manifest, sha256: content.sha256 };
    if (cached) {
      // A write during the initial read must not populate a stale display entry.
      if (fileIdentity(absolute, { maximum: LIMITS.manifestBytes }) !== identity) throw new Error("Bundled runtime manifest changed while being read.");
      manifestCache.delete(absolute);
      if (manifestCache.size >= MANIFEST_CACHE_LIMIT) manifestCache.delete(manifestCache.keys().next().value);
      manifestCache.set(absolute, stored);
    }
  }
  const manifest = stored.manifest;
  if (expected?.managerId && manifest.managerId !== expected.managerId || expected?.version && manifest.version !== expected.version ||
      expected?.upstreamRevision && manifest.upstreamRevision !== expected.upstreamRevision || expected?.arch && manifest.arch !== expected.arch) {
    throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
  }
  return stored;
}

function relativeFile(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f]/.test(value) ||
      path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe bundled runtime file path.");
  return value;
}

function realDirectory(directory, { create = false, verifiedDirectories } = {}) {
  const absolute = path.resolve(directory);
  if (verifiedDirectories?.has(absolute)) return true;
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (verifiedDirectories?.has(current)) continue;
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    // macOS presents its system temporary directories through these aliases.
    if (process.platform === "darwin" && ["/tmp", "/var"].includes(current) && stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bundled runtime directories cannot use symlinks.");
    verifiedDirectories?.add(current);
  }
  return true;
}

function readRegular(file, maximum, { digestOnly = false, directories } = {}) {
  if (!realDirectory(path.dirname(file), { verifiedDirectories: directories })) throw new Error("Bundled runtime directory is missing.");
  const target = appAlias(file) || file;
  if (digestOnly) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Bundled runtime file is not regular or exceeds its limit.");
    return fileDigest(target, { maximum, noFollow: true });
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Bundled runtime file is not regular or exceeds its limit.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Bundled runtime changed while being read.");
      offset += count;
    }
    if (!hasFineChangeTime(stat)) {
      // Compare another pass through this bounded descriptor; a matching stat
      // alone can miss a same-sized write during the first read.
      const check = Buffer.alloc(Math.min(bytes.length, 64 * 1024));
      for (let offset = 0; offset < bytes.length;) {
        const count = fs.readSync(fd, check, 0, Math.min(check.length, bytes.length - offset), offset);
        if (!count || !check.subarray(0, count).equals(bytes.subarray(offset, offset + count)))
          throw new Error("Bundled runtime changed while being read.");
        offset += count;
      }
    }
    const after = fs.fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("Bundled runtime changed while being read.");
    return { bytes, size: bytes.length, sha256: digest(bytes), mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function validateManifest(manifest, { managerId, version, upstreamRevision, arch, checkSourceIdentity = true } = {}) {
  if (isManagedDeclaration(manifest)) {
    const files = manifest.files || [];
    if (!Array.isArray(files) || files.length > LIMITS.files) throw new Error("Runtime manifest exceeds its file limit.");
    for (const file of files) relativeFile(file.path);
    if (manifest.executableRelative !== undefined) relativeFile(manifest.executableRelative);
    for (const value of Object.values(manifest.environmentRelative || {})) relativeFile(value);
    for (const value of Object.values(manifest.runtimeFiles || {})) relativeFile(value);
    return manifest;
  }
  if (manifest?.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(manifest.managerId || "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.version || "") || checkSourceIdentity && !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") ||
      manifest.platform !== "darwin" || !["arm64", "x64", "universal"].includes(manifest.arch) ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(manifest.minimumMacOS || "") ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > LIMITS.files ||
      checkSourceIdentity && manifest.provenance?.sourceRevision !== manifest.upstreamRevision || !Array.isArray(manifest.dependencies)) throw new Error("Invalid bundled runtime manifest.");
  if (managerId && manifest.managerId !== managerId || version && manifest.version !== version ||
      checkSourceIdentity && upstreamRevision && manifest.upstreamRevision !== upstreamRevision || arch && manifest.arch !== arch) throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
  relativeFile(manifest.executableRelative);
  const names = new Set(), filesByPath = new Map(), directories = new Set();
  let total = 0;
  for (const file of manifest.files) {
    relativeFile(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (names.has(key) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes ||
        !SHA.test(file.sha256 || "") || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        file.format !== undefined && (!["mach-o", "pe"].includes(file.format) || !file.architectures) ||
        file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length || file.architectures.some(value => !(file.format === "pe" ? ["arm64", "x86_64", "x86"] : ["arm64", "x86_64"]).includes(value)))) throw new Error("Invalid bundled runtime file record.");
    names.add(key);
    filesByPath.set(file.path, file);
    for (let directory = path.posix.dirname(file.path); directory !== "."; directory = path.posix.dirname(directory)) directories.add(directory);
    total += file.size;
    if (total > LIMITS.bytes) throw new Error("Bundled runtime exceeds its size limit.");
  }
  const executable = filesByPath.get(manifest.executableRelative);
  const requiredArchitectures = manifest.arch === "universal" ? ["arm64", "x86_64"] : [manifest.arch === "x64" ? "x86_64" : "arm64"];
  if (!executable || !(executable.mode & 0o111) || !requiredArchitectures.every(architecture => executable.architectures?.includes(architecture))) throw new Error("Bundled runtime has no matching executable.");
  for (const dependency of manifest.dependencies) {
    if (!dependency || !filesByPath.has(relativeFile(dependency.file)) ||
        !Array.isArray(dependency.links) || dependency.links.some(link => typeof link !== "string" || !(
          link.startsWith("/usr/lib/") || link.startsWith("/System/Library/") || link.startsWith("@loader_path/")))) throw new Error("Bundled runtime dependency closure is invalid.");
    for (const link of dependency.links.filter(link => link.startsWith("@loader_path/"))) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(dependency.file), link.slice("@loader_path/".length)));
      relativeFile(resolved);
      if (!filesByPath.has(resolved)) throw new Error("Bundled runtime dependency is missing from its package.");
    }
  }
  for (const [key, value] of Object.entries(manifest.environmentRelative || {})) {
    if (!["PYTHONHOME", "PYTHONPATH"].includes(key) || !directories.has(relativeFile(value))) throw new Error("Bundled runtime environment directory is invalid.");
  }
  for (const [key, value] of Object.entries(manifest.runtimeFiles || {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,50}$/.test(key) || !filesByPath.has(relativeFile(value))) throw new Error("Bundled runtime asset file is invalid.");
  }
  return manifest;
}

// Runtime use records source bookkeeping; publication keeps validateManifest's
// exact source checks. Executable layout and payload integrity remain shared.
function validateRuntimeManifest(manifest, options = {}) {
  return validateManifest(manifest, {...options, checkSourceIdentity: false});
}

function fileInventory(root, { allowedAliases = new Set(), directories } = {}) {
  const files = [];
  function walk(relative, depth) {
    if (depth > 32) throw new Error("Bundled runtime directory nesting exceeds its limit.");
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relativeFile(path.posix.join(relative, entry.name));
      if (entry.isSymbolicLink()) {
        if (!allowedAliases.has(name) && !appAlias(path.join(root, name))) throw new Error("Bundled runtime packages cannot contain symlinks.");
        files.push(name);
      } else if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile()) files.push(name);
      else throw new Error("Bundled runtimes may contain only regular files and directories.");
      if (files.length > LIMITS.files) throw new Error("Bundled runtime has too many files.");
    }
  }
  if (!realDirectory(root, { verifiedDirectories: directories })) throw new Error("Bundled runtime payload is missing.");
  walk("", 0);
  return files.sort();
}

function localMachO(file){return Boolean(file?.architectures?.length && file.format!=='pe');}
function validateLocalAlias(root,name,target,declaration,resolveDependency){
 const stored=declaration.files.find(file=>file.path===target);
 if(!localMachO(stored)||path.posix.dirname(name)===path.posix.dirname(target))return;
 const info=require('./macho-load-commands').readMachOLoadCommands(path.join(root,target));
 const aliases=declaration.aliases?.files||{},files=new Set(declaration.files.map(file=>file.path));
 function canonical(file){
  const relative=path.relative(root,file).split(path.sep).join('/'),alias=aliases[relative];
  if(typeof alias==='string')return path.join(root,alias);
  if(alias&&typeof alias==='object')return resolveDependency(alias,declaration.dependencies.find(dep=>dep.project===alias.project)).path;
  if(files.has(relative))return path.join(root,relative);
  try{return fs.realpathSync(file);}catch{return path.resolve(file);}
 }
 for(const image of info.slices){
  const expand=(value,location)=>value.replace(/^@loader_path(?=\/|$)/,path.dirname(path.join(root,location))).replace(/^@executable_path(?=\/|$)/,image.fileType===2?path.dirname(path.join(root,location)):'@executable_path');
  const fingerprint=location=>{
   const paths=image.runPaths.map(value=>expand(value,location)).map(value=>path.isAbsolute(value)?canonical(value):value);
   const resolve=value=>{
    const expanded=expand(value,location);
    if(expanded.startsWith('@rpath/'))return paths.map(runPath=>path.isAbsolute(runPath)?canonical(path.join(runPath,expanded.slice(7))):runPath+'/'+expanded.slice(7));
    return path.isAbsolute(expanded)?canonical(expanded):expanded;
   };
   return JSON.stringify([paths,image.dependencies.map(item=>resolve(item.path)),image.installName?.path.startsWith('@loader_path')?resolve(image.installName.path):null,image.dynamicLinker?resolve(image.dynamicLinker):null,image.dyldEnvironment.map(value=>{const at=value.indexOf('=');return [value.slice(0,at+1),value.slice(at+1).split(':').map(resolve)];})]);
  };
  if(fingerprint(name)!==fingerprint(target))throw new Error('Cross-directory Mach-O alias changes load-command resolution: '+name+' -> '+target);
 }
}

function verifyPayload(root, manifest, resolveDependency) {
  const Contract = require("./package-contract.cjs");
  const managed = isManagedDeclaration(manifest);
  if (manifest.id && Contract.packageDependencies(manifest.dependencies,{managed}).length) {
    resolveDependency ||= dependencyContexts.get(manifest) || dependencyResolver(root,manifest);
    resolveDependency.verify?.();
  }
  const aliases = Contract.packageAliases(manifest.aliases,manifest.files || [],manifest.dependencies,{managed})?.files || {};
  const allowedAliases = new Set(), resolved = new Map();
  const dependencyFile = (target, dependency) => {
    const result = resolveDependency?.(target,dependency);
    if (!result || !path.isAbsolute(result.path || "") || !managed && (!SHA.test(result.sha256 || "") ||
        !Number.isSafeInteger(result.size) || result.size<0 || !Number.isInteger(result.mode)))
      throw new Error("A package dependency needs its exact installed sealed file.");
    // The resolver binds project/release/archive digest and only returns
    // canonical stored files from that dependency's verified declaration.
    if (!fs.lstatSync(result.path).isFile() && !appAlias(result.path)) throw new Error("A dependency target is not a canonical regular file.");
    return result;
  };
  for (const [name,target] of Object.entries(aliases)) {
    if (typeof target === "string") {
      const fact=(manifest.files || []).find(file=>file.path===target),canonical=path.join(root,target);
      if(managed?!isNativeFile(canonical):!localMachO(fact))continue;
      if (!managed) validateLocalAlias(root,name,target,manifest,resolveDependency);
      const file=path.join(root,name);
      if(managed&&fs.lstatSync(file).isFile())continue;
      if(!fs.lstatSync(file).isSymbolicLink()||!managed && (fs.readlinkSync(file)!==path.relative(path.dirname(file),canonical)||
         fs.realpathSync(file)!==fs.realpathSync(canonical))||!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep)&&(!managed||fs.realpathSync(file)!==fs.realpathSync(canonical)))
        throw new Error('A local Mach-O alias differs from its canonical stored file.');
      allowedAliases.add(name);resolved.set(name,{...fact,path:canonical});continue;
    }
    const dependency = manifest.dependencies.find(item=>item.project===target.project);
    const selected = dependencyFile(target,dependency), file = path.join(root,name);
    if(managed&&fs.lstatSync(file).isFile())continue;
    if (!fs.lstatSync(file).isSymbolicLink() || (managed ? !fs.realpathSync(file).startsWith(fs.realpathSync(selected.root || path.dirname(selected.path))+path.sep) :
        fs.readlinkSync(file)!==path.relative(path.dirname(file),selected.path) || fs.realpathSync(file)!==fs.realpathSync(selected.path)))
      throw new Error("A dependency alias differs from its exact installed dependency.");
    allowedAliases.add(name); resolved.set(name,selected);
  }
  const files = !manifest.aliases ? manifest.files || [] : Contract.logicalFiles(manifest,(target,dependency)=>dependencyFile(target,dependency));
  const expected = files.map(file=>file.path).sort();
  const directories = new Set();
  const actualFiles = fileInventory(root,{allowedAliases,directories});
  const present = new Set(actualFiles);
  if (!managed && JSON.stringify(actualFiles) !== JSON.stringify(expected)) throw new Error("Bundled runtime file inventory differs from its manifest.");
  for (const file of files.filter(file => !managed || present.has(file.path))) {
    const full = resolved.get(file.path)?.path || path.join(root,file.path);
    if (!managed) {
      const actual = readRegular(full,file.size, { digestOnly: true, directories });
      if (actual.size!==file.size || actual.sha256!==file.sha256 ||
          (actual.mode!==file.mode && !(fs.lstatSync(full).isSymbolicLink() && appAlias(full) &&
          (actual.mode & ~0o111)===(file.mode & ~0o111) && (actual.mode & file.mode & 0o111)===(file.mode & 0o111))))
        throw new Error(`Bundled runtime checksum or permissions changed: ${file.path}`);
    }
    if (!managed && file.architectures) {
      const architectures=file.format==="pe" ? [PE.readPeExports(full)?.architecture].filter(Boolean) : Native.readMachOArchitectures(full,{allowLibrary:true});
      if (JSON.stringify(architectures.sort())!==JSON.stringify([...file.architectures].sort())) throw new Error(`Bundled runtime ${file.format==="pe" ? "PE" : "Mach-O"} architecture changed: ${file.path}`);
    }
  }
  return true;
}
function verifyStoredPayload(root, declaration, { managed = false } = {}) {
  const Contract = require("./package-contract.cjs");
  Contract.packageDependencies(declaration.dependencies,{managed});
  Contract.packageAliases(declaration.aliases,declaration.files || [],declaration.dependencies,{managed});
  const stored = {...declaration,aliases:undefined,dependencies:undefined};
  return verifyPayload(root,managed ? managedDeclaration(stored) : stored);
}

function bundledManifestPath(install) {
  if (typeof install?.installDir !== "string" || !path.isAbsolute(install.installDir)) throw new Error("Invalid bundled runtime root.");
  return path.join(install.installDir, install.bundledExecution === "direct" ? "manifest.json" : "bundle-manifest.json");
}

function verifyInstalled({ installDir, record, pin, managerId, verification = "full" }) {
  try {
    if (!["full", "status"].includes(verification)) return false;
    const stored = readManifest(bundledManifestPath({ ...record, installDir }),
      { managerId, version: record.version, upstreamRevision: pin.upstreamRevision }, { cached: verification === "status" });
    if (!SHA.test(record.bundledManifestSha256 || "") || stored.sha256 !== record.bundledManifestSha256) return false;
    const manifest = stored.manifest;
    if (record.source !== "bundled" || record.version !== manifest.version ||
        record.bundledExecution === "direct" && (record.readOnly !== true || record.removable !== false) ||
        record.executableRelative !== `files/${manifest.executableRelative}` ||
        record.binarySha256 !== manifest.files.find(file => file.path === manifest.executableRelative).sha256) return false;
    const expectedEnvironment = Object.fromEntries(Object.entries(manifest.environmentRelative || {}).map(([key, value]) => [key, `files/${value}`]));
    if (JSON.stringify(record.environmentRelative || {}) !== JSON.stringify(expectedEnvironment)) return false;
    const expectedFiles = Object.fromEntries(Object.entries(manifest.runtimeFiles || {}).map(([key, value]) => [key, `files/${value}`]));
    if (JSON.stringify(record.runtimeFiles || {}) !== JSON.stringify(expectedFiles)) return false;
    if (verification === "full") return verifyPayload(path.join(installDir, "files"), manifest);
    // getState is a display operation. Verify the sealed record and primary
    // executable metadata here; launches and explicit refresh check the closure.
    const executable = manifest.files.find(file => file.path === manifest.executableRelative);
    const file = path.join(installDir, "files", executable.path);
    fileIdentity(file, { maximum: executable.size });
    const stat = fs.lstatSync(file);
    return stat.size === executable.size && (stat.mode & 0o777) === executable.mode;
  } catch { return false; }
}


function isNativeFile(file) {
    const fd=fs.openSync(file,'r'),bytes=Buffer.alloc(8);let count;
    try{count=fs.readSync(fd,bytes,0,8,0);}finally{fs.closeSync(fd);}
    if(count<8)return false;
    const magic=bytes.readUInt32BE(0);
    return [0xfeedface,0xcefaedfe,0xfeedfacf,0xcffaedfe,0xbebafeca,0xbfbafeca,0xcafebabf].includes(magic) ||
      magic===0xcafebabe&&bytes.readUInt32BE(4)<=32;
}
function nativeFiles(root, manifest) {
  if (!isManagedDeclaration(manifest)) return manifest.files.filter(file => file.architectures && file.format !== "pe");
  return fileInventory(root,{allowedAliases:new Set(Object.keys(manifest.aliases?.files || {}))})
    .filter(name=>!fs.lstatSync(path.join(root,name)).isSymbolicLink()&&isNativeFile(path.join(root,name))).map(name=>({path:name}));
}
async function verifySignatures(root, manifest, { signal, execute = run } = {}) {
  for (const file of nativeFiles(root,manifest)) {
    await execute("/usr/bin/codesign", ["--verify", "--strict", path.join(root, file.path)], { ...(signal ? { signal } : {}), timeout: 30000, maxBuffer: 1024 * 1024 });
  }
}

function verifySignaturesSync(root, manifest) {
  for (const file of nativeFiles(root,manifest)) {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", path.join(root, file.path)], { timeout: 30000, stdio: "pipe", maxBuffer: 1024 * 1024 });
  }
}

function systemVersionSync() {
  return require("./host-capabilities").getHostCapabilities().macOSVersion || "0";
}

function createBundledNativeRuntime({ managerId, resourceRoot, platform = process.platform, arch = process.arch, dependencies = {} } = {}) {
  if (!/^[a-z0-9-]+$/.test(managerId || "")) throw new Error("Bundled runtime needs a safe manager id.");
  const roots = resourceRoot ? [path.resolve(resourceRoot)] : [process.resourcesPath && path.join(process.resourcesPath, "native-runtimes"),
    path.resolve(__dirname, "../../../resources/native-runtimes")].filter(Boolean);
  const signatureCache = new Map();
  function resolve({ version, upstreamRevision, arch: selectedArch = arch, verification = "status" } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version || "") || !["arm64", "x64"].includes(selectedArch)) throw new Error("Choose a safe explicit bundled runtime version and architecture.");
    for (const root of roots) {
      // Versioned resources coexist; older app builds retain manager/arch.
      for (const directory of [path.join(root, managerId, version, selectedArch), path.join(root, managerId, selectedArch)]) {
        let stored;
        try { stored = readManifest(path.join(directory, "manifest.json"), undefined, { cached: verification === "status" }); }
        catch (error) { if (!fs.existsSync(directory)) continue; throw new Error(`Bundled ${managerId} manifest is missing or unreadable: ${error.message}`); }
        const manifest = stored.manifest;
        if (manifest.version !== version) {
          if (directory === path.join(root, managerId, version, selectedArch)) throw new Error("Bundled runtime directory contains a different version.");
          continue;
        }
        if (manifest.managerId !== managerId || upstreamRevision && manifest.upstreamRevision !== upstreamRevision || manifest.arch !== selectedArch) throw new Error("Bundled runtime version, source pin or architecture differs from the selected catalog entry.");
        return { directory, manifest, manifestSha256: stored.sha256, version, source: "bundled", minimumMacOS: manifest.minimumMacOS };
      }
    }
    return null;
  }
  // Opt-in callers use these sealed resources in place. No registration or
  // writable runtime directory is created; game state belongs to userData.
  function resolveRuntime({ version, upstreamRevision, arch: selectedArch = arch, verification = "full" } = {}) {
    if (platform !== "darwin") return null;
    if (!["full", "status"].includes(verification)) throw new Error("Choose status or full bundled runtime verification.");
    const bundle = resolve({ version, upstreamRevision, arch: selectedArch, verification });
    if (!bundle) return null;
    const manifest = bundle.manifest, payload = path.join(bundle.directory, "files");
    const hostVersion = (dependencies.systemVersionSync || systemVersionSync)();
    if (!versionAtLeast(hostVersion, manifest.minimumMacOS)) throw new Error(`${managerId} ${version} requires macOS ${manifest.minimumMacOS}; this Mac uses ${hostVersion}.`);
    const executable = manifest.files.find(file => file.path === manifest.executableRelative);
    const hardwareArch = dependencies.hostArch || require("./host-capabilities").getHostCapabilities().hardwareArch;
    const runtimePath = path.join(payload, executable.path), nativeArch = hardwareArch === "x64" ? "x86_64" : hardwareArch;
    const architectures = executable.architectures;
    const needsRosetta = require("./architecture").imageRequiresRosetta(architectures, { platform: "darwin", hardwareArch });
    if (!architectures.includes(nativeArch) && !needsRosetta) throw new Error(`Runtime does not support this Mac's ${nativeArch} CPU.`);
    if (verification === "full") {
      verifyPayload(payload, manifest);
      // Full verification repeats inventory and file checks. A successful
      // signature check can be reused only for those identical native files.
      const signatureKey = JSON.stringify([bundle.manifestSha256,
        manifest.files.filter(file => file.architectures).map(file => fileIdentity(path.join(payload, file.path)))]);
      if (signatureCache.get(payload) !== signatureKey) {
        (dependencies.verifySignaturesSync || verifySignaturesSync)(payload, manifest);
        if (signatureCache.size >= MANIFEST_CACHE_LIMIT) signatureCache.delete(signatureCache.keys().next().value);
        signatureCache.set(payload, signatureKey);
      }
      if (readRegular(path.join(bundle.directory, "manifest.json"), LIMITS.manifestBytes).sha256 !== bundle.manifestSha256)
        throw new Error("Bundled runtime manifest changed during verification.");
    } else {
      fileIdentity(runtimePath, { maximum: executable.size });
      const stat = fs.lstatSync(runtimePath);
      if (stat.size !== executable.size || (stat.mode & 0o777) !== executable.mode) throw new Error("Bundled runtime executable metadata changed.");
    }
    return Object.freeze({ version, runtimeVersion: version, upstreamRevision: manifest.upstreamRevision,
      runtimePath, executablePath: runtimePath, executableRelative: `files/${executable.path}`, installDir: bundle.directory,
      binarySha256: executable.sha256, sha256: executable.sha256, bundledManifestSha256: bundle.manifestSha256,
      source: "bundled", bundledExecution: "direct", readOnly: true, removable: false,
      architectures: Object.freeze([...architectures]), needsRosetta, minimumMacOS: manifest.minimumMacOS,
      provenanceVerified: manifest.provenance.verifiedBuild === true, buildProvenance: structuredClone(manifest.provenance),
      environmentRelative: Object.freeze(Object.fromEntries(Object.entries(manifest.environmentRelative || {}).map(([key, value]) => [key, `files/${value}`]))),
      runtimeFiles: Object.freeze(Object.fromEntries(Object.entries(manifest.runtimeFiles || {}).map(([key, value]) => [key, `files/${value}`]))) });
  }
  async function install({ manager, userDataDir, version, signal, onProgress, logger } = {}) {
    if (platform !== "darwin") throw new Error("Bundled native runtimes require macOS.");
    const pin = manager.core.catalog.find(entry => entry.version === version);
    if (!pin) throw new Error("Choose an explicit pinned runtime version.");
    const bundle = resolve({ version, upstreamRevision: pin.upstreamRevision, verification: "full" });
    if (!bundle) return null;
    signal?.throwIfAborted();
    const hostVersion = dependencies.systemVersion ? await dependencies.systemVersion() : systemVersionSync();
    if (!versionAtLeast(hostVersion, bundle.manifest.minimumMacOS)) throw new Error(`${managerId} ${version} requires macOS ${bundle.manifest.minimumMacOS}; this Mac uses ${hostVersion}.`);
    verifyPayload(path.join(bundle.directory, "files"), bundle.manifest);
    const destination = manager.core.getInstallDir({ userDataDir, version });
    const parent = path.dirname(destination);
    realDirectory(parent, { create: true });
    if (fs.existsSync(destination)) throw new Error(`Remove the incomplete ${managerId} ${version} installation before reinstalling.`);
    const staging = fs.mkdtempSync(path.join(parent, ".bundle-install-"));
    try {
      for (const [index, file] of bundle.manifest.files.entries()) {
        signal?.throwIfAborted();
        const source = path.join(bundle.directory, "files", file.path);
        const target = path.join(staging, "files", file.path);
        realDirectory(path.dirname(target), { create: true });
        const content = readRegular(source, file.size);
        if (content.sha256 !== file.sha256 || content.size !== file.size) throw new Error("Bundled runtime changed during installation.");
        fs.writeFileSync(target, content.bytes, { flag: "wx", mode: file.mode });
        fs.chmodSync(target, file.mode);
        onProgress?.({ phase: "copy", percent: Math.floor((index + 1) / bundle.manifest.files.length * 90) });
      }
      const serialized = readRegular(path.join(bundle.directory, "manifest.json"), LIMITS.manifestBytes);
      if (serialized.sha256 !== bundle.manifestSha256) throw new Error("Bundled runtime manifest changed during installation.");
      fs.writeFileSync(path.join(staging, "bundle-manifest.json"), serialized.bytes, { flag: "wx", mode: 0o600 });
      verifyPayload(path.join(staging, "files"), bundle.manifest);
      await (dependencies.verifySignatures || verifySignatures)(path.join(staging, "files"), bundle.manifest, { signal });
      const executable = bundle.manifest.files.find(file => file.path === bundle.manifest.executableRelative);
      fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify({ version, upstreamRevision: pin.upstreamRevision,
        executableRelative: `files/${bundle.manifest.executableRelative}`, binarySha256: executable.sha256,
        source: "bundled", bundledManifestSha256: bundle.manifestSha256,
        provenanceVerified: bundle.manifest.provenance.verifiedBuild === true,
        environmentRelative: Object.fromEntries(Object.entries(bundle.manifest.environmentRelative || {}).map(([key, value]) => [key, `files/${value}`])),
        runtimeFiles: Object.fromEntries(Object.entries(bundle.manifest.runtimeFiles || {}).map(([key, value]) => [key, `files/${value}`])),
        buildProvenance: bundle.manifest.provenance, minimumMacOS: bundle.manifest.minimumMacOS,
        installedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      // Recheck the owned parent before publishing the fully verified tree.
      realDirectory(parent);
      if (fs.existsSync(destination)) throw new Error("A runtime installation appeared during bundle copy. Retry after removing it.");
      fs.renameSync(staging, destination);
      const installed = manager.core.resolveInstalled({ userDataDir, version });
      if (!installed) { fs.rmSync(destination, { recursive: true, force: true }); throw new Error("Copied bundled runtime failed its installed integrity check."); }
      logger?.info?.(`[runtime] installed bundled ${managerId} ${version}`);
      onProgress?.({ phase: "ready", percent: 100 });
      return installed;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const isResourcePath = value => typeof value === "string" && roots.some(root => {
    const directory = path.join(root, managerId), file = path.resolve(value);
    return file === directory || file.startsWith(directory + path.sep) || directory.startsWith(file + path.sep);
  });
  return { resolve, resolveRuntime, install, isResourcePath, clearCache: directory => {
    clearManifestCache(directory);
    for (const root of signatureCache.keys()) if (!directory || root.startsWith(path.resolve(directory) + path.sep)) signatureCache.delete(root);
  }, verifyInstalled: options => {
    if (options.record?.bundledExecution === "direct") {
      try {
        const bundle = resolve({ version: options.record.version, upstreamRevision: options.pin.upstreamRevision, verification: options.verification });
        if (!bundle || path.resolve(options.installDir) !== bundle.directory) return false;
      } catch { return false; }
    }
    return verifyInstalled({ ...options, managerId });
  } };
}

function resolveInstalledEnvironment(install) {
  const result = {};
  for (const [key, value] of Object.entries(install?.environmentRelative || {})) {
    if (!["PYTHONHOME", "PYTHONPATH"].includes(key) || typeof install?.installDir !== "string" || !path.isAbsolute(install.installDir)) throw new Error("Invalid installed runtime environment.");
    const directory = path.join(install.installDir, relativeFile(value));
    if (!directory.startsWith(path.resolve(install.installDir) + path.sep) || !realDirectory(directory)) throw new Error("Installed runtime environment directory is missing or unsafe.");
    result[key] = directory;
  }
  if (install?.dependencyLibraryPaths?.length) {
    for (const directory of install.dependencyLibraryPaths) if (!path.isAbsolute(directory) || !realDirectory(directory))
      throw new Error("A resolved dependency library directory is missing or unsafe.");
    result.DYLD_FALLBACK_LIBRARY_PATH = [...new Set(install.dependencyLibraryPaths)].join(path.delimiter);
  }
  return result;
}

function resolveInstalledAsset(install, name) {
  const value = install?.runtimeFiles?.[name];
  if (value === undefined) return null;
  if (typeof install?.installDir !== "string" || !path.isAbsolute(install.installDir)) throw new Error("Invalid installed runtime asset root.");
  const file = path.join(install.installDir, relativeFile(value));
  if (!realDirectory(path.dirname(file))) throw new Error("Installed runtime asset is missing or unsafe.");
  if (fs.lstatSync(file).isSymbolicLink()) {
    if (appAlias(file)) return file;
    if (isManagedDeclaration(install.declaration)) {
      const real = fs.realpathSync(file), root = fs.realpathSync(install.root || install.installDir);
      if ((real === root || real.startsWith(root + path.sep) ||
          install.dependencyReadRoots?.some(directory => real.startsWith(fs.realpathSync(directory) + path.sep))) && fs.statSync(real).isFile()) return file;
      throw new Error("Installed runtime asset is outside its payload or dependency.");
    }
    const relative = install.root && path.relative(install.root,file).split(path.sep).join('/');
    const target = install.declaration?.aliases?.files?.[relative];
    const dependency = install.declaration?.dependencies?.find(item=>item.project===target?.project);
    const resolveDependency=install.resolveDependency || dependencyContexts.get(install.declaration) || (dependency?dependencyResolver(install.root,install.declaration):null);
    const selected = typeof target === 'object' && resolveDependency?.(target,dependency);
    if (!selected || !path.isAbsolute(selected.path || '') || fs.realpathSync(file)!==fs.realpathSync(selected.path) ||
        fs.readlinkSync(file)!==path.relative(path.dirname(file),selected.path) || readRegular(selected.path,selected.size).sha256!==selected.sha256)
      throw new Error("Installed runtime asset is outside its declared dependency.");
  } else if (!fs.lstatSync(file).isFile()) throw new Error("Installed runtime asset is missing or unsafe.");
  return file;
}

module.exports = { localMachO, isNativeFile, validateLocalAlias, managedDeclaration, isManagedDeclaration, rememberDependencies, appBundleRoot, withAppBundle, dependencyResolver, LIMITS, appAlias, digest, relativeFile, realDirectory, readRegular, fileIdentity, clearManifestCache, validateManifest, validateRuntimeManifest, verifyStoredPayload, verifyPayload, verifySignatures,
  fileInventory, verifyInstalled, bundledManifestPath, versionAtLeast, systemVersionSync, createBundledNativeRuntime, resolveInstalledEnvironment, resolveInstalledAsset };
