const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../shared/writable-input");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Upstream = require("../../shared/runtime/upstream");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
const Identity = require("./apk-identity");
const catalog = require("./catalog.json");
const validated = new Map();
const newer = (a, b) => String(b).localeCompare(String(a), undefined, { numeric: true });

// microG publishes <package>-<versionCode>.apk files with each GmsCore release.
// The newest release offering every package is used; each APK must carry
// microG's signing certificate, its package name and the version code in its
// name, and GitHub's published digest when there is one.
function releaseAsset(assets, packageName) {
  const prefix = `${packageName}-`, plain = /^\d+\.apk$/, variant = /^\d+-[A-Za-z0-9_.-]+\.apk$/;
  const named = (assets || []).filter(asset => typeof asset?.name === "string" && asset.name.startsWith(prefix));
  return named.find(asset => plain.test(asset.name.slice(prefix.length))) ||
    named.find(asset => variant.test(asset.name.slice(prefix.length)) && !/(?:^|[-_.])(?:hw|huawei|debug|unsigned)(?:[-_.]|$)/i.test(asset.name.slice(prefix.length)));
}
const source = Upstream.github({ repository: catalog.repository, recognize: release => {
  const version = String(release.tag_name || "").replace(/^v(?=\d)/, "");
  const assets = catalog.packages.map(item => releaseAsset(release.assets, item.packageName));
  return /^\d+(?:\.\d+)+$/.test(version) && assets.every(Boolean) ? { version, assets } : [];
} });
// A listed release with one pin per package, in catalog order.
function releasePins(row) {
  const packages = catalog.packages.map((item, index) => {
    const listed = row.files[index];
    return listed && { ...item, versionCode: Number(/-(\d+)/.exec(listed.name.slice(item.packageName.length))[1]), filename: listed.name,
      url: listed.url, bytes: listed.bytes ?? null, sha256: listed.digest?.algorithm === "sha256" ? listed.digest.value : null, listed };
  });
  return packages.every(Boolean) ? { version: row.version, releaseUrl: row.sourceUrl, packages } : null;
}
async function discoverRelease({ signal, logger } = {}) {
  const [release] = (await source.discover({ signal, logger })).map(releasePins).filter(Boolean).sort((a, b) => newer(a.version, b.version));
  if (!release) throw new Error("microG has no published release with its Services and Companion packages.");
  return release;
}
// A downloaded package is accepted by its publisher identity; its SHA-256 is
// recorded so the installation verifies offline.
function verifyDownload(file, pin, verify = Identity.verifyPublishedApk) {
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { fs.closeSync(fd); }
  const sha256 = hash.digest("hex");
  if (pin.sha256 && pin.sha256 !== sha256) throw new Error("The microG package checksum differs from its published release.");
  const recorded = { ...pin, sha256, bytes: fs.statSync(file).size, signers: catalog.signers };
  verify(file, recorded);
  return recorded;
}

function packagesDirectory(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("microG requires private launcher storage.");
  return path.join(userDataDir, "android", "google", "packages");
}
// Installations live in packages/<version>/ with a release.json record; the
// earlier fixed release keeps its recorded identities.
function installedReleases(userDataDir) {
  let names = [];
  try { names = fs.readdirSync(packagesDirectory(userDataDir)).filter(name => /^\d+(?:\.\d+)+$/.test(name)); } catch {}
  return names.sort(newer).flatMap(version => {
    const root = path.join(packagesDirectory(userDataDir), version);
    try { const record = JSON.parse(fs.readFileSync(path.join(root, "release.json"), "utf8")); return record.version === version ? [{ ...record, root }] : []; }
    catch { return version === catalog.legacy?.version ? [{ ...catalog.legacy, root }] : []; }
  });
}
function packageRoot(userDataDir) { return installedReleases(userDataDir)[0]?.root || null; }
function resolvePackages(userDataDir, { verification = "full", verify = Identity.verifyPublishedApk } = {}) {
  let failure = null;
  for (const release of installedReleases(userDataDir)) {
    try {
      Writable.assertOwnDirectory(userDataDir, release.root, { create: false });
      const packages = catalog.packages.map(item => {
        const pin = { ...release.packages.find(value => value.packageName === item.packageName), signers: catalog.signers };
        const file = path.join(release.root, path.basename(pin.filename || "")), stat = fs.lstatSync(file, { bigint: true });
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
      return { version: release.version, root: release.root, packages };
    } catch (error) { failure ||= error; }
  }
  if (failure && failure.code !== "ENOENT") throw failure;
  return null;
}

async function ensurePackages(context, dependencies = {}) {
  const verify = dependencies.verifyPublishedApk || Identity.verifyPublishedApk;
  const present = resolvePackages(context.userDataDir, { verify });
  if (present) return present;
  await (dependencies.confirmToolInstall || confirmToolInstall)(context, { managerId: "android-microg", label: "microG Services and Companion",
    requiresDownload: true, detail: "Downloads the official microG packages for the shared Android Google account service." });
  const mutate = dependencies.withRuntimeMutation || withRuntimeMutation;
  return mutate({ managerId: "android-microg", version: "current" }, async () => {
    const existing = resolvePackages(context.userDataDir, { verify });
    if (existing) return existing;
    const parent = packagesDirectory(context.userDataDir);
    Writable.assertOwnDirectory(context.userDataDir, parent);
    const staging = fs.mkdtempSync(path.join(parent, ".microg-download-"));
    try {
      const release = await discoverRelease({ signal: context.signal, logger: context.logger });
      const output = path.join(parent, release.version), recorded = [];
      await runDownloadTask(context.downloads, { label: "microG Services and Companion", managerId: "android-microg", version: release.version,
        dedupeKey: "android-microg:" + output }, async task => {
        const signal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal;
        for (const pin of release.packages) {
          throwIfAborted(signal);
          const file = path.join(staging, path.basename(pin.filename));
          const { listed, ...record } = pin;
          await source.download(listed, file, { signal, onProgress: progress => task.onProgress?.({ ...progress, detail: pin.label }) });
          recorded.push(verifyDownload(file, record, verify)); fs.chmodSync(file, 0o400);
        }
        throwIfAborted(signal);
      });
      fs.writeFileSync(path.join(staging, "release.json"), JSON.stringify({ version: release.version, releaseUrl: release.releaseUrl,
        packages: recorded.map(({ signers, ...pin }) => pin) }, null, 2) + "\n", { mode: 0o400, flag: "wx" });
      fs.rmSync(output, { recursive: true, force: true });
      fs.renameSync(staging, output);
      return resolvePackages(context.userDataDir, { verify });
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
}
module.exports = { catalog, source, packageRoot, resolvePackages, ensurePackages, discoverRelease, verifyDownload, releaseAsset };
