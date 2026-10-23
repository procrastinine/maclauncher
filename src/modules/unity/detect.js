const fs = require("node:fs");
const path = require("node:path");
const { readPeVersion } = require("../shared/runtime/pe-version");
const { inspectManagedAssembly } = require("../shared/runtime/managed-assembly");

const VERSION = /^\d{1,4}\.\d{1,3}\.\d{1,4}[abfp]\d{1,4}(?:[a-z]\d+)?$/;
const ASSET_NAMES = ["data.unity3d", "globalgamemanagers", "mainData", "resources.assets", "level0"];
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };

function parseAssetVersion(bytes, fileSize) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) return null;
  const stringAt = start => {
    const end = bytes.indexOf(0, start);
    return end >= start && end - start <= 80 ? { text: bytes.toString("ascii", start, end), end: end + 1 } : null;
  };
  if (bytes.toString("ascii", 0, 8) === "UnityFS\0") {
    const formatVersion = bytes.readUInt32BE(8), format = stringAt(12), engine = format && stringAt(format.end);
    if (formatVersion < 6 || formatVersion > 8 || !engine || !VERSION.test(engine.text) || engine.end + 20 > bytes.length) return null;
    const size = Number(bytes.readBigUInt64BE(engine.end));
    if (!Number.isSafeInteger(size) || size !== fileSize) return null;
    return { version: engine.text, format: "UnityFS", formatVersion, versionOffset: format.end };
  }
  // SerializedFile headers are big endian; their metadata byte order is
  // declared separately. The exact engine string precedes object/type data.
  const formatVersion = bytes.readUInt32BE(8), metadataSize = bytes.readUInt32BE(0), size = bytes.readUInt32BE(4), dataOffset = bytes.readUInt32BE(12);
  if (formatVersion < 7 || formatVersion > 30 || bytes[16] > 1) return null;
  let versionOffset = 20;
  if (formatVersion >= 22) {
    if (bytes.length < 48 || Number(bytes.readBigUInt64BE(24)) !== fileSize || Number(bytes.readBigUInt64BE(32)) > fileSize) return null;
    versionOffset = 48;
  } else if (size !== fileSize || metadataSize > size || dataOffset > size || dataOffset < 20) return null;
  const engine = stringAt(versionOffset);
  return engine && VERSION.test(engine.text) ? { version: engine.text, format: "SerializedFile", formatVersion, versionOffset } : null;
}

function reader(context) {
  return {
    stat: file => { try { return context.detection?.stat ? context.detection.stat(file) : fs.statSync(file); } catch { return null; } },
    list: dir => { try { return context.detection?.readdir ? context.detection.readdir(dir) : fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } },
    read: (file, length) => {
      if (context.detection?.readBytes) return context.detection.readBytes(file, 0, length);
      let fd; try { const size = Math.min(fs.statSync(file).size, length), bytes = Buffer.alloc(size); fd = fs.openSync(file, "r"); return bytes.subarray(0, fs.readSync(fd, bytes, 0, size, 0)); }
      catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  };
}

function inspectData(dataRoot, context = {}) {
  const io = reader(context), rootInfo = io.stat(dataRoot);
  if (!rootInfo?.isDirectory()) return null;
  let version = null, versionSource = null;
  for (const name of ASSET_NAMES) {
    const file = path.join(dataRoot, name), info = io.stat(file);
    if (!info?.isFile()) continue;
    const parsed = parseAssetVersion(io.read(file, 256), info.size);
    if (parsed) { version = parsed; versionSource = file; break; }
  }
  if (!version) return null;
  const managedRoot = path.join(dataRoot, "Managed"), assemblyPath = path.join(managedRoot, "Assembly-CSharp.dll");
  const hasManaged = io.stat(path.join(managedRoot, "UnityEngine.CoreModule.dll"))?.isFile() || io.stat(path.join(managedRoot, "UnityEngine.dll"))?.isFile();
  const il2cpp = io.stat(path.join(dataRoot, "il2cpp_data", "Metadata", "global-metadata.dat"))?.isFile();
  if (!hasManaged && !il2cpp) return null;
  const nativeImports = new Set(), windowsApis = new Set(), managedAssemblies = [], nativeImportEvidence = [], managedInspectionIssues = [];
  if (hasManaged) {
    const queue = ["Assembly-CSharp.dll", "Assembly-CSharp-firstpass.dll"], visited = new Set();
    while (queue.length && visited.size < 16) {
      const name = queue.shift(); if (visited.has(name)) continue; visited.add(name);
      const file = path.join(managedRoot, name);
      if (!io.stat(file)?.isFile()) continue;
      try {
        const info = context.detection?.memo ? context.detection.memo("unity-managed", file, () => inspectManagedAssembly(file, { maxMetadataBytes: 2 * 1024 * 1024, detection: context.detection })) : inspectManagedAssembly(file, { maxMetadataBytes: 2 * 1024 * 1024 });
        managedAssemblies.push({ name, assemblyName: info.assemblyName, version: info.assemblyVersion, clrVersion: info.clrMetadataVersion });
        for (const imported of info.nativeImports || []) {
          nativeImports.add(imported.library);
          if (nativeImportEvidence.length < 4096) nativeImportEvidence.push({ ...imported, assemblyPath: file, assemblyName: info.assemblyName });
          else if (!managedInspectionIssues.some(item => item.reason === "Native import evidence limit exceeded.")) managedInspectionIssues.push({ assemblyPath: file, reason: "Native import evidence limit exceeded." });
        }
        for (const type of info.typeReferences) if (/^System\.Windows(?:\.Forms|\.Controls|\.Media|\.Interop)(?:\.|$)/.test(type.namespace)) windowsApis.add(type.namespace);
        for (const reference of info.references) if (!/^(?:System(?:\.|$)|mscorlib$|netstandard$|Mono(?:\.|$)|Unity(?:\.|Engine|Editor))/.test(reference.name) && /^[A-Za-z0-9_.-]+$/.test(reference.name)) queue.push(reference.name + ".dll");
      } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; managedInspectionIssues.push({ assemblyPath: file, reason: error.message }); }
    }
    if (queue.length) managedInspectionIssues.push({ reason: "Managed dependency inspection limit exceeded." });
  }
  const plugins = [];
  function collectPlugins(directory, depth = 0) {
    if (depth > 3 || plugins.length >= 64) return;
    for (const item of io.list(directory).slice(0, 128)) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) collectPlugins(file, depth + 1);
      else if (item.isFile() && /\.(?:dll|so|dylib|bundle)$/i.test(item.name)) plugins.push(path.relative(dataRoot, file));
    }
  }
  collectPlugins(path.join(dataRoot, "Plugins"));
  const appInfo = io.read(path.join(dataRoot, "app.info"), 4096)?.toString("utf8").replace(/\r/g, "").split("\n") || [];
  const backend = il2cpp ? "il2cpp" : "mono";
  const graphics = require("./graphics").inspectGraphics(dataRoot, { detection: context.detection });
  return { dataRoot, detectedVersion: version.version, detectedVersionSource: `${path.basename(versionSource)} ${version.format} header`, detectedVersionConfidence: "exact",
    unityFormat: version.format, serializedFormatVersion: version.formatVersion, versionSourcePath: versionSource,
    scriptingBackend: backend, assemblyPath: io.stat(assemblyPath)?.isFile() ? assemblyPath : null,
    companyName: appInfo[0]?.trim() || graphics.playerSettings?.companyName || null, productName: appInfo[1]?.trim() || graphics.playerSettings?.productName || null,
    managedAssemblies, nativeImports: [...nativeImports], nativeImportEvidence, managedDependencyInspection: { complete: managedInspectionIssues.length === 0, issues: managedInspectionIssues },
    windowsApis: [...windowsApis], nativePlugins: plugins, graphics,
    compatibility: backend === "il2cpp" ? "IL2CPP native port required" : graphics.status === "requires-shader-conversion" ? "Direct3D shader conversion required" : nativeImports.size || windowsApis.size || plugins.length ? "Native plugins need verification" : "Mono player pilot" };
}

