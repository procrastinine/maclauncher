const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../writable-input");
const { withRuntimeMutation, withRuntimeUse } = require("../../../../core/coordinated-runtime-managers");

const ID = "graphics-neural-models", MAX_MANIFEST = 1024 * 1024, MAX_WEIGHTS = 8 * 1024 ** 3;
const architectures = new Set(["mlxdlss.neural-rendering-transformer.v1", "nrk.neural-rendering-transformer.v1"]);
const validVersion = value => /^sha256-[a-f0-9]{64}$/.test(value || "");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const versionFor = (manifestHash, weightsHash) => "sha256-" + digest(`MacLauncher .dlssmodel v1\0${manifestHash}\0${weightsHash}`);
function storeRoot(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Launcher data directory is unavailable.");
  return path.join(userDataDir, "runtimes", ID);
}
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximum)
    throw new Error("The neural model package must contain regular manifest and weights files.");
  return stat;
}
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const shapeSymbol = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
function dimension(value, symbolic) {
  return positiveInteger(value) || symbolic && (shapeSymbol(value) || value && typeof value === "object" &&
    !Array.isArray(value) && shapeSymbol(value.symbol) && positiveInteger(value.multiplier));
}
function tensors(values, symbolic) {
  if (!Array.isArray(values) || !values.length) return false;
  const names = new Set();
  return values.every(value => {
    if (!value || typeof value.name !== "string" || !value.name || /[\x00-\x1f\x7f]/.test(value.name) || names.has(value.name) ||
        !["float16", "float32"].includes(value.dataType) ||
        symbolic && !["nhwc", "nchw", "nthwc", "vector"].includes(value.layout) ||
        !Array.isArray(value.shape) || !value.shape.length || !value.shape.every(size => dimension(size, symbolic))) return false;
    names.add(value.name);
    return true;
  });
}
function manifest(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("The neural model manifest is invalid."); }
  const weights = value?.weights, filename = weights?.file;
  if (value?.schemaVersion !== 1 || typeof value.identifier !== "string" || !value.identifier ||
      value.identifier.length > 512 || /[\x00-\x1f\x7f]/.test(value.identifier) || !architectures.has(value.architecture) ||
      !tensors(value.inputs, true) || !tensors(value.outputs, true) || !tensors(weights?.tensors, false) ||
      value.state?.kind !== "stateless" || (value.state.cadence ?? "frameIndependent") !== "frameIndependent" ||
      (value.state.resetPolicy ?? "explicit") !== "explicit" ||
      value.state.tensors != null && (!Array.isArray(value.state.tensors) || value.state.tensors.length !== 0))
    throw new Error("Choose an MLX-DLSS neural rendering transformer model package.");
  if (typeof filename !== "string" || !filename || filename.length > 255 || filename === "manifest.json" ||
      [".", ".."].includes(filename) || path.basename(filename) !== filename || /[\\\x00-\x1f\x7f]/.test(filename) ||
      !/^[a-f0-9]{64}$/.test(weights.sha256 || ""))
    throw new Error("The neural model manifest has an invalid weights filename or checksum.");
  return value;
}
// Metadata-only inspection: status and path selection never read/hash weights.
// Full checksum and tensor-content validation occurs on import and native load.
function inspectPackage(runtimePath) {
  if (typeof runtimePath !== "string" || !path.isAbsolute(runtimePath) || /[\0\r\n]/.test(runtimePath) || !/\.dlssmodel$/i.test(runtimePath))
    throw new Error("Choose a local .dlssmodel package.");
  const directoryStat = fs.lstatSync(runtimePath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Choose a local .dlssmodel directory.");
  const canonical = fs.realpathSync(runtimePath), manifestPath = path.join(canonical, "manifest.json");
  const manifestStat = regular(manifestPath, MAX_MANIFEST), bytes = fs.readFileSync(manifestPath), value = manifest(bytes);
  const weightsPath = path.join(canonical, value.weights.file), weightsStat = regular(weightsPath, MAX_WEIGHTS);
  return { canonical, directoryStat, manifestPath, manifestStat, bytes, value, weightsPath, weightsStat };
}
async function hashFile(file, signal, onProgress) {
  const hash = crypto.createHash("sha256"); let completed = 0, reported = 0, reportedBytes = -1;
  for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, signal })) {
    hash.update(bytes); completed += bytes.length;
    const now = Date.now();if (onProgress && now - reported >= 100) { reported = now;reportedBytes = completed;onProgress(completed); }
  }
  if (onProgress && reportedBytes !== completed) onProgress(completed);
  return hash.digest("hex");
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function readInstall(userDataDir, selected) {
  try {
    if (!validVersion(selected)) return null;
    const root = storeRoot(userDataDir), installDir = path.join(root, selected), modelPath = path.join(installDir, "model.dlssmodel");
    Writable.assertOwnDirectory(userDataDir, modelPath, { create: false });
    const receiptFile = path.join(installDir, "model.json"); regular(receiptFile, 64 * 1024);
    const record = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    if (record.schema !== 1 || record.version !== selected || !/^[a-f0-9]{64}$/.test(record.manifestHash || "") ||
        !/^[a-f0-9]{64}$/.test(record.weightsHash || "") || versionFor(record.manifestHash, record.weightsHash) !== selected ||
        !Number.isSafeInteger(record.weightsBytes) || record.weightsBytes < 1 || record.weightsBytes > MAX_WEIGHTS) return null;
    const package_ = inspectPackage(modelPath);
    if (digest(package_.bytes) !== record.manifestHash || package_.value.weights.sha256 !== record.weightsHash ||
        package_.weightsStat.size !== record.weightsBytes) return null;
    return { version: selected, versionLabel: `${package_.value.identifier} · ${selected.slice(7, 15)}`,
      identifier: package_.value.identifier, architecture: package_.value.architecture,
      installDir, modelPath, weightsPath: package_.weightsPath, weightsBytes: record.weightsBytes,
      manifestHash: record.manifestHash, weightsHash: record.weightsHash, importedAt: record.importedAt,
      ready: true, imported: true, removable: true };
  } catch { return null; }
}
function listCopies(userDataDir, management) {
  try {
    const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root, { create: false });
    return fs.readdirSync(root).filter(validVersion).map(version => {
      const installed = readInstall(userDataDir, version);
      if (installed || !management) return installed;
      const installDir = path.join(root, version);
      try {
        Writable.assertOwnDirectory(userDataDir, installDir, {create: false});
        const stat = fs.lstatSync(installDir);if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        return {version, versionLabel: `Neural model · ${version.slice(7, 15)}`, installDir,
          ready: false, imported: true, removable: true,
          error: "The imported model is incomplete or changed. Import the original package again, or remove this copy."};
      } catch { return null; }
    }).filter(Boolean)
      .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)) || a.version.localeCompare(b.version));
  } catch { return []; }
}
function listInstalled(userDataDir) { return listCopies(userDataDir, false); }
function listManaged(userDataDir) { return listCopies(userDataDir, true); }
async function resolveModel(userDataDir, selected, { signal } = {}) {
  const installed = readInstall(userDataDir, selected);
  if (!installed || await hashFile(installed.weightsPath, signal) !== installed.weightsHash)
    throw new Error("The imported neural model changed. Import the original package again in Graphics → Neural models.");
  return installed;
}
function identityForPath(userDataDir, modelPath) {
  if (typeof modelPath !== "string" || !path.isAbsolute(modelPath)) return null;
  const selected = listInstalled(userDataDir).find(item => item.modelPath === modelPath);
  return selected ? { managerId: ID, sectionId: "default", version: selected.version, sourcePath: selected.installDir } : null;
}
async function importModel(context = {}) {
  const {userDataDir, runtimePath, signal} = context, Sources = require("./model-sources");
  signal?.throwIfAborted();
  const selected = Sources.inspect(runtimePath);
  const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
  const expanded = selected.kind === "archive" ? fs.mkdtempSync(path.join(root, ".source-")) : null;
  try {
    const source = await Sources.materialize(selected, expanded, context), imported = [];
    for (const model of source.packages) imported.push(await importPackage(context, model, source));
    return imported.length === 1 ? imported[0] : {...imported[0], importedModels: imported.map(row => row.version)};
  } finally { if (expanded) fs.rmSync(expanded, {recursive: true, force: true}); }
}
function preserveSource(directory, source, model, userDataDir) {
  if (source.kind === "package" && !source.notices.length) return;
  const receipt = path.join(directory, "source.json");
  if (fs.existsSync(receipt)) return;
  const notices = path.join(directory, "notices");Writable.assertOwnDirectory(userDataDir, notices);
  for (const [index, row] of source.notices.entries()) {
    regular(row.source, 1 << 20);
    const target = path.join(notices, index + "-" + row.name);
    fs.copyFileSync(row.source, target, fs.constants.COPYFILE_EXCL);fs.chmodSync(target, 0o444);
  }
  fs.writeFileSync(receipt, JSON.stringify({schema: 1, kind: source.kind, fileName: path.basename(source.file),
    packagePath: model.sourcePackage || path.relative(source.file, model.canonical).split(path.sep).join("/")}, null, 2) + "\n", {flag: "wx", mode: 0o444});
}
async function importPackage(context, source, origin) {
  const {userDataDir, signal, onProgress} = context, root = storeRoot(userDataDir);
  signal?.throwIfAborted();
  const temporary = fs.mkdtempSync(path.join(root, ".import-")), modelPath = path.join(temporary, "model.dlssmodel");
  fs.mkdirSync(modelPath); let backup, target, published = false;
  try {
    fs.writeFileSync(path.join(modelPath, "manifest.json"), source.bytes, { flag: "wx", mode: 0o444 });
    const weightsPath = path.join(modelPath, source.value.weights.file);
    await fs.promises.copyFile(source.weightsPath, weightsPath, fs.constants.COPYFILE_FICLONE);
    const weightsHash = await hashFile(weightsPath, signal, completed => onProgress?.({ phase: "import", completed,
      total: source.weightsStat.size, label: "Importing neural model…" }));
    if (weightsHash !== source.value.weights.sha256) throw new Error("The neural model weights do not match their manifest checksum.");
    if (!sameFile(source.manifestStat, fs.lstatSync(source.manifestPath)) || !sameFile(source.weightsStat, fs.lstatSync(source.weightsPath)) ||
        !sameFile(source.directoryStat, fs.lstatSync(source.canonical))) throw new Error("The selected neural model changed during import. Try again.");
    const manifestHash = digest(source.bytes), selected = versionFor(manifestHash, weightsHash);
    target = path.join(root, selected);
    const identity = { managerId: ID, sectionId: "default", version: selected, sourcePath: target };
    const reused = await withRuntimeUse(identity, async () => {
      const previous = readInstall(userDataDir, selected);
      // Adding source notices is a write and belongs to the publication lock.
      const completeSource = origin.kind === "package" && !origin.notices.length || previous && fs.existsSync(path.join(previous.installDir, "source.json"));
      return previous && completeSource && await hashFile(previous.weightsPath, signal) === weightsHash ? previous : null;
    }, { userDataDir });
    if (reused) return reused;
    return await withRuntimeMutation(identity, async () => {
      try {
        const previous = readInstall(userDataDir, selected);
        if (previous && await hashFile(previous.weightsPath, signal) === weightsHash) {
          preserveSource(previous.installDir, origin, source, userDataDir);return previous;
        }
        signal?.throwIfAborted();
        fs.chmodSync(weightsPath, 0o444);
        fs.writeFileSync(path.join(temporary, "model.json"), JSON.stringify({ schema: 1, version: selected, manifestHash,
          weightsHash, weightsBytes: source.weightsStat.size, importedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
        preserveSource(temporary, origin, source, userDataDir);
        const existing = fs.lstatSync(target, { throwIfNoEntry: false });
        if (existing) {
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("The model installation is not a regular directory.");
          backup = target + ".previous-" + crypto.randomUUID(); fs.renameSync(target, backup);
        }
        fs.renameSync(temporary, target);
        published = true;
        const result = readInstall(userDataDir, selected);
        if (!result) throw new Error("The imported neural model could not be verified.");
        if (backup) fs.rmSync(backup, { recursive: true, force: true });
        context.onRuntimeStateChange?.(); return result;
      } catch (error) {
        if (backup) { fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(backup, target); }
        else if (published) fs.rmSync(target, { recursive: true, force: true });
        throw error;
      }
    }, { userDataDir });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function removeModel({ userDataDir, version, installDir } = {}) {
  if (!validVersion(version)) throw new Error("Choose an imported neural model.");
  const target = path.join(storeRoot(userDataDir), version);
  if (installDir && path.resolve(installDir) !== target) throw new Error("The directory does not belong to this imported model.");
  Writable.assertOwnDirectory(userDataDir, target, { create: false });
  return withRuntimeMutation({ managerId: ID, sectionId: "default", version, sourcePath: target }, () => {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false }); if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The model installation is not a regular directory.");
    fs.rmSync(target, { recursive: true }); return true;
  }, { userDataDir });
}
module.exports = { ID, MAX_MANIFEST, MAX_WEIGHTS, validVersion, inspectManifest: manifest, inspectPackage, listInstalled, listManaged, importModel, resolveModel, removeModel, identityForPath };
