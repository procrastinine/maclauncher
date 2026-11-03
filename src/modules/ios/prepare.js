const fs = require("node:fs");
const { cloneOrCopySync } = require("../shared/copy-file");
const path = require("node:path");
const crypto = require("node:crypto");
const { runToolCommand } = require("../shared/runtime/tool-command");
const Host = require("../shared/runtime/host-capabilities");
const { hasFineChangeTime } = require("../shared/file-time");
const Archive = require("./archive");
const { inspectArchive } = require("./inspect");
const MachO = require("./macho");
const VERSION = 3;
function stamp(file) { const stat = fs.lstatSync(file, { bigint: true }); return { stat, key: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String).join(":"), fine: hasFineChangeTime(stat) }; }
function identity(file) { return stamp(file).key; }
const changed = () => new Error("IPA input changed during preparation or extraction.");
function readHash(file, signal) {
  const before = stamp(file), h = crypto.createHash("sha256"), b = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.stat.dev || opened.ino !== before.stat.ino) throw changed();
    let n;
    do { signal?.throwIfAborted(); n = fs.readSync(fd, b, 0, b.length, null); if (n) h.update(b.subarray(0, n)); } while (n);
  } finally { fs.closeSync(fd); }
  if (identity(file) !== before.key) throw changed();
  return { sha256: h.digest("hex"), fine: before.fine };
}
function hash(file, signal) {
  const first = readHash(file, signal);
  // A second byte read establishes stability when ctime cannot distinguish writes.
  if (!first.fine && readHash(file, signal).sha256 !== first.sha256) throw changed();
  return first.sha256;
}
function entryHash(file, signal) {
  const before = stamp(file);
  if (!before.stat.isSymbolicLink()) return hash(file, signal);
  const target = fs.readlinkSync(file); signal?.throwIfAborted();
  if (identity(file) !== before.key || fs.readlinkSync(file) !== target) throw changed();
  return crypto.createHash("sha256").update("link\0" + target).digest("hex");
}
function inventory(root, signal, content = false) {
  return files(root).map(name => {
    signal?.throwIfAborted(); const file = path.join(root, name), info = stamp(file);
    return [name, info.key, content || !info.fine ? entryHash(file, signal) : null];
  });
}
const relativePath = value => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(path.sep).includes("..");
function unchanged(root, record, signal) {
  if (!Array.isArray(record) || record.length > 65534) return false;
  const current = files(root);
  return current.length === record.length && record.every(([name, key, digest], index) => {
    if (current[index] !== name || !relativePath(name)) return false;
    const file = path.join(root, name), info = stamp(file);
    return info.key === key && (info.fine && !digest || typeof digest === "string" && entryHash(file, signal) === digest);
  });
}
function sourceUnchanged(source, expected, digest, signal) {
  if (identity(source) !== expected.key || !expected.fine && hash(source, signal) !== digest) throw changed();
}
function openSnapshot(source, root, expected, digest, signal) {
  const temporary = fs.mkdtempSync(path.join(root, ".input-")), file = path.join(temporary, "source.ipa"); let archive;
  try {
    signal?.throwIfAborted(); cloneOrCopySync(source, file);
    if (hash(file, signal) !== digest) throw changed();
    sourceUnchanged(source, expected, digest, signal);
    archive = Archive.open(file);
    return { archive, validate() { sourceUnchanged(source, expected, digest, signal); if (hash(file, signal) !== digest) throw changed(); },
      close() { try { archive.close(); } finally { fs.rmSync(temporary, { recursive: true, force: true }); } } };
  } catch (error) { try { archive?.close(); } finally { fs.rmSync(temporary, { recursive: true, force: true }); } throw error; }
}
function preserve(root, name, directory) {
  const retained = path.join(root, "preserved"); fs.mkdirSync(retained, { recursive: true });
  fs.renameSync(directory, path.join(retained, name + "-" + crypto.randomUUID()));
}
function publish(root, name, temporary, meta, record, previous, signal) {
  const current = path.join(root, name), aside = path.join(root, ".replaced-" + crypto.randomUUID()), pending = meta + ".tmp";
  let moved = false, installed = false;
  try {
    fs.writeFileSync(pending, JSON.stringify(record));
    signal?.throwIfAborted();
    if (fs.existsSync(current)) { fs.renameSync(current, aside); moved = true; }
    fs.renameSync(temporary, current); installed = true;
    if (!unchanged(current, record.files, signal)) throw changed();
    fs.renameSync(pending, meta);
  } catch (error) {
    if (installed) fs.renameSync(current, temporary);
    if (moved) fs.renameSync(aside, current);
    fs.rmSync(pending, { force: true }); throw error;
  }
  // A private write or an old receipt without byte evidence is user data.
  // Keep it; clean derived files alone may be discarded after publication.
  if (moved) {
    let clean = false; try { clean = unchanged(aside, previous?.files, signal); } catch {}
    try { if (clean) fs.rmSync(aside, { recursive: true, force: true }); else preserve(root, name, aside); } catch {}
  }
}
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
function verifiedInput(file, expected, previous, signal) {
  const info = stamp(file);
  // Precise identity pins a previous byte check; ambiguous times still read bytes.
  const sha256 = info.fine && previous?.identity === info.key && previous.sha256 === expected ? expected : hash(file, signal);
  return { identity: info.key, sha256 };
}
function dependencies(framework, entries, { previous, identities, signal } = {}) {
  if (!Array.isArray(entries) || entries.length > 16) throw new Error("PlayTools dependency inventory is invalid.");
  const directory=path.dirname(framework),names=new Set();
  return entries.map(entry=>{
    if (!entry || typeof entry.name!=="string" || !/^lib[A-Za-z0-9_.+-]+\.dylib$/.test(entry.name) ||
        names.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("PlayTools dependency inventory is invalid.");
    names.add(entry.name);const file=path.join(directory,entry.name);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 64*1024*1024)
      throw new Error("PlayTools dependencies changed since installation. Reinstall the selected PlayCover version.");
    const verified = verifiedInput(file, entry.sha256, previous?.[entry.name], signal);
    if (verified.sha256 !== entry.sha256) throw new Error("PlayTools dependencies changed since installation. Reinstall the selected PlayCover version.");
    if (identities) identities[entry.name] = verified;
    return {name:entry.name,sha256:entry.sha256,file};
  });
}
async function prepare({ source, root, framework, frameworkHash, frameworkDependencies = [] }, signal) {
  const host = Host.getHostCapabilities();
  if (host.platform !== "darwin" || host.hardwareArch !== "arm64") throw new Error("PlayCover requires an Apple Silicon Mac.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  root = fs.realpathSync(root); source = fs.realpathSync(source); framework = fs.realpathSync(framework);
  const cacheFile = path.join(root, "prepared.json"), prepared = path.join(root, "prepared");
  let previous; try { previous = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
  const sourceStamp = stamp(source), sourceIdentity = sourceStamp.key, toolsBinary = path.join(framework, "PlayTools");
  const tools = verifiedInput(toolsBinary, frameworkHash, previous?.tools, signal), toolsHash = tools.sha256;
  if (!frameworkHash || toolsHash !== frameworkHash) throw new Error("PlayTools changed since installation. Reinstall the selected PlayCover version.");
  const dependencyFiles = Object.create(null);
  const linked = dependencies(framework, frameworkDependencies, { previous: previous?.dependencyFiles, identities: dependencyFiles, signal });
  const dependencyIdentity = JSON.stringify(linked.map(({name,sha256})=>({name,sha256})));
  let sourceSha256 = sourceStamp.fine ? null : hash(source, signal);
  if (previous?.version === VERSION && previous.source === source && previous.sourceIdentity === sourceIdentity &&
      (sourceStamp.fine || previous.sourceSha256 === sourceSha256) && previous.toolsHash === toolsHash && previous.dependencyIdentity === dependencyIdentity && relativePath(previous.app) && relativePath(previous.executable)) {
    try {
      if (unchanged(prepared, previous.files, signal)) {
        // Refresh cached verified identities when inputs move; keep the prepared app.
        if (JSON.stringify(previous.tools) !== JSON.stringify(tools) || JSON.stringify(previous.dependencyFiles) !== JSON.stringify(dependencyFiles)) {
          try { fs.writeFileSync(cacheFile + ".tmp", JSON.stringify({ ...previous, tools, dependencyFiles })); fs.renameSync(cacheFile + ".tmp", cacheFile); }
          catch { try { fs.rmSync(cacheFile + ".tmp", { force: true }); } catch {} }
        }
        return { executablePath: path.join(prepared, previous.executable), appRoot: path.join(prepared, previous.app), bundleId: previous.bundleId };
      }
    } catch {}
  }
  sourceSha256 ||= hash(source, signal);
  const snapshot = openSnapshot(source, root, sourceStamp, sourceSha256, signal), archive = snapshot.archive;
  let temporary;
  const run = (cmd, args) => runToolCommand(cmd, args, { signal, timeout: 60000, logPath: path.join(root, "preparation.log") });
  try {
    temporary = fs.mkdtempSync(path.join(root, ".prepare-"));
    const frameworkFiles = inventory(framework, signal, true);
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
    cloneOrCopySync(framework, destination);
    if (hash(path.join(destination, "PlayTools"), signal) !== toolsHash) throw changed();
    for(const dependency of linked){
      const target=path.join(app,"Frameworks",dependency.name);
      if(fs.existsSync(target)){
        if(!fs.lstatSync(target).isFile()||hash(target)!==dependency.sha256)
          throw new Error("IPA library conflicts with PlayTools: "+dependency.name);
      }else cloneOrCopySync(dependency.file,target);
      if (hash(target, signal) !== dependency.sha256) throw changed();
      binaries.push(target);
    }
    const plugins = path.join(framework, "PlugIns");
    if (fs.existsSync(plugins)) {
      for (const entry of fs.readdirSync(plugins, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".bundle")) continue;
        const target = path.join(app, "PlugIns", entry.name);
        if (fs.existsSync(target)) throw new Error("IPA plugin conflicts with PlayTools: " + entry.name);
        cloneOrCopySync(path.join(plugins, entry.name), target);
      }
    }
    for (const entry of fs.readdirSync(framework, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
      const strings = path.join(framework, entry.name, "Playtools.strings");
      if (fs.existsSync(strings)) { fs.mkdirSync(path.join(app, entry.name), { recursive: true }); cloneOrCopySync(strings, path.join(app, entry.name, "Playtools.strings")); }
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
    if (!unchanged(framework, frameworkFiles, signal)) throw changed();
    const record = { version: VERSION, source, sourceIdentity, sourceSha256, toolsHash, tools, dependencyFiles, dependencyIdentity, app: appName, executable: path.join(appName, info.executable), bundleId: info.bundleId,
      files: inventory(temporary, signal) };
    snapshot.validate();
    publish(root, "prepared", temporary, cacheFile, record, previous, signal);
    return { executablePath: path.join(prepared, record.executable), appRoot: path.join(prepared, appName), bundleId: info.bundleId };
  } finally { try { snapshot.close(); } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); } }
}
async function extract({ source, root }, signal) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  source = fs.realpathSync(source);
  const sourceStamp = stamp(source), sourceIdentity = sourceStamp.key, current = path.join(root, "contents"), meta = path.join(root, "source.json");
  let previous; try { previous = JSON.parse(fs.readFileSync(meta, "utf8")); } catch {}
  let sourceSha256 = sourceStamp.fine ? null : hash(source, signal);
  if (previous?.source === source && previous.identity === sourceIdentity && (sourceStamp.fine || previous.sourceSha256 === sourceSha256) && fs.existsSync(current)) return { extractedRoot: current };
  sourceSha256 ||= hash(source, signal);
  const snapshot = openSnapshot(source, root, sourceStamp, sourceSha256, signal); let target;
  try {
    target = fs.mkdtempSync(path.join(root, ".extract-"));
    await snapshot.archive.extract(target, { signal });
    const record = { source, identity: sourceIdentity, sourceSha256, files: inventory(target, signal) };
    snapshot.validate();
    publish(root, "contents", target, meta, record, previous, signal);
    return { extractedRoot: current };
  }
  catch (error) { if (target) fs.rmSync(target, { recursive: true, force: true }); throw error; }
  finally { snapshot.close(); }
}
module.exports = { prepare, extract, dependencies };
