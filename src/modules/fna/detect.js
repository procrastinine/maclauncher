const fs = require("node:fs");
const path = require("node:path");
const { inspectManagedAssembly } = require("./managed-assembly");
const DEPENDENCY_LIMITS = Object.freeze({ maxAssemblies: 32, maxDepth: 3, maxReadBytes: 32 * 1024 * 1024,
  maxEmbeddedResourceBytes: 8 * 1024 * 1024, maxNativeImportEvidence: 4096 });

function engineReference(reference) {
  if (reference.name === "FNA") return "fna";
  if (/^Microsoft\.Xna\.Framework(?:\.|$)/.test(reference.name)) return "xna";
  return null;
}
function gameRoots(context) {
  const root = context.rootDir;
  return context.isAppBundle
    ? [path.join(root, "Contents", "Resources"), path.join(root, "Contents", "MacOS")]
    : [root];
}
function inspectGameAssembly(assemblyPath, { detection, limits = {} } = {}) {
  const bounds = { ...DEPENDENCY_LIMITS };
  for (const key of Object.keys(bounds)) {
    if (limits[key] === undefined) continue;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === "maxDepth" ? 0 : 1) || limits[key] > bounds[key]) throw new Error("Invalid managed dependency inspection limit.");
    bounds[key] = limits[key];
  }
  const stats = new Map(), reads = new Map(), assemblies = new Map(), attempts = new Map(), handles = new Map();
  let bytesRead = 0;
  const limitError = message => Object.assign(new Error(message), { code: "DETECTION_LIMIT", managedDependencyLimit: true });
  const io = {
    stat(file) {
      if (!stats.has(file)) {
        try { stats.set(file, detection?.stat ? detection.stat(file) : fs.statSync(file)); }
        catch (error) { if (error.code === "DETECTION_LIMIT") throw error; stats.set(file, null); }
      }
      return stats.get(file);
    },
    readBytes(file, offset, length) {
      const key = `${file}\0${offset}\0${length}`;
      if (reads.has(key)) return reads.get(key);
      if (bytesRead + length > bounds.maxReadBytes) throw limitError("Managed dependency read byte limit exceeded.");
      let bytes;
      if (detection?.readBytes) bytes = detection.readBytes(file, offset, length);
      else {
        if (!handles.has(file)) handles.set(file, fs.openSync(file, "r"));
        bytes = Buffer.alloc(length);
        if (fs.readSync(handles.get(file), bytes, 0, length, offset) !== length) throw new Error("Truncated managed dependency.");
      }
      bytesRead += bytes?.length || 0;
      reads.set(key, bytes);
      return bytes;
    }
  };
  const keyFor = item => !item.resource ? `${item.file}\0file` :
    `${item.file}\0${item.resource.offset ?? item.resource.name}\0${item.resource.size ?? "unsupported"}`;
  function inspect(item) {
    const key = keyFor(item);
    if (assemblies.has(key)) return assemblies.get(key);
    if (attempts.has(key)) throw attempts.get(key);
    if (attempts.size >= bounds.maxAssemblies) throw limitError("Managed dependency assembly limit exceeded.");
    if (item.resource && item.resource.size > bounds.maxEmbeddedResourceBytes) throw limitError("Embedded assembly size limit exceeded.");
    // A range is a view of bytes in the real parent PE. Its path never becomes
    // a synthetic filesystem observation or an extracted dependency directory.
    attempts.set(key, null);
    try {
      const info = inspectManagedAssembly(item.file, { detection: io, includeEmbeddedResources: true,
        ...(item.resource ? { range: { offset: item.resource.offset, size: item.resource.size } } : {}) });
      assemblies.set(key, info);
      return info;
    } catch (error) { attempts.set(key, error); throw error; }
  }
  try {
  const root = path.dirname(assemblyPath);
  const game = inspect({ file: assemblyPath });
  if (!game.hasEntryPoint || !game.assemblyName) return null;
  const queue = [{ file: assemblyPath, assembly: game, depth: 0 }], visited = new Set();
  let engine = null, evidence = null, referencedVersion = null, engineItem = null;
  const unsupportedXnaServices = new Set();
  const windowsApis = new Set();
  const nativeLibraries = new Set(), nativeImportEvidence = [], nativeImportIdentities = new Set();
  const managedDependencies = [], issues = [];
  const issue = (item, reference, reason) => issues.push({ assemblyPath: item.file, resourceName: item.resource?.name || null,
    reference, reason });
  function locate(reference, item) {
    const file = path.join(root, reference.name + ".dll");
    if (io.stat(file)?.isFile()) return [{ file }];
    const name = reference.name.toLowerCase() + ".dll", unique = new Map();
    for (const resource of [...(item.assembly.embeddedResources || []), ...(game.embeddedResources || [])]) {
      const normalized = resource.name.replace(/\.(?:compressed|deflate|gz)$/i, "").toLowerCase();
      if (normalized !== name && !normalized.endsWith("." + name)) continue;
      const candidate = { file: item.assembly.embeddedResources?.includes(resource) ? item.file : assemblyPath, resource };
      unique.set(keyFor(candidate), candidate);
    }
    return [...unique.values()];
  }
  while (queue.length) {
    const item = queue.shift();
    const identity = keyFor(item);
    if (visited.has(identity)) continue;
    visited.add(identity);
    if (item.depth) managedDependencies.push({ assemblyPath: item.file, resourceName: item.resource?.name || null,
      assemblyName: item.assembly.assemblyName, version: item.assembly.assemblyVersion,
      ilOnly: item.assembly.ilOnly, requires32Bit: item.assembly.requires32Bit, prefer32Bit: item.assembly.prefer32Bit,
      nativeEntryPoint: item.assembly.nativeEntryPoint, hasNativeManagedCode: item.assembly.hasNativeManagedCode,
      peMachine: item.assembly.peMachine, peFormat: item.assembly.peFormat });
    for (const imported of item.assembly.nativeImports || []) {
      nativeLibraries.add(imported.library);
      const key = `${identity}\0${imported.library}\0${imported.name}`;
      if (nativeImportIdentities.has(key)) continue;
      nativeImportIdentities.add(key);
      if (nativeImportEvidence.length >= bounds.maxNativeImportEvidence) {
        if (!issues.some(value => value.reason === "Native import evidence limit exceeded.")) issue(item, imported.library, "Native import evidence limit exceeded.");
        continue;
      }
      nativeImportEvidence.push({ ...imported, assemblyPath: item.file, assemblyName: item.assembly.assemblyName,
        resourceName: item.resource?.name || null });
    }
    for (const type of item.assembly.typeReferences) {
      const match = /^Microsoft\.Xna\.Framework\.(Avatar|GamerServices|Net)(?:\.|$)/.exec(type.namespace);
      if (match) unsupportedXnaServices.add("Microsoft.Xna.Framework." + match[1]);
      if (/^System\.Windows\.Forms(?:\.|$)/.test(type.namespace)) windowsApis.add("Windows Forms");
      if (/^System\.Windows(?:\.Controls|\.Interop|\.Media|\.Threading)(?:\.|$)/.test(type.namespace)) windowsApis.add("WPF");
      if (type.namespace === "System.Windows" && /^(Application|Window|DependencyObject|DependencyProperty|FrameworkElement|UIElement)$/.test(type.name)) windowsApis.add("WPF");
      if (type.namespace === "System.Drawing" && /^(Bitmap|Image|Graphics|Font|Icon|Pen|Brush|SolidBrush)$/.test(type.name)) windowsApis.add("System.Drawing graphics");
    }
    for (const reference of item.assembly.references) {
      const detected = engineReference(reference);
      if (detected) {
        if (!engine) {
          engine = detected;
          engineItem = item;
          referencedVersion = reference.version;
          evidence = { assemblyPath: item.file, reference: reference.name,
            ...(item.resource ? { resourceName: item.resource.name } : {}) };
        }
        if (/^Microsoft\.Xna\.Framework\.(Avatar|GamerServices|Net)$/.test(reference.name)) unsupportedXnaServices.add(reference.name);
        continue;
      }
      if (/^(System(?:\.|$)|mscorlib$|netstandard$|Microsoft\.Win32)/.test(reference.name) ||
          !/^[A-Za-z0-9_.-]+$/.test(reference.name)) continue;
      const candidates = locate(reference, item);
      for (const candidate of candidates) {
        if (visited.has(keyFor(candidate))) continue;
        if (item.depth >= bounds.maxDepth) { issue(item, reference.name, "Managed dependency depth limit exceeded."); continue; }
        if (candidate.resource && candidate.resource.format !== "pe") {
          issue(item, reference.name, candidate.resource.reason || "Compressed or unsupported embedded assembly format."); continue;
        }
        try {
          const assembly = inspect(candidate);
          if (assembly.assemblyName?.toLowerCase() !== reference.name.toLowerCase()) throw new Error("Managed dependency assembly identity does not match its reference.");
          queue.push({ ...candidate, assembly, depth: item.depth + 1 });
        } catch (error) {
          if (error.code === "DETECTION_LIMIT" && !error.managedDependencyLimit) throw error;
          issue(item, reference.name, error.message);
        }
      }
    }
  }
  if (!engine) return null;
  let framework = null;
  if (engine === "fna") {
    try {
      const candidates = locate({ name: "FNA" }, engineItem);
      // Multiple embedded alternatives have no proven resolver preference.
      // Keep the declared version rather than guessing which one executes.
      if (candidates.length === 1 && (!candidates[0].resource || candidates[0].resource.format === "pe")) {
        const candidate = inspect(candidates[0]);
        if (candidate.assemblyName === "FNA") framework = { ...candidate, embedded: Boolean(candidates[0].resource) };
      }
    } catch (error) {
      if (error.code === "DETECTION_LIMIT" && !error.managedDependencyLimit) throw error;
      if (error.managedDependencyLimit) issue({ file: assemblyPath }, "FNA", error.message);
    }
  }
  return { assemblyPath, assemblyName: game.assemblyName, gameVersion: game.assemblyVersion,
    detectedVersion: framework?.assemblyVersion || referencedVersion,
    detectedVersionSource: framework ? framework.embedded ? "Embedded FNA assembly metadata" : "FNA assembly metadata" : "Reachable managed assembly reference",
    detectedVersionConfidence: "high", engineKind: engine,
    targetFramework: game.targetFramework, clrMetadataVersion: game.clrMetadataVersion,
    requires32Bit: game.requires32Bit, ilOnly: game.ilOnly, nativeEntryPoint: game.nativeEntryPoint, hasNativeManagedCode: game.hasNativeManagedCode,
    peMachine: game.peMachine, peFormat: game.peFormat, prefer32Bit: game.prefer32Bit, engineEvidence: evidence,
    unsupportedXnaServices: [...unsupportedXnaServices], windowsApis: [...windowsApis], nativeLibraries: [...nativeLibraries], nativeImportEvidence,
    managedDependencies, dependencyInspection: { complete: issues.length === 0, inspectedAssemblies: assemblies.size,
      inspectedSources: attempts.size, bytesRead, limits: bounds, issues },
    compatibility: !game.ilOnly || game.nativeEntryPoint ? "mixed-mode-unsupported"
      : windowsApis.size ? "requires-platform-adapter" : issues.length ? "dependency-inspection-incomplete"
      : managedDependencies.some(item => !item.ilOnly || item.nativeEntryPoint || item.hasNativeManagedCode) ? "dependency-native-code-unsupported"
      : game.requires32Bit || managedDependencies.some(item => item.requires32Bit) ? "requires-32-bit-host" : unsupportedXnaServices.size ? "unsupported-xna-services"
      : engine === "xna" ? "requires-xna-adapter" : "managed-fna" };
  } finally { for (const handle of handles.values()) fs.closeSync(handle); }
}
function detectGame(context) {
  if (!context?.rootDir) return null;
  const direct = context.inputPath && /\.(exe|dll)$/i.test(context.inputPath) ? context.inputPath : null;
  const roots = gameRoots(context);
  const candidates = [];
  if (direct) candidates.push(direct);
  for (const root of roots) {
    let files;
    try { files = context.detection?.readdir ? context.detection.readdir(root) : fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (error.code === "DETECTION_LIMIT") throw error; continue; }
    const stem = path.basename(context.rootDir).replace(/\.app$/i, "").replace(/\s+/g, "");
    const executableStems = new Set(files.filter(item => item.isFile() &&
      /\.exe$|\.runtimeconfig\.json$/i.test(item.name)).map(item => item.name.replace(/\.exe$|\.runtimeconfig\.json$/i, "")));
    const preferred = files.filter(item => item.isFile() && /\.(exe|dll)$/i.test(item.name))
      .sort((a, b) => Number(path.basename(b.name, path.extname(b.name)) === stem) -
        Number(path.basename(a.name, path.extname(a.name)) === stem) ||
        Number(executableStems.has(path.basename(b.name, path.extname(b.name)))) -
        Number(executableStems.has(path.basename(a.name, path.extname(a.name)))) ||
        Number(/\.exe$/i.test(b.name)) - Number(/\.exe$/i.test(a.name)) || a.name.localeCompare(b.name));
    candidates.push(...preferred.slice(0, 32).map(item => path.join(root, item.name)));
  }
  for (const file of [...new Set(candidates)].slice(0, 32)) {
    try {
      const inspect = () => inspectGameAssembly(file, { detection: context.detection });
      const info = context.detection?.memo ? context.detection.memo("fna-managed-embedded-steam-evidence-v2", file, inspect) : inspect();
      if (!info) continue;
      return { moduleId: "fna", engine: "fna", gameType: "scripted", name: info.assemblyName,
        gamePath: context.isAppBundle ? context.rootDir : file, contentRootDir: path.dirname(file),
        nativeAppPath: context.isAppBundle ? context.rootDir : null, runtimeId: "fna", moduleData: info };
    } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
  }
  return null;
}

module.exports = { detectGame, inspectGameAssembly, engineReference, DEPENDENCY_LIMITS };
