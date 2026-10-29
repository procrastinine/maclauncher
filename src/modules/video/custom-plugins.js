const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Zip = require("../shared/runtime/zip");
const { downloadToFile, decodeResponseBody } = require("../shared/runtime/download-utils");
const { runDownloadTask } = require("../shared/runtime/download-manager");
const Transport = require("../shared/runtime/github-transport");
const { snapshotVersionLabel } = require("./plugin-sources");
const Writable = require("../shared/writable-input");
const MAX_BYTES = 64 * 1024 * 1024;
const validId = id => /^custom-[a-f0-9]{24}$/.test(id || "");
const safeRelative = value => typeof value === "string" && value.length > 0 && !/[\\\0\r\n]/.test(value) && !path.isAbsolute(value) && value.split("/").every(part => part && part !== "." && part !== "..");

function create({ storageRoot, inventory, hash, ...dependencies }) {
  function directory(userDataDir, id) {
    if (!validId(id)) throw new Error("The selected plugin is unavailable.");
    const root = path.join(storageRoot(userDataDir), "custom"), target = path.join(root, id);
    for (const file of [root, target]) {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("mpv plugin folders must be local directories.");
    }
    return target;
  }
  function read(userDataDir, id, { full = false } = {}) {
    try {
      const installDir = directory(userDataDir, id), metadata = path.join(installDir, "plugin.json"), stat = fs.lstatSync(metadata);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
      const record = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (record.schema !== 1 || record.id !== id || !Array.isArray(record.files) || !record.files.length || record.files.length > 512 ||
          !Array.isArray(record.scripts) || !record.scripts.length || !record.scripts.every(safeRelative) || typeof record.label !== "string") return null;
      let ready = true;
      for (const file of record.files) {
        if (!safeRelative(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 || "")) return null;
        const target = path.join(installDir, file.path), stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || !fs.realpathSync(target).startsWith(fs.realpathSync(installDir) + path.sep) || full && hash(target) !== file.sha256) ready = false;
      }
      for (const script of record.scripts) {
        const target = path.join(installDir, script), stat = fs.statSync(target, { throwIfNoEntry: false });
        if (!stat || !(stat.isFile() && /\.(lua|js)$/i.test(script) || stat.isDirectory() && ["main.lua", "main.js"].some(name => fs.statSync(path.join(target, name), { throwIfNoEntry: false })?.isFile()))) ready = false;
      }
      return { ...record, ready, removable: true, installDir, source: "custom", scriptPaths: record.scripts.map(script => path.join(installDir, script)),
        ...(!ready ? { reason: "The installed plugin is incomplete or changed. Remove it and add the source again." } : {}) };
    } catch { return null; }
  }
  function list(userDataDir, options) {
    if (!userDataDir) return [];
    const root = path.join(storageRoot(userDataDir), "custom"), stat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return [];
    return fs.readdirSync(root).filter(validId).map(id => read(userDataDir, id, options)).filter(Boolean).sort((a, b) => a.label.localeCompare(b.label));
  }
  async function sourceFor(source, signal) {
    if (typeof source !== "string" || !source.trim() || /[\0\r\n]/.test(source)) throw new Error("A plugin URL or absolute local path is required.");
    source = source.trim();
    if (path.isAbsolute(source)) return { local: source, label: path.basename(source).replace(/\.(lua|js|zip)$/i, ""), sourceUrl: null };
    let url;try { url = new URL(source); } catch { throw new Error("A plugin URL or absolute local path is required."); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Plugins require an HTTP or HTTPS URL without embedded credentials.");
    const known = await require("./plugin-sources").resolveKnownSource(source, { signal }, dependencies);
    if (known) return known;
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts.length >= 4 && parts[2] === "blob") {
      url = new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`);
    } else if (url.hostname === "github.com" && (parts.length === 2 || parts.length >= 4 && parts[2] === "tree")) {
      const owner = parts[0], repo = parts[1].replace(/\.git$/, ""), ref = parts[2] === "tree" ? parts.slice(3).join("/") : "HEAD";
      const response = await (dependencies.request || Transport.request)(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`, { signal, headers: { Accept: "application/vnd.github+json" } });
      if (response.status !== 200) throw new Error("The GitHub plugin revision could not be resolved. A direct script or ZIP URL can also be used.");
      const data = JSON.parse(decodeResponseBody(response.body, response.headers).toString("utf8"));
      const revision = data.sha;
      if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("The GitHub plugin revision is invalid.");
      return { url: `https://codeload.github.com/${owner}/${repo}/zip/${revision}`, label: repo, archive: true, sourceUrl: `https://github.com/${owner}/${repo}`, updateSource: source, upstreamRevision: revision, versionLabel: snapshotVersionLabel(data) };
    }
    const extension = path.extname(url.pathname).toLowerCase();
    if (![".lua", ".js", ".zip"].includes(extension)) throw new Error("Use a Lua script, JavaScript script, ZIP download or GitHub repository URL.");
    return { url: url.href, label: decodeURIComponent(path.basename(url.pathname, extension)), archive: extension === ".zip", extension, sourceUrl: source, updateSource: source };
  }
  async function extract(archive, payload, signal) {
    const fd = fs.openSync(archive, "r");let entries;
    try { const info = Zip.findZipEocd(fd);if (!info || info.entries > 512) throw new Error("The plugin ZIP has too many files or is invalid.");entries = Zip.readCentralDirectory(fd, info, { metadata: true });if (entries.length !== info.entries) throw new Error("The plugin ZIP is incomplete."); }
    finally { fs.closeSync(fd); }
    let total = 0;const seen = new Set();
    for (const entry of entries) {
      const name = entry.name.replace(/\/$/, "");
      if (!safeRelative(name) || seen.has(name)) throw new Error("The plugin ZIP contains an unsafe or duplicate path.");
      seen.add(name);
      if (entry.name.endsWith("/")) continue;
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > MAX_BYTES) throw new Error("The plugin exceeds its package size limit.");
      const target = path.join(payload, name);fs.mkdirSync(path.dirname(target), { recursive: true });
      await Zip.extractZipEntry(archive, entry, target, { maxOutputBytes: MAX_BYTES, signal });
      const mode = entry.externalAttributes >>> 16;
      if (mode & 0o111) fs.chmodSync(target, 0o755);
    }
  }
  function scriptPaths(payload, supplied) {
    if (supplied) {
      if (!safeRelative(supplied)) throw new Error("The plugin script path must be relative to its package.");
      const target = path.join(payload, supplied), stat = fs.statSync(target, { throwIfNoEntry: false });
      if (!stat || !(stat.isFile() && /\.(lua|js)$/i.test(target) || stat.isDirectory() && ["main.lua", "main.js"].some(name => fs.statSync(path.join(target, name), { throwIfNoEntry: false })?.isFile()))) throw new Error("The selected plugin script was not found in its package.");
      return [supplied];
    }
    const entries = fs.readdirSync(payload, { withFileTypes: true });
    const scriptsDir = path.join(payload, "scripts");
    if (fs.statSync(scriptsDir, { throwIfNoEntry: false })?.isDirectory()) {
      const scripts = fs.readdirSync(scriptsDir, { withFileTypes: true }).filter(item => item.isFile() && /\.(lua|js)$/i.test(item.name) || item.isDirectory() && ["main.lua", "main.js"].some(name => fs.statSync(path.join(scriptsDir, item.name, name), { throwIfNoEntry: false })?.isFile()));
      if (scripts.length) return scripts.map(item => `scripts/${item.name}`);
    }
    if (["main.lua", "main.js"].some(name => fs.statSync(path.join(payload, name), { throwIfNoEntry: false })?.isFile())) return ["."];
    const scripts = entries.filter(item => item.isFile() && /\.(lua|js)$/i.test(item.name));
    if (scripts.length) return scripts.map(item => item.name);
    throw new Error("No mpv entry script was found. Supply its relative script path when adding the plugin.");
  }
  async function install({ source, scriptPath, label, userDataDir, downloads, signal, onProgress, enabled = true, previous } = {}) {
    const root = path.join(storageRoot(userDataDir), "custom");
    const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error("mpv plugin folders must be local directories.");
    fs.mkdirSync(root, { recursive: true });
    return runDownloadTask(downloads, { managerId: "mpv-plugins", sectionId: "custom", label: "Add mpv plugin", kind: "mpv-plugin" }, async task => {
      const limit = new AbortController(), signals = [signal, task.signal, limit.signal].filter(Boolean), combined = AbortSignal.any(signals);
      const resolved = await sourceFor(source, combined);
      if (previous?.ready && previous.upstreamRevision && previous.upstreamRevision === resolved.upstreamRevision)
        return { ...previous, updated: false };
      const stage = fs.mkdtempSync(path.join(root, ".install-")), payload = path.join(stage, "payload");fs.mkdirSync(payload);
      try {
        if (resolved.local) {
          const stat = fs.lstatSync(resolved.local);
          if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error("The plugin source must be a regular file or folder.");
          if (stat.isDirectory()) {
            inventory(resolved.local);
            fs.cpSync(resolved.local, payload, { recursive: true });
          } else if (/\.zip$/i.test(resolved.local)) await extract(resolved.local, payload, combined);
          else if (/\.(lua|js)$/i.test(resolved.local)) fs.copyFileSync(resolved.local, path.join(payload, path.basename(resolved.local)));
          else throw new Error("Choose a Lua script, JavaScript script, ZIP package or plugin folder.");
        } else {
          const downloaded = path.join(stage, resolved.archive ? "download.zip" : `plugin${resolved.extension}`);
          await (dependencies.downloadToFile || downloadToFile)(resolved.url, downloaded, { signal: combined, headers: { "User-Agent": "MacLauncher" }, onProgress: progress => {
            if (progress.downloaded > MAX_BYTES || progress.total > MAX_BYTES) limit.abort(new Error("The plugin download exceeds its size limit."));
            task.onProgress(progress);
          } });
          if (fs.statSync(downloaded).size > MAX_BYTES) throw new Error("The plugin download exceeds its size limit.");
          if (resolved.bytes != null && fs.statSync(downloaded).size !== resolved.bytes || resolved.sha256 && hash(downloaded) !== resolved.sha256)
            throw new Error("The plugin download failed its checksum check.");
          if (resolved.archive) await extract(downloaded, payload, combined);
          else fs.renameSync(downloaded, path.join(payload, `${resolved.label}${resolved.extension}`));
        }
        // GitHub archives wrap the package in a single revision-named folder.
        let packageRoot = payload;
        const roots = fs.readdirSync(payload, { withFileTypes: true }).filter(item => item.name !== "__MACOSX" && item.name !== ".DS_Store");
        if (roots.length === 1 && roots[0].isDirectory()) packageRoot = path.join(payload, roots[0].name);
        for (const asset of resolved.extraAssets || []) {
          if (!safeRelative(asset.relative)) throw new Error("The plugin asset path is invalid.");
          const destination = path.join(packageRoot, asset.relative);fs.mkdirSync(path.dirname(destination), { recursive: true });
          await (dependencies.downloadToFile || downloadToFile)(asset.url, destination, { signal: combined, headers: { "User-Agent": "MacLauncher" }, onProgress: task.onProgress });
          if (fs.statSync(destination).size > MAX_BYTES || asset.bytes != null && fs.statSync(destination).size !== asset.bytes || asset.sha256 && hash(destination) !== asset.sha256)
            throw new Error("The plugin resource download failed its checksum check.");
        }
        const scripts = scriptPaths(packageRoot, scriptPath), published = path.join(stage, "published");
        inventory(packageRoot);
        fs.mkdirSync(published);fs.renameSync(packageRoot, path.join(published, "content"));packageRoot = published;
        const files = inventory(packageRoot), scriptEntries = scripts.map(script => script === "." ? "content" : `content/${script}`);
        const version = crypto.createHash("sha256").update(JSON.stringify({ files, scripts: scriptEntries })).digest("hex"), id = `custom-${version.slice(0, 24)}`;
        const target = directory(userDataDir, id), existing = read(userDataDir, id, { full: true });
        const sourceKey = resolved.local ? fs.realpathSync(resolved.local) : resolved.updateSource || source.trim();
        if (existing?.ready) {
          const metadata = path.join(target, "plugin.json"), record = JSON.parse(fs.readFileSync(metadata, "utf8"));
          Object.assign(record, { sourceKey, updateSource: sourceKey, entryScript: scriptPath || null,
            sourceUrl: resolved.sourceUrl, upstreamRevision: resolved.upstreamRevision || null, versionLabel: resolved.versionLabel || null });
          Writable.atomicWrite(metadata, JSON.stringify(record, null, 2) + "\n", { root: userDataDir });
          const selectedEnabled = previous && enabled === false && previous.id !== id ? existing.enabled !== false : enabled;
          setEnabled({ userDataDir, id, enabled: selectedEnabled });
          for (const prior of enabled === true ? list(userDataDir) : []) if (prior.id !== id && (prior.sourceKey === sourceKey || prior.id === previous?.id) && prior.enabled !== false && prior.ready)
            setEnabled({ userDataDir, id: prior.id, enabled: false });
          return { ...read(userDataDir, id, { full: true }), updated: previous ? previous.id !== id : undefined };
        }
        const name = typeof label === "string" && label.trim() ? label.trim() : resolved.label;
        if (!name || name.length > 200 || /[\0\r\n]/.test(name)) throw new Error("The plugin name is invalid.");
        const record = { schema: 1, id, label: name, version, versionLabel: resolved.versionLabel || null, enabled: enabled === true, sourceKey,
          updateSource: sourceKey, entryScript: scriptPath || null, sourceUrl: resolved.sourceUrl, upstreamRevision: resolved.upstreamRevision || null,
          installedAt: new Date().toISOString(), scripts: scriptEntries, files };
        fs.writeFileSync(path.join(packageRoot, "plugin.json"), JSON.stringify(record, null, 2) + "\n");
        combined.throwIfAborted();
        if (fs.existsSync(target)) throw new Error("An incomplete copy of this plugin is installed. Remove it before adding it again.");
        fs.renameSync(packageRoot, target);
        for (const prior of enabled === true ? list(userDataDir) : []) if (prior.id !== id && (prior.sourceKey === sourceKey || prior.id === previous?.id) && prior.enabled !== false && prior.ready)
          setEnabled({ userDataDir, id: prior.id, enabled: false });
        return { ...read(userDataDir, id, { full: true }), updated: previous ? previous.id !== id : undefined };
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }, { onProgress });
  }
  function setEnabled({ userDataDir, id, enabled }) {
    const record = read(userDataDir, id, { full: true });
    if (!record?.ready) throw new Error("The plugin must be installed before it can be enabled.");
    const file = path.join(directory(userDataDir, id), "plugin.json"), value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.enabled = enabled === true;Writable.atomicWrite(file, JSON.stringify(value, null, 2) + "\n", { root: userDataDir });return true;
  }
  function remove({ userDataDir, id }) { fs.rmSync(directory(userDataDir, id), { recursive: true, force: true });return true; }
  function update({ id, ...context }) {
    const previous = read(context.userDataDir, id, { full: true });
    if (!previous?.ready) throw new Error("The plugin must be installed before it can be updated.");
    const source = previous.updateSource || previous.sourceKey || previous.sourceUrl;
    if (!source) throw new Error("This plugin has no saved update source. Add its source again.");
    const scriptPath = previous.entryScript || (previous.scripts.length === 1 && previous.scripts[0] !== "content" ? previous.scripts[0].replace(/^content\//, "") : undefined);
    return (dependencies.installRuntime || install)({ ...context, source, scriptPath, label: previous.label, enabled: previous.enabled !== false, previous });
  }
  return { list, read, install, update, setEnabled, remove };
}
module.exports = { create, validId };
