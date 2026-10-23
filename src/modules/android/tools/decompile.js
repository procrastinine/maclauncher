const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Tool = require("./jadx-manager");
const Packages = require("../package-set");
const { inspectApk } = require("../apk");
const Native = require("../../shared/runtime/local-native");
const { getUiServices } = require("../../shared/ui-services");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const pending = new Set(), RECORD = "maclauncher-jadx.json";
const identity = file => { const s = fs.lstatSync(file); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":"); };

async function originalPackages(input, temporary, signal) {
  const archive = Packages.ARCHIVES.test(input);
  const items = archive ? await Packages.unpack(input, temporary, signal)
    : Packages.directFiles(input)?.map(file => ({ file, originalName: path.basename(file) }));
  if (!items?.length) throw new Error("Select an APK, split APK folder, XAPK, APKM or APKS package.");
  let base;
  for (const item of items) {
    throwIfAborted(signal);
    item.metadata = inspectApk(item.file, { requireLauncher: false });
    if (!base || item.metadata.split === null) base = item;
  }
  for (const item of items) for (const key of ["packageName", "versionCode", "versionCodeMajor"])
    if (item.metadata[key] !== base.metadata[key]) throw new Error("The selected APKs have different package identities.");
  items.sort((a, b) => a.metadata.split === null ? -1 : b.metadata.split === null ? 1 : a.originalName.localeCompare(b.originalName));
  // Retain every architecture/resource split. Installer ABI and launcher checks
  // do not apply to source inspection, and no Android runtime is prepared.
  return { items, metadata: base.metadata, archive };
}
function usefulOutput(root) {
  let visited = 0;
  function walk(directory) {
    if (!fs.existsSync(directory)) return false;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 8192) return false;
      const file = path.join(directory, item.name);
      if (item.isFile() && fs.statSync(file).size > 0) return true;
      if (item.isDirectory() && walk(file)) return true;
    }
    return false;
  }
  return walk(path.join(root, "sources")) || walk(path.join(root, "resources"));
}
async function decompileApk(entry, payload = {}, context = {}, dependencies = {}) {
  const input = entry?.gamePath;
  if (!path.isAbsolute(input || "") || input.includes("\0") || !fs.existsSync(input)) throw new Error("Android package not found.");
  if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("Decompilation requires an imported application.");
  throwIfAborted(context.signal);
  let selected = payload.outputDir;
  if (selected === undefined) {
    const choice = await getUiServices(context).dialog.showOpenDialog({ title: "Choose decompiled APK folder",
      buttonLabel: "Choose", properties: ["openDirectory", "createDirectory"],
      message: "Create a new folder containing Java sources and decoded Android resources." });
    if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
    selected = choice.filePaths[0];
  }
  if (!path.isAbsolute(selected || "") || selected.includes("\0") || !fs.statSync(selected).isDirectory()) throw new Error("Choose an existing output folder.");
  const parent = fs.realpathSync(selected), key = context.userDataDir + ":" + entry.gameId;
  if (pending.has(key)) throw new Error("APK decompilation is already running for this application.");
  pending.add(key);
  let staging, inputs;
  try {
    throwIfAborted(context.signal);
    inputs = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-jadx-inputs-"));
    const inputIdentity = fs.statSync(input).isFile() ? identity(input) : null, inspected = await originalPackages(input, inputs, context.signal);
    const sources = inspected.items.map(item => ({ file: item.file, name: item.originalName, sha256: Native.hashFile(item.file), identity: identity(item.file) }));
    const stem = String(entry.name || inspected.metadata.packageName).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 64) || "Android";
    staging = fs.mkdtempSync(path.join(parent, "." + stem + "-jadx-"));
    const outputDir = path.join(parent, path.basename(staging).slice(1)), logPath = path.join(staging, "decompile.log");
    fs.writeFileSync(logPath, "JADX APK decompilation\n");
    let result, partial = false;
    try {
      result = await (dependencies.run || Tool.core.run)(context, payload, { cwd: inputs, logPath,
        javaArgs: ["-Djava.awt.headless=true"], env: { ...process.env,
          XDG_CONFIG_HOME: path.join(inputs, "config"), XDG_CACHE_HOME: path.join(inputs, "cache") },
        args: ["--config", "none", "--deobf-cfg-file-mode", "ignore", "--mappings-mode", "ignore",
          "--output-dir", staging, ...sources.map(item => item.file)] });
    } catch (error) {
      throwIfAborted(context.signal);
      if (error.code === "ABORT_ERR" || error.name === "AbortError" || error.exitCode !== 1 || !usefulOutput(staging)) throw error;
      partial = true; result = { toolVersion: error.toolVersion || null, archiveSha256: error.toolArchiveSha256 || null };
    }
    throwIfAborted(context.signal);
    if ((inputIdentity && identity(input) !== inputIdentity) || sources.some(item => identity(item.file) !== item.identity || Native.hashFile(item.file) !== item.sha256))
      throw new Error("The Android package changed during decompilation. Try again.");
    if (!usefulOutput(staging)) throw new Error("JADX produced no Java sources or decoded resources. See " + logPath + ".");
    const record = { schema: 1, tool: "jadx", gameId: entry.gameId, packageName: inspected.metadata.packageName,
      versionName: inspected.metadata.versionName, outputDir, ...result, status: partial ? "Partial output" : "Decompiled",
      partial, sourcePath: input, sources: sources.map(({ name, sha256 }) => ({ name, sha256 })), createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, RECORD), JSON.stringify(record, null, 2));
    if (fs.existsSync(outputDir)) throw new Error("The output folder already exists. Choose another folder.");
    fs.renameSync(staging, outputDir); staging = null;
    entry.moduleData = { ...entry.moduleData, jadxOutputDir: outputDir, jadxVersion: result.toolVersion };
    context.onEntryChange?.({ moduleData: entry.moduleData });
    return { outputDir, toolVersion: result.toolVersion, status: record.status,
      message: partial ? "Some code could not be reconstructed. Details are in decompile.log." : "Java sources and decoded resources are available in the output folder." };
  } catch (error) {
    if (staging && !context.signal?.aborted && error.code !== "ABORT_ERR" && error.name !== "AbortError") {
      const log = path.join(staging, "decompile.log");
      if (fs.existsSync(log)) {
        const saved = path.join(parent, path.basename(staging).slice(1) + "-failed.log");
        fs.copyFileSync(log, saved, fs.constants.COPYFILE_EXCL);
        error.message = error.message.replaceAll(log, saved);
        if (!error.message.includes(saved)) error.message += " Details: " + saved;
      }
    }
    throw error;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    if (inputs) fs.rmSync(inputs, { recursive: true, force: true });
    pending.delete(key);
  }
}
function revealDecompiled(entry, _payload, context) {
  const outputDir = entry.moduleData?.jadxOutputDir;
  let record;
  try { const file = path.join(outputDir, RECORD), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error();
    record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Decompile this APK first."); }
  if (record.schema !== 1 || record.tool !== "jadx" || record.gameId !== entry.gameId) throw new Error("The decompiled folder does not match this application.");
  getUiServices(context).shell.showItemInFolder(outputDir); return { outputDir };
}
module.exports = { decompileApk, revealDecompiled, originalPackages };
