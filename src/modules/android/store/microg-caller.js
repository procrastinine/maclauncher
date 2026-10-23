const fs = require("node:fs"), path = require("node:path");
const Packages = require("../google/packages"), Identity = require("../google/apk-identity");
const Catalog = require("../service-packages");
const { downloadToFile } = require("../../shared/runtime/download-utils");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
async function resolveCaller(context, { signal = context.signal, packageName = "com.android.vending" } = {}, dependencies = {}) {
  const pin = Packages.catalog.packages.find(value => value.packageName === packageName);
  if (!pin) throw new Error("The Google account caller package is invalid.");
  signal?.throwIfAborted();
  // Reuse an installed original Companion APK. Android verifies its complete
  // signatures before it becomes the supervised account caller.
  const catalogFile = path.join(context.userDataDir, "android/services/catalog.json");
  if (fs.existsSync(catalogFile) && Catalog.read(context.userDataDir).packages.some(value => value.packageName === pin.packageName)) {
    let source;
    try {
      source = await Catalog.retainSource(context.userDataDir, pin.packageName, signal);
      const metadata = require("../apk").inspectApk(source.sources[0], { requireLauncher: false });
      if (metadata.packageName !== pin.packageName || source.sources.some(file => JSON.stringify(Identity.signingCertificates(file)) !== JSON.stringify([...pin.signers].sort()))) throw new Error();
      return { apks: source.sources, release: source.release };
    } catch (error) { await source?.release(); if (signal?.aborted) throw error; }
  }
  try {
    const published = Packages.resolvePackages(context.userDataDir);
    const match = published?.packages.find(value => value.packageName === pin.packageName);
    if (match) return { apks: [match.file], release() {} };
  } catch {}
  const root = path.join(context.userDataDir, "android/store/callers", pin.sha256), file = path.join(root, pin.filename);
  try { Identity.verifyPublishedApk(file, pin); return { apks: [file], release() {} }; } catch {}
  await (dependencies.confirmToolInstall || confirmToolInstall)(context, { managerId: "android-google-play-caller", label: pin.label, version: Packages.catalog.version,
    requiresDownload: true, detail: `Downloads ${pin.label} for verified Google account access.` });
  await (dependencies.withRuntimeMutation || withRuntimeMutation)({ managerId: "android-google-play-caller", version: pin.sha256 }, async () => {
    try { Identity.verifyPublishedApk(file, pin); return; } catch {}
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    const stage = fs.mkdtempSync(path.join(path.dirname(root), ".companion-"));
    try {
      await runDownloadTask(context.downloads, { label: pin.label, managerId: "android-google-play-caller", version: Packages.catalog.version,
        dedupeKey: "android-google-play-caller:" + pin.sha256 }, async task => {
        const transferSignal = signal && task.signal ? AbortSignal.any([signal, task.signal]) : signal || task.signal;
        await (dependencies.downloadToFile || downloadToFile)(pin.url, path.join(stage, pin.filename), { signal: transferSignal, onProgress: task.onProgress });
      });
      signal?.throwIfAborted(); Identity.verifyPublishedApk(path.join(stage, pin.filename), pin); fs.chmodSync(path.join(stage, pin.filename), 0o400);
      fs.renameSync(stage, root);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
  return { apks: [file], release() {} };
}

async function ensureGoogleServices(context, dependencies = {}) {
  const present = Catalog.read(context.userDataDir).packages, missing = Packages.catalog.packages.filter(pin => !present.some(value => value.packageName === pin.packageName));
  const payload = await require("../account-runtime").resolveForAccounts(context, { install: true });
  const java = await require("../host").ensureJava(context);
  if (missing.length) {
    const packages = await (dependencies.ensurePackages || Packages.ensurePackages)(context);
    for (const pin of missing) {
      const installed = Catalog.read(context.userDataDir).packages.some(value => value.packageName === pin.packageName); if (installed) continue;
      await (dependencies.installServicePackage || Catalog.installServicePackage)(packages.packages.find(value => value.packageName === pin.packageName).file, context, payload, java);
    }
  }
  for (const value of Catalog.read(context.userDataDir).packages) if (Packages.catalog.packages.some(pin => pin.packageName === value.packageName) && !value.enabled)
    await Catalog.setEnabled(context.userDataDir, value.packageName, true);
  return { payload, java };
}

module.exports = { resolveCaller, ensureGoogleServices };