function detectGame(context) {
  if (!context?.rootDir) return null;
  const io = reader(context), selected = context.inputPath || context.rootDir, roots = [];
  if (context.isAppBundle) roots.push({ dataRoot: path.join(context.rootDir, "Contents", "Resources", "Data"), gamePath: context.rootDir, nativeAppPath: context.rootDir });
  else if (context.stat?.isFile()) {
    const header = io.read(selected, 20), windows = /\.exe$/i.test(selected), linux = header?.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]));
    if (!windows && !linux) return null;
    const stem = path.basename(selected).replace(/\.(?:exe|x86_64|x86)$/i, "");
    roots.push({ dataRoot: path.join(path.dirname(selected), stem + "_Data"), gamePath: selected });
  } else {
    for (const item of io.list(context.rootDir).slice(0, 256)) {
      if (!item.isDirectory() || !/_Data$/i.test(item.name)) continue;
      const stem = item.name.slice(0, -5), candidates = io.list(context.rootDir).filter(file => file.isFile() && (file.name.toLowerCase() === (stem + ".exe").toLowerCase() || file.name === stem || file.name === stem + ".x86_64" || file.name === stem + ".x86"));
      if (candidates.length !== 1) continue;
      roots.push({ dataRoot: path.join(context.rootDir, item.name), gamePath: path.join(context.rootDir, candidates[0].name) });
    }
  }
  for (const root of roots) {
    try {
      if (!inside(fs.realpathSync(context.rootDir), fs.realpathSync(root.dataRoot))) continue;
      const info = inspectData(root.dataRoot, context); if (!info) continue;
      const peVersion = /\.exe$/i.test(root.gamePath) ? readPeVersion(path.join(path.dirname(root.gamePath), "UnityPlayer.dll"), { detection: context.detection }) || readPeVersion(root.gamePath, { detection: context.detection }) : null;
      return { moduleId: "unity", engine: "unity", gameType: "scripted", runtimeId: root.nativeAppPath ? "native" : "unity",
        name: (info.productName || path.basename(root.gamePath, path.extname(root.gamePath))).replace(/^\*+|\*+$/g, ""), gamePath: root.gamePath,
        contentRootDir: path.dirname(root.dataRoot), nativeAppPath: root.nativeAppPath || null, moduleData: { ...info, playerVersionResource: peVersion },
        detectionEvidence: [{ type: "unity-data-header", path: info.versionSourcePath }, { type: "unity-backend", backend: info.scriptingBackend, path: info.assemblyPath || path.join(root.dataRoot, "il2cpp_data", "Metadata", "global-metadata.dat") }] };
    } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
  }
  return null;
}

module.exports = { detectGame, inspectData, parseAssetVersion, VERSION };
