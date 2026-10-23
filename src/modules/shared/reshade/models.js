const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Writable = require("../writable-input");
const Native = require("../runtime/bundled-native");
const Publication = require("./publication");
const { withRuntimeMutation, withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const run = promisify(execFile);
const CAPABILITIES = Object.freeze(["lsfgFp16Quality", "lsfgFp16Performance", "lsfgFp32Quality",
  "lsfgFp32Performance", "ls1Quality", "ls1Performance"]);
const MAX_BYTES = 256 * 1024 * 1024;
const versionId = hash => "sha256-" + hash;
const validVersion = value => typeof value === "string" && /^sha256-[a-f0-9]{64}$/.test(value);
function storeRoot(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Launcher data directory is unavailable.");
  return path.join(userDataDir, "runtimes", "lossless-models");
}
function checkInspection(value, size) {
  if (!value || value.schema !== 1 || value.size !== size || !Number.isSafeInteger(size) || size < 64 || size > MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(value.contentHash || "") || !/^[a-f0-9]{64}$/.test(value.resourceLayoutHash || "") ||
    !Number.isSafeInteger(value.resourceCount) || value.resourceCount < 1 || value.resourceCount > 65535 ||
    value.version !== null && (typeof value.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(value.version)))
    throw new Error("Lossless Scaling resource inspection returned invalid metadata.");
  const capabilities = {};
  for (const key of CAPABILITIES) {
    const capability = value.capabilities?.[key];
    if (!capability || typeof capability.compatible !== "boolean" || typeof capability.reason !== "string" || capability.reason.length > 2048)
      throw new Error("Lossless Scaling resource inspection returned invalid capabilities.");
    capabilities[key] = { compatible: capability.compatible, reason: capability.reason };
  }
  if (!Object.values(capabilities).some(item => item.compatible)) throw new Error("This DLL contains no compatible Lossless Scaling models.");
  return { schema: 1, version: value.version, size, contentHash: value.contentHash,
    resourceLayoutHash: value.resourceLayoutHash, resourceCount: value.resourceCount, capabilities };
}
async function hashFile(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, signal })) hash.update(bytes);
  return hash.digest("hex");
}
function inspectionAvailable(root = require("./index").runtimeRoot()) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8")).features?.losslessInspection === true; }
  catch { return false; }
}
async function inspectModel(file, { root = require("./index").runtimeRoot(), signal, execute = run } = {}) {
  if (!inspectionAvailable(root)) throw new Error("Lossless Scaling resource inspection is unavailable in this application build.");
  Native.verifyPayload(root, Publication.forRoot(root));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > MAX_BYTES)
    throw new Error("Choose a compatible Lossless Scaling DLL.");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(DYLD_|RESHADE_)/.test(name)) delete env[name];
  let result;
  try { result = await execute(path.join(root, "fx-compile"), ["--inspect-lossless", file],
    { env, signal, timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    if (signal?.aborted || error.name === "AbortError") throw error;
    throw new Error("The selected DLL does not contain readable Lossless Scaling resources.", { cause: error });
  }
  let value; try { value = JSON.parse(result.stdout); } catch { throw new Error("Lossless Scaling resource inspection returned invalid output."); }
  return checkInspection(value, stat.size);
}
function readInstall(directory, version) {
  try {
    if (!validVersion(version)) return null;
    const receiptPath = path.join(directory, "model.json"), file = path.join(directory, "Lossless.dll");
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
    const receiptStat = fs.lstatSync(receiptPath), stat = fs.lstatSync(file);
    if (!receiptStat.isFile() ||
      receiptStat.isSymbolicLink() || receiptStat.size > 64 * 1024 || !stat.isFile() || stat.isSymbolicLink()) return null;
    const record = JSON.parse(fs.readFileSync(receiptPath, "utf8")), inspection = checkInspection(record.inspection, stat.size);
    if (record.schema !== 1 || versionId(inspection.contentHash) !== version) return null;
    return { version, versionLabel: "Lossless Scaling " + (inspection.version ? `${inspection.version} · ${inspection.contentHash.slice(0, 8)}` : inspection.contentHash.slice(0, 12)),
      installDir: directory, modelPath: file, inspection, ready: true, imported: true };
  } catch { return null; }
}
function listCopies(userDataDir, management) {
  const root = storeRoot(userDataDir);
  try {
    Writable.assertOwnDirectory(userDataDir, root, { create: false });
    return fs.readdirSync(root).filter(validVersion).map(version => {
      const installDir = path.join(root, version), installed = readInstall(installDir, version);
      if (installed || !management) return installed;
      try {
        Writable.assertOwnDirectory(userDataDir, installDir, {create: false});
        const stat = fs.lstatSync(installDir);if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        return {version, versionLabel: `Lossless Scaling · ${version.slice(7, 15)}`, installDir,
          ready: false, imported: true, removable: true,
          error: "The imported models are incomplete or changed. Import the original DLL again, or remove this copy."};
      } catch { return null; }
    }).filter(Boolean)
      .sort((a, b) => b.versionLabel.localeCompare(a.versionLabel, undefined, { numeric: true }) || a.version.localeCompare(b.version));
  } catch { return []; }
}
function listInstalled(userDataDir) { return listCopies(userDataDir, false); }
function listManaged(userDataDir) { return listCopies(userDataDir, true); }
async function importModel({ userDataDir, runtimePath, signal, inspect = inspectModel } = {}) {
  if (!path.isAbsolute(runtimePath || "") || !/\.dll$/i.test(runtimePath)) throw new Error("Choose a Lossless Scaling DLL.");
  const original = fs.lstatSync(runtimePath);
  if (!original.isFile() || original.isSymbolicLink() || original.size < 64 || original.size > MAX_BYTES)
    throw new Error("Choose a compatible Lossless Scaling DLL.");
  signal?.throwIfAborted();
  const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
  const temporary = await fs.promises.mkdtemp(path.join(root, ".import-"));
  try {
    const copied = path.join(temporary, "Lossless.dll");
    await fs.promises.copyFile(runtimePath, copied, fs.constants.COPYFILE_FICLONE);
    await fs.promises.chmod(copied, 0o600);
    const inspection = checkInspection(await inspect(copied, { signal }), fs.statSync(copied).size);
    if (await hashFile(copied, signal) !== inspection.contentHash) throw new Error("Lossless Scaling resources changed during import.");
    const after = fs.lstatSync(runtimePath);
    if (after.ino !== original.ino || after.dev !== original.dev || after.size !== original.size ||
      after.mtimeMs !== original.mtimeMs || after.ctimeMs !== original.ctimeMs) throw new Error("The selected DLL changed during import. Try again.");
    const version = versionId(inspection.contentHash), destination = path.join(root, version);
    Writable.atomicWrite(path.join(temporary, "model.json"), JSON.stringify({ schema: 1, inspection }), { root: temporary });
    const identity = { managerId: "graphics-models", sectionId: "default", version, sourcePath: destination };
    const reused = await withRuntimeUse(identity, async () => {
      const previous = readInstall(destination, version);
      return previous && await hashFile(previous.modelPath, signal) === inspection.contentHash ? previous : null;
    }, { userDataDir });
    if (reused) return reused;
    return await withRuntimeMutation(identity, async () => {
      signal?.throwIfAborted();
      const previous = readInstall(destination, version);
      if (previous && await hashFile(previous.modelPath, signal) === inspection.contentHash) return previous;
      // A damaged copy can be replaced; the selected original is never modified.
      const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("The model installation is not a regular directory.");
        await fs.promises.rm(destination, { recursive: true });
      }
      await fs.promises.rename(temporary, destination);
      return readInstall(destination, version);
    }, { userDataDir });
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
async function resolveModel(userDataDir, version, capability, { signal } = {}) {
  if (!validVersion(version) || !CAPABILITIES.includes(capability)) throw new Error("Choose an installed compatible graphics model.");
  const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root, { create: false });
  const installed = readInstall(path.join(root, version), version);
  if (!installed?.inspection.capabilities[capability].compatible) throw new Error("The selected graphics model is unavailable or incompatible. Choose an installed model in the game's graphics options.");
  if (await hashFile(installed.modelPath, signal) !== installed.inspection.contentHash)
    throw new Error("The selected graphics model has changed. Import the original DLL again in Runtimes.");
  return installed;
}
function removeModel(userDataDir, version) {
  if (!validVersion(version)) throw new Error("Choose an installed graphics model.");
  const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root, { create: false });
  const directory = path.join(root, version);
  return withRuntimeMutation({ managerId: "graphics-models", sectionId: "default", version, sourcePath: directory }, () => {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The model installation is not a regular directory.");
    fs.rmSync(directory, { recursive: true }); return true;
  }, { userDataDir });
}
module.exports = { CAPABILITIES, MAX_BYTES, checkInspection, inspectionAvailable, inspectModel,
  listInstalled, listManaged, importModel, resolveModel, removeModel };
