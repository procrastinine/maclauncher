const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const { hashFile } = require("../inspect");
const { readIgorVersion } = require("./official-tool-version");
const VERSION = /^\d{1,4}\.\d{1,5}\.\d{1,5}\.\d{1,6}$/;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function json(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 ** 2) throw new Error("Igor dependency metadata is missing or oversized.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function inspectIgorDirectory(folder, arch = process.arch) {
  const files = []; let bytes = 0;
  function walk(directory, depth = 0) {
    if (depth > 8 || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Igor dependency directory is unsafe.");
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Igor dependency tree contains a symlink.");
      if (stat.isDirectory()) walk(file, depth + 1);
      else {
        bytes += stat.size;
        if (!stat.isFile() || stat.size > 128 * 1024 ** 2 || bytes > 512 * 1024 ** 2 || files.length >= 3000) throw new Error("Igor dependency tree exceeds its file/size bounds.");
        files.push({ relative: path.relative(folder, file), bytes: stat.size, sha256: hashFile(file) });
      }
    }
  }
  walk(folder);
  const build = readIgorVersion(path.join(folder, "Igor.dll")), deps = json(path.join(folder, "Igor.deps.json")), config = json(path.join(folder, "Igor.runtimeconfig.json"));
  const target = deps.runtimeTarget?.name;
  if (typeof target !== "string" || !target.endsWith(`/osx-${arch}`) || !deps.targets?.[target] || !config.runtimeOptions?.includedFrameworks?.length) throw new Error("Igor dependencies are not a complete self-contained build for this Mac architecture.");
  const names = new Set(files.map(file => file.relative));
  for (const library of Object.values(deps.targets[target])) {
    for (const kind of ["runtime", "native", "resources"]) {
      for (const [asset, metadata] of Object.entries(library[kind] || {})) {
        if (asset.includes("\\") || path.posix.isAbsolute(asset) || asset.split("/").includes("..")) throw new Error("Igor dependency asset escapes its folder.");
        const basename = path.posix.basename(asset), relative = kind === "resources" && metadata.locale ? `${metadata.locale}/${basename}` : basename;
        if (!names.has(asset) && !names.has(relative)) throw new Error(`Igor dependency ${relative} is missing.`);
      }
    }
  }
  for (const file of files.filter(item => item.relative.endsWith(".dylib"))) {
    if (!Native.readMachOArchitectures(path.join(folder, file.relative), { allowLibrary: true }).includes(arch)) throw new Error("Igor contains a native dependency for another architecture.");
  }
  const toolPath = path.join(folder, "Igor");
  if (!Native.readMachOArchitectures(toolPath).includes(arch)) throw new Error("Igor native executable is for another Mac architecture.");
  return { ...build, architecture: arch, files, dependencyTreeSha256: digest(files), binarySha256: hashFile(toolPath), toolPath, folder };
}
function toolRoot(userDataDir) { return path.join(userDataDir, "runtimes", "gamemaker-official", "tools"); }
function localDirectory(userDataDir, version, arch) {
  if (!path.isAbsolute(userDataDir || "") || !VERSION.test(version || "") || !["arm64", "x64"].includes(arch)) throw new Error("Choose an exact native Igor build and absolute data directory.");
  return path.join(toolRoot(userDataDir), `vendor-${version}-${arch}`);
}
function getSelectedIgorVersion({ userDataDir } = {}) {
  try { const record = json(path.join(toolRoot(userDataDir), "selected.json")); return VERSION.test(record.version || "") ? record.version : null; } catch { return null; }
}
function selectIgorVersion(userDataDir, version) {
  const root = require("./official-installer").ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "tools"));
  const temporary = path.join(root, `.selection-${crypto.randomUUID()}.json`);
  try { fs.writeFileSync(temporary, JSON.stringify({ version }) + "\n", { flag: "wx" }); fs.renameSync(temporary, path.join(root, "selected.json")); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function getLocalIgorStatus({ userDataDir, toolVersion, arch = process.arch }) {
  let directory;
  try {
    directory = localDirectory(userDataDir, toolVersion, arch);
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Managed Igor directory is a symlink.");
    const record = json(path.join(directory, "tool.json")), current = inspectIgorDirectory(path.join(directory, "files"), arch);
    if (record.version !== toolVersion || record.architecture !== arch || current.version !== toolVersion || record.binarySha256 !== current.binarySha256 ||
      record.dependencyTreeSha256 !== current.dependencyTreeSha256 || JSON.stringify(record.files) !== JSON.stringify(current.files)) throw new Error("Managed Igor version or dependency bytes changed.");
    Native.resolveLocalRuntime({ runtimePath: current.toolPath, runtimeVersion: toolVersion, upstreamRevision: `vendor-igor:${toolVersion}`, expectedSha256: record.binarySha256, arch });
    return { ...record, ready: true, installed: true, status: "ready", toolPath: current.toolPath, installDir: directory };
  } catch (error) { return { version: toolVersion, architecture: arch, ready: false, installed: false,
    status: directory && fs.existsSync(directory) ? "damaged" : "missing", reason: error.message }; }
}
function listLocalIgors({ userDataDir, arch = process.arch } = {}) {
  if (!path.isAbsolute(userDataDir || "")) return [];
  const choices = new Map();
  for (const runtime of require("./official").manager.core.listInstalled(userDataDir)) {
    try {
      // Studio 1.4 installs a runner only. It has no Studio 2 tool directory.
      // An inventory row must never make the launcher state unreadable.
      if (typeof runtime.runtimeRoot !== "string" || !path.isAbsolute(runtime.runtimeRoot)) continue;
      const folder = path.join(runtime.runtimeRoot, "bin", "igor", "osx", arch);
      const inspected = inspectIgorDirectory(folder, arch);
      const installed = getLocalIgorStatus({ userDataDir, toolVersion: inspected.version, arch });
      choices.set(inspected.version, { ...inspected, originRuntimeVersion: runtime.version,
        source: "installed-vendor-runtime", sourceUrl: runtime.releaseSource || runtime.helpUrl,
        originPackageHashes: (runtime.packages || []).map(item => ({ filename: item.filename, sha256: item.sha256 })),
        installed: installed.ready, versionLabel: `Igor ${inspected.version} (${arch}, runtime)` });
    } catch { /* Incomplete, unsupported or architecture-mismatched tools are not offered. */ }
  }
  try {
    for (const name of fs.readdirSync(toolRoot(userDataDir)).slice(0, 256)) {
      const match = /^vendor-(\d+\.\d+\.\d+\.\d+)-(arm64|x64)$/.exec(name);
      if (!match || match[2] !== arch) continue;
      const installed = getLocalIgorStatus({ userDataDir, toolVersion: match[1], arch });
      if (installed.ready && !choices.has(match[1])) choices.set(match[1], { ...installed, folder: path.join(installed.installDir, "files"), installed: true,
        versionLabel: `Igor ${match[1]} (${arch}, imported)` });
    }
  } catch {}
  return [...choices.values()];
}
async function installLocalIgor({ userDataDir, toolVersion, arch = process.arch, runProcess, signal }) {
  const existing = getLocalIgorStatus({ userDataDir, toolVersion, arch });
  if (existing.ready) { selectIgorVersion(userDataDir, toolVersion); return existing; }
  const choice = listLocalIgors({ userDataDir, arch }).find(item => item.version === toolVersion && item.source === "installed-vendor-runtime");
  if (!choice) throw new Error("Select an available exact Igor build. This choice has no complete native installed-runtime source; install that runtime first or select the public bootstrap.");
  const root = require("./official-installer").ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "tools"));
  const destination = localDirectory(userDataDir, toolVersion, arch), staging = fs.mkdtempSync(path.join(root, ".local-igor-"));
  try {
    await runProcess("/usr/bin/ditto", [choice.folder, path.join(staging, "files")], { timeout: 60000, ...(signal ? { signal } : {}) });
    fs.chmodSync(path.join(staging, "files", "Igor"), 0o755);
    const current = inspectIgorDirectory(path.join(staging, "files"), arch);
    if (current.dependencyTreeSha256 !== choice.dependencyTreeSha256 || inspectIgorDirectory(choice.folder, arch).dependencyTreeSha256 !== choice.dependencyTreeSha256) throw new Error("Igor source or staged dependency files changed during import.");
    const { toolPath, folder, installed, versionLabel, ...record } = choice;
    fs.writeFileSync(path.join(staging, "tool.json"), JSON.stringify({ ...record, provenanceVerified: false, installedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
    if (signal?.aborted) throw signal.reason || new Error("Igor import cancelled.");
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error("Igor installation path is a symlink.");
      fs.rmSync(destination, { recursive: true, force: true, maxRetries: 3 });
    }
    fs.renameSync(staging, destination);
    const result = getLocalIgorStatus({ userDataDir, toolVersion, arch });
    if (!result.ready) throw new Error(result.reason);
    selectIgorVersion(userDataDir, toolVersion);
    return result;
  } finally { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 }); }
}
module.exports = { inspectIgorDirectory, listLocalIgors, getLocalIgorStatus, getSelectedIgorVersion, selectIgorVersion, installLocalIgor };
