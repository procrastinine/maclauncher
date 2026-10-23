const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Models = require("./models"), Catalog = require("./model-source.json");
const Downloads = require("../../runtime/download-utils"), Writable = require("../../writable-input");
const { runDownloadTask } = require("../../runtime/download-manager");
const { withRuntimeMutation } = require("../../../../core/coordinated-runtime-managers");

function sourceFor(version = Catalog.defaultVersion) {
  const source = Catalog.sources.find(row => row.version === version);
  if (!source) throw new Error("Choose an available neural model download.");
  return source;
}
async function checksum(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, signal })) hash.update(bytes);
  return hash.digest("hex");
}
async function existingSource(context, source) {
  const installed = Models.listInstalled(context.userDataDir).find(row => row.weightsHash === source.weightsHash && row.manifestHash === source.manifestHash);
  if (!installed) return null;
  try { return await Models.resolveModel(context.userDataDir, installed.version, { signal: context.signal }); }
  catch (error) {
    Downloads.throwIfAborted(context.signal);if (Downloads.isAbortError(error)) throw error;
    return null;
  }
}
async function downloadDlssMac(context = {}, dependencies = {}) {
  const source = dependencies.source || sourceFor(context.sourceVersion);
  Downloads.throwIfAborted(context.signal);
  const existing = await existingSource(context, source);
  if (existing) return existing;
  if (typeof context.confirmRuntimeInstall === "function") {
    const approved = await context.confirmRuntimeInstall({ managerId: Models.ID, version: source.version,
      label: "Neural rendering model", requiresDownload: true, kind: "tool", confirmLabel: "Download and Continue",
      downloadBytes: source.bytes, sourceUrl: source.releaseUrl,
      detail: source.description + " " + source.weightTerms });
    if (approved !== true && approved?.approved !== true) return null;
  }
  // Invoking this setup action is explicit authorization when no UI adapter is supplied.
  Downloads.throwIfAborted(context.signal);
  return runDownloadTask(context.downloads, { managerId: Models.ID, sectionId: "default", version: source.version,
    label: "Neural rendering model", detail: "Downloading model…", kind: "download",
    dedupeKey: `neural-model:${context.userDataDir}:${source.version}` }, async task => {
    const callerSignal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal || undefined;
    const operation = { ...context, signal: callerSignal, onProgress: task.onProgress };
    Downloads.throwIfAborted(callerSignal);
    return withRuntimeMutation({ managerId: Models.ID }, async () => {
      Downloads.throwIfAborted(callerSignal);
      const installed = await existingSource(operation, source);
      if (installed) return installed;
      const root = path.join(context.userDataDir, "runtimes", Models.ID);
      Writable.assertOwnDirectory(context.userDataDir, root);
      const temporary = fs.mkdtempSync(path.join(root, ".download-")), archive = path.join(temporary, source.fileName);
      const limit = new AbortController(), signal = callerSignal ? AbortSignal.any([callerSignal, limit.signal]) : limit.signal;
      let oversized = false, reported = 0;
      try {
        await (dependencies.downloadToFile || Downloads.downloadToFile)(source.url, archive, { signal, onProgress: progress => {
          if (progress.downloaded > source.bytes || progress.total > source.bytes) { oversized = true; limit.abort(); }
          const now = Date.now();
          if (now - reported >= 100 || progress.downloaded === source.bytes) {
            reported = now; task.onProgress?.({ ...progress, phase: "download", label: "Downloading neural model…" });
          }
        } });
        Downloads.throwIfAborted(signal);
        task.onProgress?.({downloaded: source.bytes, total: source.bytes, detail: "Verifying neural model…"});
        const stat = fs.lstatSync(archive);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.bytes || await checksum(archive, signal) !== source.sha256)
          throw new Error("The neural model download does not match its release checksum. Try Download again.");
        const imported = await Models.importModel({ ...operation, signal, runtimePath: archive, onProgress: progress =>
          task.onProgress?.({...progress, downloaded: source.bytes, total: source.bytes, detail: progress.label}) });
        if (imported.weightsHash !== source.weightsHash || imported.manifestHash !== source.manifestHash)
          throw new Error("The downloaded release contains a different neural model package.");
        const receipt = path.join(imported.installDir, "download-source.json");
        if (!fs.existsSync(receipt)) fs.writeFileSync(receipt, JSON.stringify({ schema: 1, version: source.version,
          url: source.url, bytes: source.bytes, sha256: source.sha256, commit: source.commit,
          sourceLicense: source.sourceLicense, weightTerms: source.weightTerms }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
        return imported;
      } catch (error) {
        if (oversized && !callerSignal?.aborted) throw new Error("The neural model download exceeds its release size.");
        throw error;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }, { userDataDir: context.userDataDir });
  }, { onProgress: context.onProgress });
}
async function ensureNeuralModel(context = {}, dependencies = {}) {
  try {
    Downloads.throwIfAborted(context.signal);
    const installed = Models.listInstalled(context.userDataDir);
    const selected = context.settings?.runtimes?.[Models.ID]?.defaultVersion || context.settings?.defaultVersion;
    const ordered = [...installed.filter(row => row.version === selected), ...installed.filter(row => row.version !== selected)];
    for (const row of ordered) {
      try { const model = await Models.resolveModel(context.userDataDir, row.version, {signal: context.signal});return {modelPath: model.modelPath, version: model.version}; }
      catch (error) { Downloads.throwIfAborted(context.signal);if (Downloads.isAbortError(error)) throw error; }
    }
    const result = await downloadDlssMac(context, dependencies);
    return result ? { modelPath: result.modelPath, version: result.version } : null;
  } catch (error) { if (Downloads.isAbortError(error)) return null; throw error; }
}
module.exports = { sourceFor, downloadDlssMac, ensureNeuralModel };
