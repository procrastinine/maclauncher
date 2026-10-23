const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { Readable, Transform } = require("node:stream"), { pipeline } = require("node:stream/promises");
const { packageName, versionCode, ARCHITECTURES, ANDROID_SDKS } = require("./protocol");
const { readApkIdentity } = require("./apk-identity");
const { writeJsonAtomic } = require("../../../core/json-files");
const { checkExistingDownload, createDownloadIdentity } = require("../../../core/external-download-duplicates");
const { reuseCompletedDownload } = require("../../../core/external-download-reuse");

const SOURCES = Object.freeze({ fdroid: { id: "fdroid", label: "F-Droid", repo: "https://f-droid.org/repo/", page: "https://f-droid.org/en/packages/" }, izzy: { id: "izzy", label: "IzzyOnDroid", repo: "https://apt.izzysoft.de/fdroid/repo/", page: "https://apt.izzysoft.de/fdroid/index/apk/" } });
const activeIndexFiles = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const publicError = message => Object.assign(new Error(message), { playPublic: true });
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const localText = (value, language = "en-US") => typeof value === "string" ? value : value?.[language] || value?.["en-US"] || value?.en || Object.values(value || {})[0] || "";
const plainText = html => String(html || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Math.min(Number(value), 0x10ffff))).replace(/\s+/g, " ").trim();
function sourceAppId(source, value) { if (!SOURCES[source]) throw publicError("Choose an Android repository."); return `${source}:${packageName(String(value).replace(new RegExp(`^${source}:`), ""))}`; }
function parseSourceQuery(input) {
  const value = String(input || "").trim(), match = /^(fdroid|izzy):(.+)$/i.exec(value);
  if (match) return { source: match[1].toLowerCase(), packageName: packageName(match[2]), query: value };
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname === "f-droid.org") { const id = /\/(?:packages)\/([^/]+)/.exec(url.pathname)?.[1]; if (id) return { source: "fdroid", packageName: packageName(decodeURIComponent(id)), query: value }; }
    if (url.hostname === "apt.izzysoft.de") { const id = /\/(?:index(?:\.php)?\/)?apk\/([^/]+)/.exec(url.pathname)?.[1]; if (id) return { source: "izzy", packageName: packageName(decodeURIComponent(id)), query: value }; }
    if (url.hostname === "play.google.com") return { source: "google-play", packageName: packageName(value), query: value };
    throw publicError("Enter a supported Android store URL, package name or app name.");
  }
  try { return { source: "google-play", packageName: packageName(value), query: value }; } catch {}
  if (value.length < 2 || value.length > 240) throw publicError("Enter an app name, package name or store URL.");
  return { source: null, query: value };
}
function repoUrl(source, filename) {
  const base = SOURCES[source].repo, relative = String(filename || "").replace(/^\//, "");
  if (!relative || /[\\\x00-\x1f]/.test(relative) || relative.split("/").some(part => part === ".." || part === ".")) throw publicError("The repository supplied an invalid file path.");
  const url = new URL(relative, base); if (!url.href.startsWith(base)) throw publicError("The repository supplied an unsupported file address."); return url.href;
}
async function response(url, { signal, method = "GET", body, headers = {}, redirects = 0, timeout = 120000 } = {}) {
  signal?.throwIfAborted(); const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || !["f-droid.org", "search.f-droid.org", "apt.izzysoft.de"].includes(endpoint.hostname)) throw publicError("The Android repository address is unsupported.");
  const result = await fetch(endpoint, { method, body, headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    await result.body?.cancel(); const location = result.headers.get("location"); if (!location || redirects >= 5) throw publicError("The Android repository returned an invalid redirect.");
    return response(new URL(location, endpoint).href, { signal, method: result.status === 303 ? "GET" : method, body: result.status === 303 ? undefined : body, headers, redirects: redirects + 1, timeout });
  }
  if (!result.ok) { await result.body?.cancel(); throw publicError(`The Android repository request failed (HTTP ${result.status}).`); }
  return result;
}
async function fetchData(url, options = {}) {
  const result = await response(url, options), parts = []; let received = 0;
  for await (const chunk of result.body) { received += chunk.length; if (received > (options.maxBytes || 4 * 1024 * 1024)) throw publicError("The Android repository response is too large."); parts.push(chunk); }
  return Buffer.concat(parts, received);
}
function parseIndexPackage(file, packageId, { signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "repository-index-worker.js"), { workerData: { file, packageName: packageId } }); let settled = false;
    const done = (error, result) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); worker.terminate(); if (error) reject(error); else resolve(result); };
    const abort = () => done(signal.reason || Object.assign(Error("Search cancelled."), { name: "AbortError" }));
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", value => done(value.error ? publicError(value.error) : null, value.result)); worker.once("error", () => done(publicError("The repository index could not be read."))); worker.once("exit", code => { if (!settled) done(publicError("The repository index reader stopped.")); });
  });
}
function parseIzzySearch(html) {
  const rows = [], seen = new Set();
  for (const block of String(html).split(/<div\b[^>]*class=['"]approw['"][^>]*>/i).slice(1)) {
    const id = /href=['"](?:\/fdroid\/)?index(?:\.php)?\/apk\/([a-zA-Z][a-zA-Z0-9_.]+)['"]/i.exec(block)?.[1];
    if (!id || seen.has(id)) continue;
    try { packageName(id); } catch { continue; } seen.add(id);
    const title = /class=['"]boldname['"][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1], icon = /<img\b[^>]*src=['"]([^'"]+)['"]/i.exec(block)?.[1];
    rows.push({ appId: `izzy:${id}`, packageName: id, name: plainText(title) || id, source: "izzy", sourceLabel: SOURCES.izzy.label, platforms: ["android"], owned: false, canAddToLibrary: false, iconUrl: icon ? new URL(icon, "https://apt.izzysoft.de/fdroid/").href : null });
  }
  return rows.slice(0, 100);
}
const architectureName = value => ({ "arm64-v8a": "arm64", "armeabi-v7a": "armv7", armeabi: "armv7", x86_64: "x86_64", x86: "x86" })[value] || null;
function normalizeRepositoryPackage(source, packageId, item, { language = "en-US", architecture = "arm64", androidSdk = 34, defaultDirectory } = {}) {
  const metadata = item?.metadata || {}, branches = [];
  for (const [key, value] of Object.entries(item?.versions || {})) {
    const file = value.file, manifest = value.manifest || {}, usesSdk = manifest.usesSdk || {};
    if (!file || !/^[a-f0-9]{64}$/i.test(file.sha256 || key) || !Number.isSafeInteger(file.size) || file.size <= 0) continue;
    let code; try { code = versionCode(manifest.versionCode); } catch { continue; }
    const architectures = [...new Set((manifest.nativecode || []).map(architectureName).filter(Boolean))];
    if (manifest.nativecode?.length && !architectures.length) continue;
    branches.push({ id: String(file.sha256 || key).toLowerCase(), name: String(manifest.versionName || `Version ${code}`), versionCode: code, versionName: manifest.versionName || null, buildId: code,
      platforms: ["android"], architectures, abiIndependent: !manifest.nativecode?.length, minSdk: Number(usesSdk.minSdkVersion) || 1, maxSdk: Number(usesSdk.maxSdkVersion || manifest.maxSdkVersion) || null, targetSdk: Number(usesSdk.targetSdkVersion) || null,
      sha256: String(file.sha256 || key).toLowerCase(), downloadSize: file.size, url: repoUrl(source, file.name), filename: path.posix.basename(file.name), updatedAt: Number(value.added) ? new Date(value.added).toISOString() : null, passwordRequired: false,
      signerSha256: manifest.signer?.sha256 || [] });
  }
  branches.sort((a, b) => BigInt(a.versionCode) === BigInt(b.versionCode) ? a.id.localeCompare(b.id) : BigInt(a.versionCode) > BigInt(b.versionCode) ? -1 : 1);
  const matches = branch => (!branch.architectures.length || branch.architectures.includes(architecture)) && branch.minSdk <= androidSdk && (!branch.maxSdk || androidSdk <= branch.maxSdk);
  const icon = localText(metadata.icon, language), name = localText(metadata.name, language) || packageId;
  const app = { appId: `${source}:${packageId}`, packageName: packageId, name, source, sourceLabel: SOURCES[source].label, platforms: ["android"], owned: false, canAddToLibrary: false, license: metadata.license || "", iconUrl: icon?.name ? repoUrl(source, icon.name) : null };
  return { ...app, app, branches, depots: [], history: [], source, sourceLabel: SOURCES[source].label, defaultDirectory, architectureSchema: 1,
    architectures: [...new Set(branches.flatMap(branch => branch.architectures))], supportedArchitectures: [...new Set(branches.flatMap(branch => branch.architectures))], abiIndependent: branches.some(branch => branch.abiIndependent),
    profile: { architecture, androidSdk, sdk: androidSdk }, sdkVersions: ANDROID_SDKS, deviceProfiles: ARCHITECTURES.map(value => ({ architecture: value, androidSdk, sdk: androidSdk, available: branches.some(branch => (!branch.architectures.length || branch.architectures.includes(value)) && branch.minSdk <= androidSdk && (!branch.maxSdk || androidSdk <= branch.maxSdk)) })),
    available: branches.some(matches), unavailableReason: branches.some(matches) ? undefined : "No published APK matches this architecture and Android SDK level.", supportsVersionCode: false, languages: [],
    historyNote: "Versions are the exact APKs published in this repository. Architecture and Android SDK limits come from its package index. Original APK signatures are retained; repository metadata hashes and APK SHA-256 checks are verified over HTTPS." };
}
function createRepositoryDownloads(options = {}) {
  if (!SOURCES[options.source] || !path.isAbsolute(options.userDataDir || "")) throw Error("An Android repository and launcher profile are required.");
  const source = options.source, descriptor = SOURCES[source], defaultDirectory = path.join(options.userDataDir, "external/downloads", source), cacheRoot = path.join(options.userDataDir, "external/catalogs", source);
  const state = { downloads: [], defaultDirectory }, emit = () => { if (!disposed) options.onChange?.(clone(state)); }, jobs = new Map(), catalogs = new Map(); let disposed = false, indexTask;
  const request = options.fetchData || fetchData;
  function retireIndexes(current) {
    for (const name of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []) {
      const file = path.join(cacheRoot, name);
      if (/^index-[a-f0-9]{64}\.json$/i.test(name) && file !== current && !activeIndexFiles.has(file)) { try { fs.unlinkSync(file); } catch {} }
    }
  }
  async function index({ refresh = false, signal } = {}) {
    const metadataFile = path.join(cacheRoot, "entry.json"), cached = readJson(metadataFile), cachedFile = cached?.entry?.index?.sha256 && path.join(cacheRoot, `index-${cached.entry.index.sha256}.json`);
    if (!refresh && cachedFile && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000 && fs.existsSync(cachedFile)) return cachedFile;
    if (indexTask) return indexTask;
    indexTask = (async () => {
      const entry = JSON.parse((await request(`${descriptor.repo}entry.json`, { signal, maxBytes: 2 * 1024 * 1024 })).toString("utf8")), pin = entry.index;
      if (!pin || !/^[a-f0-9]{64}$/i.test(pin.sha256) || !Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > 160 * 1024 * 1024) throw publicError("The repository supplied an invalid index reference.");
      fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 }); const target = path.join(cacheRoot, `index-${pin.sha256}.json`);
      if (!fs.existsSync(target)) {
        const body = await request(repoUrl(source, pin.name), { signal, maxBytes: pin.size });
        if (body.length !== pin.size || crypto.createHash("sha256").update(body).digest("hex") !== pin.sha256.toLowerCase()) throw publicError("The Android repository index failed its integrity check.");
        const temporary = `${target}.${crypto.randomUUID()}.tmp`; try { fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
      }
      writeJsonAtomic(metadataFile, { entry, fetchedAt: Date.now() }); retireIndexes(target); return target;
    })(); try { return await indexTask; } finally { indexTask = null; }
  }
  async function packageDetails(value, opts = {}) {
    const id = packageName(String(value).replace(new RegExp(`^${source}:`), "")), file = await index(opts);
    activeIndexFiles.set(file, (activeIndexFiles.get(file) || 0) + 1);
    let item;
    try { item = await (options.parseIndexPackage || parseIndexPackage)(file, id, opts); }
    finally { const count = activeIndexFiles.get(file) - 1; if (count) activeIndexFiles.set(file, count); else activeIndexFiles.delete(file); const metadata = readJson(path.join(cacheRoot, "entry.json")); if (metadata?.entry?.index?.sha256) retireIndexes(path.join(cacheRoot, `index-${metadata.entry.index.sha256}.json`)); }
    if (!item) throw publicError(`This app is not listed in ${descriptor.label}.`);
    return { id, item };
  }
  async function search(query, { signal } = {}) {
    const parsed = parseSourceQuery(query);
    if (parsed.packageName) { const { id, item } = await packageDetails(parsed.packageName, { signal }); return [normalizeRepositoryPackage(source, id, item).app]; }
    if (source === "fdroid") {
      const body = JSON.parse((await request(`https://search.f-droid.org/api/search_apps?q=${encodeURIComponent(parsed.query)}`, { signal, maxBytes: 4 * 1024 * 1024 })).toString("utf8"));
      return (body.apps || []).flatMap(value => { try { const parsed = parseSourceQuery(value.url); if (parsed.source !== source || !parsed.packageName) return []; return [{ appId: `${source}:${parsed.packageName}`, packageName: parsed.packageName, name: value.name || parsed.packageName, summary: value.summary || "", iconUrl: value.icon || null, source, sourceLabel: descriptor.label, platforms: ["android"], owned: false, canAddToLibrary: false }]; } catch { return []; } }).slice(0, 100);
    }
    const body = await request("https://apt.izzysoft.de/fdroid/index.php", { signal, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ searchterm: parsed.query, limit: "100", doFilter: "1" }).toString(), maxBytes: 4 * 1024 * 1024 });
    return parseIzzySearch(body.toString("utf8"));
  }
  async function getVersions(value, opts = {}) {
    const architecture = opts.architecture || "arm64", androidSdk = Number(opts.androidSdk ?? opts.sdk ?? 34);
    if (!ARCHITECTURES.includes(architecture) || !ANDROID_SDKS.includes(androidSdk)) throw publicError("Choose a supported architecture and Android SDK level.");
    const id = packageName(String(value).replace(new RegExp(`^${source}:`), "")), key = `${id}:${architecture}:${androidSdk}:${opts.language || "en-US"}`;
    if (!opts.refresh && catalogs.has(key)) return clone(catalogs.get(key));
    const { item } = await packageDetails(id, opts), result = normalizeRepositoryPackage(source, id, item, { ...opts, architecture, androidSdk, defaultDirectory }); catalogs.set(key, result); return clone(result);
  }
  async function transfer(item, output, { signal, onBytes }) {
    const result = await response(item.url, { signal }), hash = crypto.createHash("sha256"); let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > item.downloadSize) return callback(publicError("The APK exceeded its declared size.")); hash.update(chunk); onBytes?.(chunk.length); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(result.body), meter, fs.createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal });
    const sha256 = hash.digest("hex"); if (bytes !== item.downloadSize || sha256 !== item.sha256) throw publicError("The downloaded APK failed its integrity check."); return { size: bytes, sha256 };
  }
  function download(selection = {}) {
    const id = packageName(String(selection.appId || "").replace(new RegExp(`^${source}:`), "")), architecture = selection.architecture || "arm64", androidSdk = Number(selection.androidSdk ?? selection.sdk ?? 34);
    if (!ARCHITECTURES.includes(architecture) || !ANDROID_SDKS.includes(androidSdk)) throw publicError("Choose a supported architecture and Android SDK level.");
    if (selection.destination && (!path.isAbsolute(selection.destination) || /[\x00-\x1f]/.test(selection.destination))) throw publicError("Choose an absolute download folder.");
    const record = { id: crypto.randomUUID(), store: source, source, sourceLabel: descriptor.label, appId: id, packageName: id, name: selection.name || id, platform: "android", architecture, androidSdk, language: selection.language || "en-US", autoImport: selection.autoImport !== false, imported: false, status: "queued", downloaded: 0, total: null, path: null, detail: "Preparing download", createdAt: new Date().toISOString() };
    const controller = new AbortController(), signal = controller.signal, holder = { record, controller }; jobs.set(record.id, holder); state.downloads.unshift(record); emit();
    holder.promise = (async () => { let stage, terminalStatus;
      try {
        record.status = "preparing"; emit(); const versions = await getVersions(`${source}:${id}`, { architecture, androidSdk, signal });
        const chosen = selection.branch ? versions.branches.find(row => row.id === selection.branch) : selection.versionCode ? versions.branches.find(row => row.versionCode === String(selection.versionCode) && (!row.architectures.length || row.architectures.includes(architecture))) : null;
        if (!chosen) throw publicError("Choose an exact published APK version.");
        if (chosen.architectures.length && !chosen.architectures.includes(architecture) || chosen.minSdk > androidSdk || chosen.maxSdk && androidSdk > chosen.maxSdk) throw publicError("This APK does not support the selected architecture and Android SDK level.");
        record.name = selection.name || versions.name; record.branch = chosen.id; record.versionCode = chosen.versionCode; record.buildId = chosen.versionCode; record.versionName = chosen.name; record.version = chosen.name; record.versionId = `apk:${chosen.sha256}`;
        const duplicateRequest = { userDataDir: options.userDataDir, store: source, appId: id, platform: "android", versionId: record.versionId, destination: selection.destination, confirmDuplicate: options.confirmDuplicate, signal };
        record.downloadIdentity = createDownloadIdentity(duplicateRequest); const existing = await checkExistingDownload(duplicateRequest); signal.throwIfAborted(); if (existing) return await reuseCompletedDownload(record, existing, { signal, onChange: emit, onDownloaded: options.onDownloaded });
        const parent = path.resolve(selection.destination || path.join(defaultDirectory, id)), finalPath = path.join(parent, `${chosen.versionCode}-${record.id}`); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); stage = fs.mkdtempSync(path.join(fs.realpathSync(parent), ".android-repository-")); record.path = finalPath; record.importPath = path.join(finalPath, "base.apk"); record.total = chosen.downloadSize; record.status = "downloading"; emit();
        let lastEmit = 0;
        const output = path.join(stage, "base.apk"), verified = await (options.downloadFile || transfer)(chosen, output, { signal, onBytes: count => { record.downloaded += count; if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); emit(); } } });
        const identity = (options.readApkIdentity || readApkIdentity)(output); if (identity.packageName !== id || identity.versionCode !== chosen.versionCode || identity.split) throw publicError("The APK does not match its selected package and exact version code.");
        signal.throwIfAborted(); const metadata = { schema: 1, store: source, source, appId: id, packageName: id, name: record.name, platform: "android", architecture, androidSdk, buildId: chosen.versionCode, versionCode: chosen.versionCode, version: chosen.name, versionName: chosen.name, versionId: record.versionId, downloadIdentity: record.downloadIdentity,
          sha256: chosen.sha256, path: finalPath, importPath: record.importPath, complete: true, createdAt: record.createdAt, files: [{ filename: "base.apk", sha256: verified.sha256, size: verified.size }] };
        writeJsonAtomic(path.join(stage, ".maclauncher-external.json"), metadata); fs.renameSync(stage, finalPath); stage = null;
        const indexFile = path.join(options.userDataDir, "external/installations.json"), index = readJson(indexFile, []); writeJsonAtomic(indexFile, [...(Array.isArray(index) ? index : []), metadata]);
        record.status = "completed"; record.detail = "Download complete"; record.completedAt = new Date().toISOString(); emit();
        if (record.autoImport && options.onDownloaded) { try { await options.onDownloaded(clone(record)); record.imported = true; } catch { record.importError = "The download is complete, but the Android package could not be imported. Import base.apk manually."; } }
      } catch (error) { terminalStatus = signal.aborted || error.name === "AbortError" || error.code === "ABORT_ERR" ? "cancelled" : "error"; record.detail = terminalStatus === "cancelled" ? "Download cancelled" : error.playPublic ? error.message : "The Android repository download could not be completed."; if (terminalStatus === "error") record.error = record.detail; }
      finally { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); if (terminalStatus) record.status = terminalStatus; jobs.delete(record.id); emit(); }
      return clone(record);
    })(); return clone(record);
  }
  function cancel(id) { jobs.get(id)?.controller.abort(); return clone(state); }
  function markImported(id) { const record = state.downloads.find(row => row.id === id); if (record) { record.imported = true; record.importError = null; emit(); } return clone(state); }
  async function dispose() { disposed = true; for (const value of jobs.values()) value.controller.abort(); await Promise.allSettled([...jobs.values()].map(value => value.promise)); }
  return { snapshot: () => clone(state), search, getVersions, download, cancel, markImported, dispose };
}
module.exports = { createRepositoryDownloads, normalizeRepositoryPackage, parseSourceQuery, parseIzzySearch, parseIndexPackage, sourceAppId, repoUrl, fetchData, SOURCES };
