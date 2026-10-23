const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Catalog = require("./managed-shader-packs.json"), Traits = require("./shader-traits"), Providers = require("./shader-providers");
const Writable = require("../writable-input"), Native = require("../runtime/local-native");
const Zip = require("../runtime/zip"), Releases = require("../runtime/github-releases");
const Downloads = require("../runtime/download-utils"), { runDownloadTask } = require("../runtime/download-manager");
const { confirmToolInstall } = require("../runtime/tool-install");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
const ID = "graphics-shader-library", LIMITS = { archive: 64 << 20, expanded: 256 << 20, file: 8 << 20, entries: 4096, versions: 64 };
const formats = { ".fx": "fx", ".glsl": "libplacebo", ".hook": "libplacebo", ".slangp": "slangp", ".slang": "slangp" };
const safe = value => typeof value === "string" && value.length > 0 && value.length < 1024 && !path.posix.isAbsolute(value) &&
  !/[\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
const version = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value || "")) throw new Error("Invalid shader pack version."); return value; };
const packFor = id => { const pack = Catalog.packs.find(row => row.id === id); if (!pack) throw new Error("Unknown shader pack."); return pack; };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const verified = new Map(), pending = new Map(), states = new Map();
function directory(userDataDir, packId) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Shader packs require the launcher's data directory.");
  if (packId) packFor(packId);
  return path.join(userDataDir, "runtimes", ID, ...(packId ? [packId] : []));
}
function installRoot(userDataDir, packId, selected) { return path.join(directory(userDataDir, packId), version(selected)); }
function isId(id) { return /^shader:managed-[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{16}$/.test(id || ""); }
function parseId(id) {
  if (!isId(id)) throw new Error("Unknown managed shader.");
  const match = /^shader:managed-(.+):([a-f0-9]{16})$/.exec(id);
  return { pack: packFor(match[1]), effect: match[2] };
}
function validRow(pack, row) {
  try {
    version(row.version);
    if (row.commit && !/^[a-f0-9]{40}$/.test(row.commit)) return false;
    if (pack.delivery !== "release-zip") return row.version === "git-" + row.commit;
    const url = new URL(row.archive.url);
    return typeof row.tag === "string" && row.tag.length < 100 && url.protocol === "https:" && url.hostname === "github.com" &&
      url.pathname.startsWith(`/${pack.repository}/releases/download/`) && !url.search && !url.hash &&
      new RegExp(pack.assetPattern, "i").test(path.posix.basename(url.pathname)) &&
      Number.isSafeInteger(row.archive.bytes) && row.archive.bytes > 0 && row.archive.bytes <= LIMITS.archive &&
      (!row.archive.sha256 || /^[a-f0-9]{64}$/.test(row.archive.sha256));
  } catch { return false; }
}
function cached(userDataDir, packId) {
  try {
    const pack = packFor(packId), file = path.join(directory(userDataDir, packId), "catalog.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (2 << 20)) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.repository !== pack.repository || !Array.isArray(record.entries) || record.entries.length > LIMITS.versions ||
      record.entries.some(row => !validRow(pack, row))) return null;
    return record;
  } catch { return null; }
}
function available(userDataDir, packId) {
  const pack = packFor(packId), rows = new Map([[pack.pin.version, pack.pin]]);
  for (const row of cached(userDataDir, packId)?.entries || []) rows.set(row.version, row.version === pack.pin.version
    ? { ...pack.pin, ...row, commit: pack.pin.commit, ...(row.archive ? { archive: { ...row.archive, sha256: row.archive.sha256 || pack.pin.archive?.sha256 } } : {}) } : row);
  return [...rows.values()].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) ||
    b.version.localeCompare(a.version, "en", { numeric: true }));
}
function installed(userDataDir, packId, selected, full = false) {
  try {
    const root = installRoot(userDataDir, packId, selected), file = path.join(root, "pack.json");
    Writable.assertOwnDirectory(userDataDir, root, { create: false });
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (4 << 20)) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.schema !== 1 || record.packId !== packId || record.version !== selected || !validRow(packFor(packId), record.source) ||
      !Array.isArray(record.effects) || !record.effects.length || record.effects.length > LIMITS.entries || !record.files ||
      Object.keys(record.files).length > LIMITS.entries || record.effects.some(row => !safe(row.file) ||
        !formats[path.extname(row.file).toLowerCase()] || row.id !== record.files[row.file]?.sha256?.slice(0, 16))) return null;
    if (full) {
      const identities = [];
      for (const [relative, item] of Object.entries(record.files)) {
        if (!safe(relative) || !/^[a-f0-9]{64}$/.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes > LIMITS.file) return null;
        const child = path.join(root, "files", relative), childStat = fs.lstatSync(child);
        if (!childStat.isFile() || childStat.isSymbolicLink() || childStat.size !== item.bytes || fs.realpathSync(child) !== child) return null;
        identities.push([relative, childStat.ino, childStat.size, childStat.mtimeMs, childStat.ctimeMs]);
      }
      const identity = JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
      if (verified.get(root) !== identity) {
        for (const [relative, item] of Object.entries(record.files)) if (Native.hashFile(path.join(root, "files", relative)) !== item.sha256) return null;
        if (verified.size > 128) verified.delete(verified.keys().next().value);
        verified.set(root, identity);
      }
    }
    return { ...record, root, installDir: root, ready: true, removable: true, sectionId: packId,
      versionLabel: record.source.tag || record.source.date?.slice(0, 10) + " · " + record.source.commit?.slice(0, 8) || selected };
  } catch { return null; }
}
function listInstalled(userDataDir, packId) {
  if (!packId) return Catalog.packs.flatMap(pack => listInstalled(userDataDir, pack.id));
  try { return fs.readdirSync(directory(userDataDir, packId)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name))
    .slice(0, LIMITS.versions).map(selected => installed(userDataDir, packId, selected)).filter(Boolean)
    .sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt))); } catch { return []; }
}
function selectedInstalls(userDataDir, packId, options = {}) {
  const records = listInstalled(userDataDir, packId);
  // Explicit caller selections stay pinned. The library default only chooses
  // between copies of the same stable, content-addressed shader ID.
  if (options.packVersion !== undefined) return records.filter(record => record.version === version(options.packVersion));
  const preferred = options.settings?.runtimes?.[ID]?.defaultVersions?.[packId];
  return [...records.filter(record => record.version === preferred), ...records.filter(record => record.version !== preferred)];
}
function availability(effect, features, options = {}) {
  const nativeVideo = options.nativeVideo === true || features?.nativeVideo === true;
  if (effect.nativeVideo && !nativeVideo) return "Requires native video luma or chroma inputs.";
  return nativeVideo && effect.format === "libplacebo" ? null : Providers.availability(effect.format, { ...options, features });
}
function effectTraits(record, effect) {
  if (effect.traitsVersion === Traits.VERSION || effect.format !== "libplacebo") return effect.traits;
  const traits = Traits.analyzeFile(path.join(record.root, "files", effect.file), effect.format).traits;
  return effect.nativeVideo ? { ...traits, rgbCompatible: false } : traits;
}
function listEffects(userDataDir, features = {}, options = {}) {
  const seen = new Set();
  return Catalog.packs.flatMap(pack => selectedInstalls(userDataDir, pack.id, options)).flatMap(record => record.effects.flatMap(effect => {
    const id = `shader:managed-${record.packId}:${effect.id}`;
    if (seen.has(id)) return []; seen.add(id);
    let reason = availability(effect, features, options), nativeVideoAvailable = effect.format === "libplacebo";
    const file = path.join(record.root, "files", effect.file);let traits = effect.traits;
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();traits = effectTraits(record, effect); }
    catch { reason = "The installed shader file is missing. Reinstall this shader pack."; nativeVideoAvailable = false; }
    return [{ id, label: `${packFor(record.packId).label} · ${effect.label}`, group: packFor(record.packId).label,
      format: effect.format, traits, category: traits.category,
      nativeVideo: effect.nativeVideo, nativeVideoAvailable, installed: true, bundled: false, available: !reason, reason }];
  }));
}
function resolveEffect(userDataDir, id, features = {}, graphicsHost, options = {}) {
  const selected = parseId(id);
  for (const record of selectedInstalls(userDataDir, selected.pack.id, options)) {
    const effect = record.effects.find(row => row.id === selected.effect);
    if (!effect) continue;
    const reason = availability(effect, features, { ...options, graphicsHost });
    if (reason) throw new Error(reason);
    if (!installed(userDataDir, selected.pack.id, record.version, true)) throw new Error("The installed shader pack changed. Reinstall this version.");
    const root = path.join(record.root, "files"), file = path.join(root, effect.file);
    return { file, format: effect.format, traits: effectTraits(record, effect), includePaths: [...new Set([path.dirname(file), root])],
      texturePaths: [root, path.dirname(file)], runtimeIdentity: { managerId: ID, sectionId: record.packId, version: record.version, sourcePath: record.root } };
  }
  throw new Error("This shader pack version is not installed. Install it in Graphics → Shader library.");
}
async function json(url, signal, dependencies) {
  const response = await (dependencies.fetchUrlBuffer || Downloads.fetchUrlBuffer)(url, { signal, maxBytes: 8 << 20,
    headers: { "User-Agent": "maclauncher", Accept: "application/vnd.github+json" } });
  if (response.status !== 200) throw new Error(`Shader version information could not be downloaded (${response.status}).`);
  return JSON.parse(Downloads.decodeResponseBody(response.body, response.headers, { maxBytes: 8 << 20 }).toString("utf8"));
}
async function refreshCatalog(context = {}, dependencies = {}) {
  const packs = context.sectionId ? [packFor(context.sectionId)] : Catalog.packs;
  await Promise.all(packs.map(async pack => {
    const key = directory(context.userDataDir, pack.id), previous = cached(context.userDataDir, pack.id);
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      states.set(key, { status: "loading", error: null });
      try {
        let entries;
        if (pack.delivery === "release-zip") {
          const [owner, repo] = pack.repository.split("/");
          const releases = await (dependencies.fetchReleases || Releases.fetchGithubReleases)({ owner, repo, signal: context.signal, maxPages: 3 });
          entries = releases.filter(row => !row.draft && !row.prerelease).flatMap(release => {
            const asset = release.assets?.find(item => new RegExp(pack.assetPattern, "i").test(item.name));
            return asset ? [{ version: String(release.tag_name).replace(/^v(?=\d)/, ""), tag: release.tag_name,
              date: release.published_at, archive: { url: asset.browser_download_url, bytes: asset.size,
                sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest || "") ? asset.digest.slice(7) : null } }] : [];
          }).filter(row => validRow(pack, row));
        } else {
          const commit = await json(`https://api.github.com/repos/${pack.repository}/commits/${pack.branch}`, context.signal, dependencies);
          entries = [{ version: "git-" + commit.sha, commit: commit.sha, date: commit.commit?.committer?.date }];
        }
        const rows = new Map([...available(context.userDataDir, pack.id), ...entries].map(row => [row.version, row]));
        const record = { repository: pack.repository, fetchedAt: Date.now(), entries: [...rows.values()].filter(row => validRow(pack, row)).slice(-LIMITS.versions) };
        if (!record.entries.length) throw new Error("No compatible shader pack versions were found.");
        Downloads.throwIfAborted(context.signal);
        Writable.assertOwnDirectory(context.userDataDir, key);
        Writable.atomicWrite(path.join(key, "catalog.json"), JSON.stringify(record, null, 2) + "\n", { root: context.userDataDir });
        states.set(key, { status: "success", error: null });
      } catch (error) { states.set(key, { status: "error", error: error.message }); throw error; }
      finally { pending.delete(key); }
    })();
    pending.set(key, task); return task;
  }));
  return true;
}
function keep(relative) {
  return Boolean(formats[path.extname(relative).toLowerCase()]) || /\.(?:fxh|h|hlsl|inc|glslinc|png|jpg|jpeg|bmp|tga|dds|webp|cube|lut|txt|md|json|ini)$/i.test(relative) ||
    /^(?:LICENSE|NOTICE|COPYING|AUTHORS)(?:[._-].*)?$/i.test(path.posix.basename(relative));
}
function extract(archive, destination) {
  const info = Zip.readZipEntries(archive)?.info;
  if (!info || info.entries > LIMITS.entries) throw new Error("The shader archive is invalid or too large.");
  const fd = fs.openSync(archive, "r"); let entries;
  try { entries = Zip.readCentralDirectory(fd, info, { metadata: true }); } finally { fs.closeSync(fd); }
  if (entries.length !== info.entries) throw new Error("The shader archive is incomplete.");
  const names = new Set(); let expanded = 0;
  const files = entries.filter(entry => !entry.name.endsWith("/"));
  const first = files[0]?.name.split("/")[0], prefix = first && files.every(row => row.name.startsWith(first + "/")) ? first + "/" : "";
  for (const entry of entries) {
    const relative = entry.name.replace(/\/$/, ""), mode = entry.externalAttributes >>> 16;
    if (!safe(relative) || names.has(relative.toLowerCase()) || (mode & 0o170000) === 0o120000 || entry.flags & 1 ||
      entry.uncompressedSize > LIMITS.file || (expanded += entry.uncompressedSize) > LIMITS.expanded)
      throw new Error("The shader archive contains an unsafe or oversized entry.");
    names.add(relative.toLowerCase());
    if (entry.name.endsWith("/")) continue;
    const target = relative.slice(prefix.length);
    if (!keep(target)) continue;
    const bytes = Zip.readZipEntry(archive, entry, { maxOutputBytes: LIMITS.file });
    if (!bytes || bytes.length !== entry.uncompressedSize) throw new Error("A shader archive file could not be extracted.");
    const file = path.join(destination, target); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: "wx" });
  }
}
async function download(url, file, context, dependencies, maxBytes = LIMITS.archive) {
  const limit = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, limit.signal]) : limit.signal;
  try {
    await (dependencies.downloadToFile || Downloads.downloadToFile)(url, file, { signal, onProgress: progress => {
      if (progress.downloaded > maxBytes || progress.total > maxBytes) limit.abort();
      context.onProgress?.(progress);
    } });
    if (fs.statSync(file).size > maxBytes) throw new Error("The shader download is too large.");
  } catch (error) { if (limit.signal.aborted && !context.signal?.aborted) throw new Error("The shader download is too large."); throw error; }
}
function discover(files, pack) {
  const inventory = {}, effects = [], seen = new Set(); let count = 0, total = 0;
  function visit(root, prefix = "") {
    for (const row of fs.readdirSync(root, { withFileTypes: true })) {
      const relative = prefix + row.name, file = path.join(root, row.name);
      if (!safe(relative) || row.isSymbolicLink()) throw new Error("The shader pack contains an unsafe path.");
      if (row.isDirectory()) { visit(file, relative + "/"); continue; }
      const stat = fs.statSync(file);
      if (!row.isFile() || ++count > LIMITS.entries || stat.size > LIMITS.file || (total += stat.size) > LIMITS.expanded)
        throw new Error("The shader pack contains too many or oversized files.");
      const bytes = fs.readFileSync(file), sha256 = hash(bytes);
      inventory[relative] = { bytes: bytes.length, sha256 };
      const format = formats[path.extname(relative).toLowerCase()];
      if (!format || seen.has(sha256.slice(0, 16))) continue;
      const text = bytes.toString("utf8");
      if (text.includes("\0")) throw new Error("The shader source contains invalid text.");
      const traits = Traits.inspect(text, format), nativeVideo = format === "libplacebo" && (traits.requiresVideoPlanes ||
        pack.videoPaths?.some(item => relative.startsWith(item)));
      if (nativeVideo) traits.rgbCompatible = false;
      effects.push({ id: sha256.slice(0, 16), file: relative, format, label: relative.replace(/\.[^.]+$/, "").replace(/_/g, " "), traits, traitsVersion: Traits.VERSION, nativeVideo });
      seen.add(sha256.slice(0, 16));
    }
  }
  visit(files);
  if (!effects.length) throw new Error("The selected archive contains no supported shader files.");
  return { files: inventory, effects };
}
async function installRuntime(context = {}, dependencies = {}) {
  const pack = packFor(context.sectionId), selected = version(context.version || available(context.userDataDir, pack.id)[0].version);
  const current = installed(context.userDataDir, pack.id, selected, true); if (current) return current;
  const row = available(context.userDataDir, pack.id).find(item => item.version === selected);
  if (!row) throw new Error("Refresh the shader pack version list before installing this version.");
  return withRuntimeMutation({ managerId: ID, sectionId: pack.id, version: selected }, async () => {
    const current = installed(context.userDataDir, pack.id, selected, true); if (current) return current;
    await confirmToolInstall(context, { managerId: ID, label: pack.label, version: selected, requiresDownload: true,
      installOptions: { sectionId: pack.id }, detail: "Downloads the selected shader source collection and its license notices." });
    return runDownloadTask(context.downloads, { managerId: ID, sectionId: pack.id, version: selected, label: pack.label,
      kind: "runtime", dedupeKey: `${ID}:${context.userDataDir}:${pack.id}:${selected}` }, async task => {
      const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal,
        root = directory(context.userDataDir, pack.id);
      Writable.assertOwnDirectory(context.userDataDir, root);
      const temporary = fs.mkdtempSync(path.join(root, ".install-")), files = path.join(temporary, "files"); fs.mkdirSync(files);
      let backup, published = false;
      try {
        const downloadContext = { signal, onProgress: task.onProgress || context.onProgress };
        if (pack.delivery === "tree") {
          const tree = await json(`https://api.github.com/repos/${pack.repository}/git/trees/${row.commit}?recursive=1`, signal, dependencies);
          if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 20000) throw new Error("The shader source listing is too large.");
          const selectedFiles = tree.tree.filter(item => item.type === "blob" && safe(item.path) && keep(item.path) &&
            (pack.prefixes.some(prefix => item.path.startsWith(prefix)) || item.path === pack.licenseFile || /^README/i.test(item.path)));
          if (!selectedFiles.length || selectedFiles.length > LIMITS.entries || selectedFiles.some(item => item.size > LIMITS.file) ||
            selectedFiles.reduce((sum, item) => sum + item.size, 0) > LIMITS.expanded)
            throw new Error("The shader source listing is incomplete or oversized.");
          let next = 0;
          const cancellation = new AbortController(), workerSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
          const completed = await Promise.allSettled(Array.from({ length: Math.min(4, selectedFiles.length) }, async () => {
            try { while (next < selectedFiles.length) {
              Downloads.throwIfAborted(workerSignal);
              const item = selectedFiles[next++], target = path.join(files, item.path); fs.mkdirSync(path.dirname(target), { recursive: true });
              await download(`https://raw.githubusercontent.com/${pack.repository}/${row.commit}/${item.path.split("/").map(encodeURIComponent).join("/")}`, target,
                { ...downloadContext, signal: workerSignal }, dependencies, LIMITS.file);
              const bytes = fs.readFileSync(target);
              if (bytes.length !== item.size || crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== item.sha)
                throw new Error("A shader source file does not match its selected Git revision.");
            } } catch (error) { cancellation.abort(); throw error; }
          }));
          const failure = completed.find(row => row.status === "rejected");
          if (failure) throw failure.reason;
        } else {
          const archive = path.join(temporary, "download.zip"), url = row.archive?.url || `https://codeload.github.com/${pack.repository}/zip/${row.commit}`;
          await download(url, archive, downloadContext, dependencies);
          const size = fs.statSync(archive).size;
          if (row.archive?.bytes && size !== row.archive.bytes || row.archive?.sha256 && Native.hashFile(archive) !== row.archive.sha256)
            throw new Error("The shader download does not match its selected version.");
          (dependencies.extract || extract)(archive, files); fs.rmSync(archive);
          if (!fs.existsSync(path.join(files, pack.licenseFile))) {
            const ref = row.commit || row.tag;
            await download(`https://raw.githubusercontent.com/${pack.repository}/${ref}/${pack.licenseFile}`, path.join(files, pack.licenseFile), downloadContext, dependencies, 1 << 20);
          }
        }
        const record = { schema: 1, packId: pack.id, version: selected, source: row, license: pack.license,
          installedAt: new Date().toISOString(), ...discover(files, pack) };
        if (!record.files[pack.licenseFile]) throw new Error("The shader pack license notice is missing.");
        for (const relative of Object.keys(record.files)) fs.chmodSync(path.join(files, relative), 0o444);
        fs.writeFileSync(path.join(temporary, "pack.json"), JSON.stringify(record, null, 2) + "\n");
        Downloads.throwIfAborted(signal);
        const target = installRoot(context.userDataDir, pack.id, selected);
        if (fs.existsSync(target)) { backup = target + ".previous-" + crypto.randomUUID(); fs.renameSync(target, backup); }
        fs.renameSync(temporary, target);
        published = true;
        const result = installed(context.userDataDir, pack.id, selected, true);
        if (!result) throw new Error("The installed shader pack failed its integrity check.");
        if (backup) fs.rmSync(backup, { recursive: true, force: true });
        context.onRuntimeStateChange?.(); return result;
      } catch (error) {
        if (backup) { const target = installRoot(context.userDataDir, pack.id, selected); fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(backup, target); }
        else if (published) fs.rmSync(installRoot(context.userDataDir, pack.id, selected), { recursive: true, force: true });
        throw error;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }, { onProgress: context.onProgress });
  }, { userDataDir: context.userDataDir });
}
async function uninstallRuntime({ userDataDir, sectionId, version: selected, installDir } = {}) {
  const target = installRoot(userDataDir, sectionId, selected);
  if (installDir && path.resolve(installDir) !== target) throw new Error("The selected directory does not belong to this shader pack.");
  Writable.assertOwnDirectory(userDataDir, target, { create: false });
  return withRuntimeMutation({ managerId: ID, sectionId, version: selected, sourcePath: target }, () => {
    fs.rmSync(target, { recursive: true, force: true }); verified.delete(target); return true;
  }, { userDataDir });
}
module.exports = { ID, Catalog, LIMITS, isId, listEffects, resolveEffect, directory, installRoot, installed,
  listInstalled, cached, available, refreshCatalog, installRuntime, uninstallRuntime, states,
  __test: { discover, extract, validRow, safe } };
