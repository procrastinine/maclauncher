const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { runToolCommand } = require("../shared/runtime/tool-command");
const Archive = require("./archive");
const { inspectArchive } = require("./inspect");
const MachO = require("./macho");
const VERSION = 3;
function identity(file) { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].map(String).join(":"); }
function hash(file) { const h = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), b = Buffer.alloc(1024 * 1024); try { let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) h.update(b.subarray(0, n)); return h.digest("hex"); } finally { fs.closeSync(fd); } }
function files(root, relative = "", result = []) {
  if (relative.split(path.sep).length > 64 || result.length > 65534) throw new Error("Application tree exceeds supported bounds.");
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name), file = path.join(root, name);
    if (entry.isDirectory()) files(root, name, result);
    else if (entry.isFile()) result.push(name);
    else if (entry.isSymbolicLink()) {
      const actual = fs.realpathSync(file);
      if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error("Application symbolic link escapes its bundle.");
      result.push(name);
    } else throw new Error("Application contains a special file.");
  }
  return result;
}
function dependencies(framework, entries) {
  if (!Array.isArray(entries) || entries.length > 16) throw new Error("PlayTools dependency inventory is invalid.");
  const directory=path.dirname(framework),names=new Set();
  return entries.map(entry=>{
    if (!entry || typeof entry.name!=="string" || !/^lib[A-Za-z0-9_.+-]+\.dylib$/.test(entry.name) ||
        names.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("PlayTools dependency inventory is invalid.");
    names.add(entry.name);const file=path.join(directory,entry.name);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 64*1024*1024 || hash(file)!==entry.sha256)
      throw new Error("PlayTools dependencies changed since installation. Reinstall the selected PlayCover version.");
    return {name:entry.name,sha256:entry.sha256,file};
  });
}
async function prepare({ source, root, framework, frameworkHash, frameworkDependencies = [] }, signal) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("PlayCover requires an Apple Silicon Mac.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  root = fs.realpathSync(root); source = fs.realpathSync(source); framework = fs.realpathSync(framework);
  const sourceIdentity = identity(source), toolsBinary = path.join(framework, "PlayTools"), toolsHash = hash(toolsBinary);
  if (!frameworkHash || toolsHash !== frameworkHash) throw new Error("PlayTools changed since installation. Reinstall the selected PlayCover version.");
  const linked=dependencies(framework,frameworkDependencies),dependencyIdentity=JSON.stringify(linked.map(({name,sha256})=>({name,sha256})));
  const cacheFile = path.join(root, "prepared.json"), prepared = path.join(root, "prepared");
  let previous; try { previous = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
  const relativePath = value => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(path.sep).includes("..");
  if (previous?.version === VERSION && previous.source === source && previous.sourceIdentity === sourceIdentity && previous.toolsHash === toolsHash && previous.dependencyIdentity === dependencyIdentity && relativePath(previous.app) && relativePath(previous.executable) && Array.isArray(previous.files) && previous.files.length > 0 && previous.files.length <= 65534) {
    try {
      const current = files(prepared);
      if (current.length === previous.files.length && previous.files.every(([name, value], index) => name === current[index] && relativePath(name) && identity(path.join(prepared, name)) === value)) return { executablePath: path.join(prepared, previous.executable), appRoot: path.join(prepared, previous.app), bundleId: previous.bundleId };
    } catch {}
  }
  const archive = Archive.open(source), temporary = fs.mkdtempSync(path.join(root, ".prepare-"));
  const run = (cmd, args) => runToolCommand(cmd, args, { signal, timeout: 60000, logPath: path.join(root, "preparation.log") });
  try {
    const info = inspectArchive(archive);
    if (info.encrypted) throw new Error("Encrypted IPAs cannot run through PlayCover. Import an unencrypted application.");
    const appName = path.basename(info.appPrefix.slice(0, -1)), app = path.join(temporary, appName);
    fs.mkdirSync(app); await archive.extract(app, { prefix: info.appPrefix, signal });
    const originalFiles = files(app), binaries = [];
    for (const relative of originalFiles) {
      signal?.throwIfAborted();
      const file = path.join(app, relative), fd = fs.openSync(file, "r"), magic = Buffer.alloc(4);
      try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (!MachO.isMachO(magic)) continue;
      if (fs.statSync(file).size > 512 * 1024 * 1024) throw new Error("IPA executable exceeds the 512 MiB preparation limit.");
      const bytes = MachO.convert(fs.readFileSync(file), { ...(relative === info.executable ? { inject: "@executable_path/Frameworks/PlayTools.framework/PlayTools" } : {}) });
      fs.writeFileSync(file, bytes); fs.chmodSync(file, 0o755); binaries.push(file);
    }
    // Remove obsolete signatures/provisioning only in the derived app. The
    // original package and its entitlements are never rewritten or inherited.
    for (const relative of originalFiles) {
      if (relative.split(path.sep).includes("_CodeSignature") || path.basename(relative) === "embedded.mobileprovision") fs.rmSync(path.join(app, relative), { force: true });
    }
    const destination = path.join(app, "Frameworks/PlayTools.framework");
    if (fs.existsSync(destination)) throw new Error("IPA already contains PlayTools; import the original unmodified package.");
    fs.cpSync(framework, destination, { recursive: true, verbatimSymlinks: true });
    for(const dependency of linked){
      const target=path.join(app,"Frameworks",dependency.name);
      if(fs.existsSync(target)){
        if(!fs.lstatSync(target).isFile()||hash(target)!==dependency.sha256)
          throw new Error("IPA library conflicts with PlayTools: "+dependency.name);
      }else fs.copyFileSync(dependency.file,target);
      binaries.push(target);
    }
    const plugins = path.join(framework, "PlugIns");
    if (fs.existsSync(plugins)) {
      for (const entry of fs.readdirSync(plugins, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".bundle")) continue;
        const target = path.join(app, "PlugIns", entry.name);
        if (fs.existsSync(target)) throw new Error("IPA plugin conflicts with PlayTools: " + entry.name);
        fs.cpSync(path.join(plugins, entry.name), target, { recursive: true, verbatimSymlinks: true });
      }
    }
    for (const entry of fs.readdirSync(framework, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
      const strings = path.join(framework, entry.name, "Playtools.strings");
      if (fs.existsSync(strings)) { fs.mkdirSync(path.join(app, entry.name), { recursive: true }); fs.copyFileSync(strings, path.join(app, entry.name, "Playtools.strings")); }
    }
    const plist = { ...info.info, MinimumOSVersion: "11.0" };
    fs.writeFileSync(path.join(app, "Info.plist"), JSON.stringify(plist));
    await run("/usr/bin/plutil", ["-convert", "xml1", path.join(app, "Info.plist")]);
    const entitlements = path.join(temporary, "entitlements.plist");
    // The module launches inside its explicit OS sandbox, with a private home.
    // Apple's app-sandbox entitlement would create a second container in the
    // real user's Library. Do not inherit the IPA's grants or provisioning.
    fs.writeFileSync(entitlements, JSON.stringify({}));
    await run("/usr/bin/plutil", ["-convert", "xml1", entitlements]);
    // Sign all nested code after platform conversion, then sign the owning app.
    // No hardened-runtime bypass, private TCC grant, signing identity or SIP
    // change is involved in this ad-hoc local preparation.
    for (const file of binaries.filter(f => f !== path.join(app, info.executable))) await run("/usr/bin/codesign", ["--force", "--sign", "-", file]);
    const nested = files(app).filter(f => /(?:^|\/)Info\.plist$/.test(f)).map(f => path.dirname(path.join(app, f)))
      .filter(f => /\.(?:framework|bundle|appex|app)$/.test(f) && f !== app).sort((a, b) => b.length - a.length);
    for (const bundle of nested) await run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements", entitlements, app]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    fs.rmSync(entitlements);
    if (identity(source) !== sourceIdentity) throw new Error("IPA changed while it was being prepared.");
    const old = path.join(root, ".previous"); fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(prepared)) fs.renameSync(prepared, old);
    try { fs.renameSync(temporary, prepared); } catch (error) { if (fs.existsSync(old)) fs.renameSync(old, prepared); throw error; }
    fs.rmSync(old, { recursive: true, force: true });
    const record = { version: VERSION, source, sourceIdentity, sourceSha256: hash(source), toolsHash, dependencyIdentity, app: appName, executable: path.join(appName, info.executable), bundleId: info.bundleId,
      files: files(prepared).map(name => [name, identity(path.join(prepared, name))]) };
    fs.writeFileSync(cacheFile + ".tmp", JSON.stringify(record)); fs.renameSync(cacheFile + ".tmp", cacheFile);
    return { executablePath: path.join(prepared, record.executable), appRoot: path.join(prepared, appName), bundleId: info.bundleId };
  } finally { archive.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function extract({ source, root }, signal) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const sourceIdentity = identity(source), current = path.join(root, "contents"), meta = path.join(root, "source.json");
  let previous; try { previous = JSON.parse(fs.readFileSync(meta, "utf8")); } catch {}
  if (previous?.source === source && previous.identity === sourceIdentity && fs.existsSync(current)) return { extractedRoot: current };
  const archive = Archive.open(source), target = fs.mkdtempSync(path.join(root, ".extract-")), old = path.join(root, ".previous");
  try {
    await archive.extract(target, { signal });
    if (identity(source) !== sourceIdentity) throw new Error("IPA changed during extraction.");
    fs.rmSync(old, { recursive: true, force: true }); if (fs.existsSync(current)) fs.renameSync(current, old);
    try { fs.renameSync(target, current); } catch (error) { if (fs.existsSync(old)) fs.renameSync(old, current); throw error; }
    fs.rmSync(old, { recursive: true, force: true });
    fs.writeFileSync(meta + ".tmp", JSON.stringify({ source, identity: sourceIdentity })); fs.renameSync(meta + ".tmp", meta);
    return { extractedRoot: current };
  }
  catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
  finally { archive.close(); }
}
module.exports = { prepare, extract, dependencies };
