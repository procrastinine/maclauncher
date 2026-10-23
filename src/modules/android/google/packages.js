const fs = require("node:fs"), path = require("node:path");
const Writable = require("../../shared/writable-input");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
const Identity = require("./apk-identity");
const catalog = require("./catalog.json");
const validated = new Map();

function packageRoot(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("microG requires private launcher storage.");
  return path.join(userDataDir, "android", "google", "packages", catalog.version);
}
function resolvePackages(userDataDir, { verification = "full", verify = Identity.verifyPublishedApk } = {}) {
  const root = packageRoot(userDataDir);
  try {
    Writable.assertOwnDirectory(userDataDir, root, { create: false });
    const packages = catalog.packages.map(pin => {
      const file = path.join(root, pin.filename), stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(pin.bytes)) throw new Error("Invalid microG package.");
      const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      const previous = validated.get(file);
      let verified = previous?.identity === identity ? previous.verified : null;
      if (!verified && verification !== "status") {
        verified = verify(file, pin);
        if (validated.size >= 32) validated.delete(validated.keys().next().value);
        validated.set(file, { identity, verified });
      }
      if (!verified && verification !== "status") throw new Error("microG package verification failed.");
      return { ...pin, file, verified: !!verified, ...(verified ? { signers: verified.signers } : {}) };
    });
    return { version: catalog.version, root, packages };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function ensurePackages(context, dependencies = {}) {
  const verify = dependencies.verifyPublishedApk || Identity.verifyPublishedApk;
  const present = resolvePackages(context.userDataDir, { verify });
  if (present) return present;
  await (dependencies.confirmToolInstall || confirmToolInstall)(context, { managerId: "android-microg", label: "microG Services and Companion",
    version: catalog.version, requiresDownload: true,
    detail: "Downloads the official microG packages for the shared Android Google account service." });
  const mutate = dependencies.withRuntimeMutation || withRuntimeMutation;
  return mutate({ managerId: "android-microg", version: catalog.version }, async () => {
    const existing = resolvePackages(context.userDataDir, { verify });
    if (existing) return existing;
    const output = packageRoot(context.userDataDir), parent = path.dirname(output);
    Writable.assertOwnDirectory(context.userDataDir, parent);
    const staging = fs.mkdtempSync(path.join(parent, ".microg-download-"));
    try {
      await runDownloadTask(context.downloads, { label: "microG Services and Companion", managerId: "android-microg", version: catalog.version,
        dedupeKey: "android-microg:" + output }, async task => {
        const signal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal;
        for (const pin of catalog.packages) {
          throwIfAborted(signal);
          const file = path.join(staging, pin.filename);
          await (dependencies.downloadToFile || downloadToFile)(pin.url, file, { signal,
            onProgress: progress => task.onProgress?.({ ...progress, detail: pin.label }) });
          verify(file, pin); fs.chmodSync(file, 0o400);
        }
        throwIfAborted(signal);
      });
      fs.renameSync(staging, output);
      return resolvePackages(context.userDataDir, { verify });
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
}
module.exports = { catalog, packageRoot, resolvePackages, ensurePackages };
