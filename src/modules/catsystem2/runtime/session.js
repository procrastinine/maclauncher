const path = require("node:path");
const Inspect = require("../inspect"), Archive = require("../archive"), Startup = require("../startup");
const Crypto = require("./crypto"), { createAssets } = require("./assets"), { createRegistry } = require("./asset-registry");
const LIMITS = Object.freeze({ indexBytes: 16 * 1024 * 1024, entries: 100000, archives: 256 });

/** A per-game original-data session with lazy, generation-bound archive indexes. */
async function openSession(entry, { resourcesRoot, signal, resolveHelper = Crypto.resolveHelper } = {}) {
  signal?.throwIfAborted();
  const data = Inspect.inspectGame(entry.contentRootDir || entry.gamePath, { inputPath: entry.moduleData?.originalRunnerPath });
  if (!data || data.archives.length > LIMITS.archives) throw new Error("A bounded CatSystem2 original data directory is required.");
  const settings = await Startup.readStartup(data.dataRoot), archives = [], pending = new Map();
  let helper, seed, indexBytes = 0, entries = 0, closed = false;
  if (data.archives.some(archive => archive.encrypted)) { helper = await resolveHelper({ resourcesRoot }); seed = await Archive.readTocSeed(data.originalRunnerPath, helper, { signal }); }
  async function archiveIndex(name) {
    signal?.throwIfAborted(); if (closed) throw new Error("The CatSystem2 data session is closed.");
    const basename = path.posix.basename(Startup.memberPath(name)), key = basename.toLowerCase();
    const candidates = data.archives.filter(archive => path.basename(archive.path).toLowerCase() === key);
    if (candidates.length !== 1) throw new Error("CatSystem2 authored archive is absent or ambiguous.");
    if (!pending.has(key)) {
      const operation = (async () => {
        const archive = await Archive.inspectArchive(candidates[0].path, { helper, tocSeed: seed, maximumIndexBytes: Archive.LIMITS.indexBytes, signal });
        const nextBytes = indexBytes + archive.indexBytes, nextEntries = entries + archive.entries.length;
        if (closed || nextBytes > LIMITS.indexBytes || nextEntries > LIMITS.entries) { Archive.releaseArchive(archive); throw new Error("CatSystem2 archive indexes exceed their session limit."); }
        archives.push(archive); indexBytes = nextBytes; entries = nextEntries; return archive;
      })();
      pending.set(key, operation); operation.catch(() => pending.delete(key));
    }
    return pending.get(key);
  }
  const assets = createAssets({ dataRoot: data.dataRoot, archives, signal }), registry = createRegistry({ document: settings.document, assets: { ...assets, read }, archiveIndex, language: settings.language });
  async function read(name, options) {
    signal?.throwIfAborted(); if (closed) throw new Error("The CatSystem2 data session is closed.");
    if (/^[^/]+\.int\//i.test(name)) await archiveIndex(name.split("/")[0]); return assets.read(name, options);
  }
  async function exists(name) {
    signal?.throwIfAborted(); if (closed) throw new Error("The CatSystem2 data session is closed.");
    Startup.memberPath(name);
    if (/^[^/]+\.int\//i.test(name)) {
      const archive = name.split("/")[0], candidates = data.archives.filter(item => path.basename(item.path).toLowerCase() === archive.toLowerCase());
      if (!candidates.length) return false; await archiveIndex(archive);
    }
    return assets.exists(name);
  }
  async function close() {
    closed = true; await Promise.allSettled(pending.values()); for (const archive of archives) Archive.releaseArchive(archive); pending.clear(); archives.length = 0;
  }
  return { data, settings, archives, assets: { ...assets, read, exists }, registry, archiveIndex, helper, close };
}
module.exports = { LIMITS, openSession };
