const fs = require("node:fs"), path = require("node:path");
const Packages = require("../google/packages"), Identity = require("../google/apk-identity");
const Catalog = require("../service-packages");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
// The Companion caller cache keeps one verified APK per recorded SHA-256.
function cachedCallers(userDataDir, pin) {
  const parent = path.join(userDataDir, "android/store/callers"), legacy = Packages.catalog.legacy?.packages.find(value => value.packageName === pin.packageName);
  let names = [];
  try { names = fs.readdirSync(parent).filter(name => /^[a-f0-9]{64}$/.test(name)); } catch {}
  return names.flatMap(name => {
    try { return [{ ...JSON.parse(fs.readFileSync(path.join(parent, name, "caller.json"), "utf8")), root: path.join(parent, name) }]; }
    catch { return legacy?.sha256 === name ? [{ ...legacy, root: path.join(parent, name) }] : []; }
  }).filter(record => record.packageName === pin.packageName && record.sha256 === path.basename(record.root))
    .sort((a, b) => b.versionCode - a.versionCode);
}
async function resolveCaller(context, { signal = context.signal, packageName = "com.android.vending" } = {}, dependencies = {}) {
  const pin = Packages.catalog.packages.find(value => value.packageName === packageName);
  if (!pin) throw new Error("The Google account caller package is invalid.");
  const signers = Packages.catalog.signers;
  signal?.throwIfAborted();
  // Reuse an installed original Companion APK. Android verifies its complete
  // signatures before it becomes the supervised account caller.
  const catalogFile = path.join(context.userDataDir, "android/services/catalog.json");
  if (fs.existsSync(catalogFile) && Catalog.read(context.userDataDir).packages.some(value => value.packageName === pin.packageName)) {
    let source;
    try {
      source = await Catalog.retainSource(context.userDataDir, pin.packageName, signal);
      const metadata = require("../apk").inspectApk(source.sources[0], { requireLauncher: false });
      if (metadata.packageName !== pin.packageName || source.sources.some(file => JSON.stringify(Identity.signingCertificates(file)) !== JSON.stringify([...signers].sort()))) throw new Error();
      return { apks: source.sources, release: source.release };
    } catch (error) { await source?.release(); if (signal?.aborted) throw error; }
  }
  try {
    const published = Packages.resolvePackages(context.userDataDir);
    const match = published?.packages.find(value => value.packageName === pin.packageName);
    if (match) return { apks: [match.file], release() {} };
  } catch {}
  for (const record of cachedCallers(context.userDataDir, pin)) {
    const file = path.join(record.root, path.basename(record.filename));
    try { Identity.verifyPublishedApk(file, { ...record, signers }); return { apks: [file], release() {} }; } catch {}
  }
  await (dependencies.confirmToolInstall || confirmToolInstall)(context, { managerId: "android-google-play-caller", label: pin.label,
    requiresDownload: true, detail: `Downloads ${pin.label} for verified Google account access.` });
  const parent = path.join(context.userDataDir, "android/store/callers");
  return (dependencies.withRuntimeMutation || withRuntimeMutation)({ managerId: "android-google-play-caller", version: "current" }, async () => {
    for (const record of cachedCallers(context.userDataDir, pin)) {
      const file = path.join(record.root, path.basename(record.filename));
      try { Identity.verifyPublishedApk(file, { ...record, signers }); return { apks: [file], release() {} }; } catch {}
    }
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stage = fs.mkdtempSync(path.join(parent, ".companion-"));
    try {
      const release = await Packages.discoverRelease({ signal, logger: context.logger });
      const { listed, ...selected } = release.packages.find(value => value.packageName === pin.packageName), file = path.join(stage, path.basename(selected.filename));
      await runDownloadTask(context.downloads, { label: pin.label, managerId: "android-google-play-caller", version: release.version,
        dedupeKey: "android-google-play-caller:" + selected.url }, async task => {
        const transferSignal = signal && task.signal ? AbortSignal.any([signal, task.signal]) : signal || task.signal;
        await Packages.source.download(listed, file, { signal: transferSignal, onProgress: task.onProgress });
      });
      signal?.throwIfAborted();
      const { signers: _signers, ...recorded } = Packages.verifyDownload(file, selected); fs.chmodSync(file, 0o400);
      fs.writeFileSync(path.join(stage, "caller.json"), JSON.stringify(recorded, null, 2) + "\n", { mode: 0o400, flag: "wx" });
      const root = path.join(parent, recorded.sha256);
      fs.rmSync(root, { recursive: true, force: true }); fs.renameSync(stage, root);
      return { apks: [path.join(root, path.basename(selected.filename))], release() {} };
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
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
