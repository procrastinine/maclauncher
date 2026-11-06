const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Assets = require("./assets");
const Declarations = require("./rtp-declarations");
const Inno = require("../shared/installers/inno");
const { probeInno } = require("../shared/installers/inno-header");
const { runHelper } = require("../shared/installers/process");
const SevenZip = require("../shared/runtime/sevenzip");
const Bundled = require("../shared/runtime/bundled-native");
const Upstream = require("../shared/runtime/upstream");
const { writeJsonAtomic } = require("../../core/json-files");
const CATALOG = require("./rtp-catalog.json");

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9]{64}-[a-f0-9-]{36}$/;
const LIMITS = Object.freeze({ files: 16384, bytes: 512 * 1024 ** 2, fileBytes: 64 * 1024 ** 2 });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const ordered = (a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0;
const dataset = files => digest(JSON.stringify(files.map(({ relative, size, sha256 }) => ({ relative, size, sha256 })).sort(ordered)));
function immutable(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}

// `identity` holds the recorded file count, bytes and dataset digest.
function validFiles(files, identity) {
  if (!Array.isArray(files) || files.length !== identity.files) return false;
  const names = new Set(); let bytes = 0;
  try {
    for (const file of files) {
      if (!file || Inno.relative(file.relative) !== file.relative || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes ||
          !SHA256.test(file.sha256 || "") || typeof file.identity !== "string" || file.identity.length > 2048) return false;
      const name = file.relative.normalize("NFC").toLowerCase();
      if (names.has(name)) return false;
      names.add(name); bytes += file.size;
    }
    return bytes === identity.bytes && dataset(files) === identity.datasetSha256;
  } catch { return false; }
}

// The publisher's downloads page links each RTP. A link is recognized by the
// RPG Maker generation in its name; the catalog location serves when the page
// names none.
const DOWNLOADS = "https://www.rpgmakerweb.com/downloads";
const GENERATIONS = Object.freeze({ Standard: /(?:^|[^a-z])xp(?:[^a-z]|$)/i, RPGVX: /(?:^|[^a-z])vx(?!\s*-?\s*ace)(?:[^a-z]|$)/i, RPGVXAce: /vx[\s_-]*ace/i });
const source = Upstream.index({ locations: [DOWNLOADS], hosts: ["rpgmakerweb.com"], parse: ([page]) => {
  const rows = [];
  for (const match of page.text.matchAll(/https:\/\/[^"'\s<>]+?\/([^"'\s<>/]*rtp[^"'\s<>/]*\.(?:exe|zip))/gi)) {
    const id = Object.keys(GENERATIONS).find(key => GENERATIONS[key].test(match[1]) && (key !== "RPGVX" || !GENERATIONS.RPGVXAce.test(match[1])));
    if (id && !rows.some(row => row.version === id)) rows.push({ version: id, sourceUrl: DOWNLOADS, files: [{ name: match[1], url: match[0] }] });
  }
  return rows;
} });
async function packDownload(pack, signal) {
  try {
    const listed = (await source.discover({ signal })).find(row => row.version === pack.id)?.files[0];
    if (listed) return listed;
  } catch (error) { if (signal?.aborted) throw error; }
  return Upstream.listedFile({ filename: pack.archive.file, url: pack.sourceUrl });
}

function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.packs) || !catalog.packs.length) throw new Error("RTP download catalog is invalid.");
  const ids = new Set();
  for (const pack of catalog.packs) {
    if (!Declarations.requiredPacks({ moduleData: { rtpDeclarations: [pack.id] } }).includes(pack.id) || ids.has(pack.id) ||
        !/^\d+\.\d+$/.test(pack.version || "") || pack.installVersion !== `rtp-${pack.id.toLowerCase()}-${pack.version}` ||
        !SHA256.test(pack.archive?.sha256 || "") || !SHA256.test(pack.metadataSha256 || "") || !SHA256.test(pack.datasetSha256 || "") ||
        !["inno", "zip"].includes(pack.archive.kind) || !Number.isSafeInteger(pack.archive.size) || pack.archive.size < 1 || pack.archive.size > LIMITS.bytes ||
        !Number.isInteger(pack.files) || pack.files < 1 || pack.files > LIMITS.files || !Number.isSafeInteger(pack.bytes) || pack.bytes < 0 || pack.bytes > LIMITS.bytes ||
        pack.dataProfile !== "official-app-files-v1" || new URL(pack.sourceUrl).protocol !== "https:" || !Array.isArray(pack.outerFiles) || pack.outerFiles.length > 16) throw new Error("RTP download version or checksum is invalid.");
    Inno.relative(pack.archive.file); Inno.relative(pack.setup);
    for (const file of pack.outerFiles) { Inno.relative(file.path); if (!file.isDirectory && (!SHA256.test(file.sha256 || "") || !Number.isSafeInteger(file.size) || file.size > LIMITS.bytes)) throw new Error("RTP archive file identity is invalid."); }
    if (pack.archive.file.includes("/") || pack.archive.kind === "inno" && (pack.setup !== pack.archive.file || pack.outerFiles.length) ||
        pack.archive.kind === "zip" && !pack.outerFiles.some(file => file.path === pack.setup && !file.isDirectory)) throw new Error("RTP installer path is invalid.");
    ids.add(pack.id);
  }
  return catalog;
}

function removeTemporary(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, stat.mode | 0o700);
    for (const name of fs.readdirSync(root)) removeTemporary(path.join(root, name));
    fs.rmdirSync(root);
  } else fs.unlinkSync(root);
}

function readPointer(file) {
  try { return JSON.parse(Bundled.readRegular(file, 4 * 1024 ** 2).bytes.toString("utf8")); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
}

function createRtpStore({ catalog = CATALOG, download = (file, destination, options) => source.download(file, destination, options), execute = runHelper, resolveHelper = Inno.ensureHelper } = {}) {
  catalog = immutable(validateCatalog(structuredClone(catalog)));
  const packs = new Map(catalog.packs.map(pack => [pack.id, pack])), pending = new Map();
  function packFor(id) { const pack = packs.get(id); if (!pack) throw new Error("This RTP pack has no official download in MacLauncher."); return pack; }
  function directory(userDataDir, pack, create = false) {
    const root = path.join(userDataDir, "modules", "rgss", "assets", "rtp-packs", pack.id, pack.version);
    return Bundled.realDirectory(root, { create }) ? root : null;
  }
  async function resolvePack({ userDataDir, id, signal, readOnly = false, force = false, legacyRoots } = {}) {
    signal?.throwIfAborted();
    const pack = packFor(id), root = directory(userDataDir, pack);
    if (root) {
      // Installed data is checked against the identity recorded at installation.
      const pointer = readPointer(path.join(root, "current.json"));
      if (pointer?.schemaVersion === 1 && pointer.id === pack.id && pointer.version === pack.version && SHA256.test(pointer.archiveSha256 || "") &&
          SHA256.test(pointer.datasetSha256 || "") && GENERATION.test(pointer.generation || "") && pointer.generation.startsWith(pointer.datasetSha256 + "-") &&
          Array.isArray(pointer.files) && validFiles(pointer.files, { files: pointer.files.length, datasetSha256: pointer.datasetSha256,
            bytes: pointer.files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0) })) {
        const filesRoot = path.join(root, pointer.generation, "files");
        if (Bundled.realDirectory(filesRoot)) {
          try {
            const expected = pointer.files.map(file => ({ path: file.relative, size: file.size, sha256: file.sha256, identity: force ? null : file.identity }));
            const checked = await Inno.validateOutput(filesRoot, expected, { signal, cached: true, immutable: true });
            const files = checked.map(({ path: relative, ...file }) => ({ relative, ...file })).sort(ordered);
            if (dataset(files) !== pointer.datasetSha256) throw new Error("RTP data checksum changed.");
            if (!readOnly && JSON.stringify(files) !== JSON.stringify(pointer.files)) writeJsonAtomic(path.join(root, "current.json"), { ...pointer, files });
            return { id, version: pack.version, installVersion: pack.installVersion, path: filesRoot, datasetSha256: pointer.datasetSha256, source: "official" };
          } catch (error) { if (signal?.aborted || error.name === "AbortError") throw error; }
        }
      }
    }
    // Existing immutable v3 assets retain their original identity; they are
    // usable without being relabeled as a downloaded official RTP version.
    for (const legacy of legacyRoots || Assets.getLegacyRtpRoots(userDataDir)) {
      const candidate = path.join(legacy, "rtp", id);
      if (Bundled.realDirectory(candidate)) return { id, version: null, path: candidate, source: "legacy" };
    }
    return null;
  }

  // A ZIP download holds the installer: at its usual path, or wherever the
  // publisher moves it, found by its Inno Setup header.
  async function unpackArchive(archive, target, pack, signal) {
    if (!/\.zip$/i.test(archive)) return archive;
    const binary = SevenZip.resolveSevenZipBinary();
    if (!binary) throw new Error("The included archive reader is unavailable.");
    const listed = await execute(binary, ["l", "-ba", "-slt", archive], { signal, timeout: 15000, maximum: 1024 ** 2 });
    const entries = SevenZip.parseSevenZipList(listed.stdout, archive), names = new Set();
    if (entries.length > 64) throw new Error("The RTP archive contains too many files.");
    for (const entry of entries) {
      Inno.relative(entry.path);
      const key = entry.path.normalize("NFC").toLowerCase();
      if (entry.isLink || names.has(key)) throw new Error("The RTP archive contains an unexpected file.");
      names.add(key);
    }
    fs.mkdirSync(target, { mode: 0o700 });
    await execute(binary, ["x", "-y", `-o${target}`, archive], { signal, timeout: 60000, maximum: 1024 ** 2 });
    const installers = entries.filter(entry => !entry.isDirectory && /\.exe$/i.test(entry.path)).sort((a, b) => Number(b.path === pack.setup) - Number(a.path === pack.setup))
      .map(entry => path.join(target, entry.path));
    const found = installers.find(file => { try { Inno.identity(file); return Boolean(probeInno(file)); } catch { return false; } });
    if (!found) throw new Error("The RTP download does not contain the expected installer.");
    return found;
  }

  // A download that matches the catalog's checksum also matches its recorded
  // installer file list; another download is read from its own installer.
  async function inspect(setup, pack, signal, helper, known) {
    const probe = probeInno(setup);
    if (!probe) throw new Error("The RTP download does not contain the expected installer.");
    const sourceIdentity = Inno.identity(setup);
    const result = await execute(helper.inspector, ["--inspect-json", setup], { signal, timeout: 15000, maximum: 4 * 1024 ** 2 });
    if (Inno.identity(setup) !== sourceIdentity) throw new Error("The RTP installer changed during inspection.");
    const metadata = JSON.parse(result.stdout);
    if (known && (metadata.formatVersion !== pack.installerVersion || metadata.productVersion !== pack.version || digest(JSON.stringify(metadata.files)) !== pack.metadataSha256))
      throw new Error("The RTP installer file list does not match its selected version.");
    const files = [], seen = new Map();
    for (const file of metadata.files) {
      const first = seen.get(file.path);
      if (first !== undefined && pack.collision?.path === file.path && files[first].size === pack.collision.sizes[0] && file.size === pack.collision.sizes[1]) {
        // Only the XP installer's declared duplicate is permitted.
        // Inno's overwrite/version rules select the later image; the complete
        // app-files digest below also authenticates the resulting bytes.
        files[first] = file;
      } else { seen.set(file.path, files.length); files.push(file); }
    }
    const info = Inno.validateMetadata({ ...metadata, files }, probe, helper);
    if (info.files.length > LIMITS.files || info.extractedBytes > LIMITS.bytes || info.files.some(file => file.size > LIMITS.fileBytes) || info.requiredSlices.length > 1) throw new Error("The RTP installer exceeds its extraction limits.");
    for (const slice of info.requiredSlices) if (!slice.names.some(name => {
      const file = path.join(path.dirname(setup), name);
      try { Inno.identity(file); return true; } catch { return false; }
    })) throw new Error("The RTP installer companion data is missing.");
    return { helper, info };
  }

  // `archiveFile` is the publisher's installer added by hand in Runtimes →
  // Components; it must match the catalog's SHA-256 and nothing is fetched.
  async function installPack(options = {}) {
    const { userDataDir, id, version, signal, onProgress, archiveFile, ...helperContext } = options;
    const pack = packFor(id);
    if (version && version !== pack.installVersion) throw new Error("The selected RTP download version is invalid.");
    const key = JSON.stringify([path.resolve(userDataDir), id, pack.version]);
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const existing = await resolvePack({ userDataDir, id, signal });
      if (existing) return existing;
      // A chosen installer is checked before anything else is prepared.
      if (archiveFile) {
        const chosen = (await Inno.hashFile(archiveFile, { signal })).sha256;
        if (chosen !== pack.archive.sha256) throw new Error(`The file's SHA-256 is ${chosen}; ${pack.label} ${pack.version} (${pack.archive.file}) is ${pack.archive.sha256}.`);
      }
      const helper = await resolveHelper({ ...helperContext, userDataDir, signal, onProgress });
      const root = directory(userDataDir, pack, true), stage = path.join(root, ".stage-" + crypto.randomUUID());
      fs.mkdirSync(stage, { mode: 0o700 });
      const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      const timer = setTimeout(() => controller.abort(new Error("The RTP download timed out.")), 10 * 60 * 1000); timer.unref();
      let tooLarge = false, unpublished;
      try {
        const file = archiveFile ? { name: pack.archive.file, url: pack.sourceUrl } : await packDownload(pack, controller.signal), archive = path.join(stage, file.name);
        if (archiveFile) await require("../shared/copy-file").cloneOrCopy(archiveFile, archive, { signal: controller.signal });
        else await download(file, archive, { signal: controller.signal, onProgress: progress => {
          if (progress.downloaded > LIMITS.bytes || progress.total != null && progress.total > LIMITS.bytes) { tooLarge = true; controller.abort(); }
          onProgress?.({ ...progress, phase: "downloading", label: pack.label });
        } });
        if (tooLarge) throw new Error("The RTP download exceeds its size limit.");
        // The catalog's checksum identifies the known installer; a replaced
        // installer is read from its own file list and its hash is recorded.
        const archiveSha256 = (await Inno.hashFile(archive, { signal: controller.signal })).sha256, known = archiveSha256 === pack.archive.sha256;
        if (archiveFile && !known) throw new Error(`${pack.label} changed while it was copied.`);
        onProgress?.({ phase: "extracting", label: pack.label });
        const setup = await unpackArchive(archive, path.join(stage, "installer"), pack, controller.signal);
        const { info } = await inspect(setup, pack, controller.signal, helper, known), output = path.join(stage, "output");
        fs.mkdirSync(output, { mode: 0o700 });
        await execute(helper.executable, ["--extract", "--silent", "--progress=false", "--color=false", `--collisions=${pack.collision ? "overwrite" : "error"}`, "--exclude-temp", "--output-dir", output, setup], { signal: controller.signal, timeout: 120000, maximum: 1024 ** 2 });
        await Inno.validateOutput(output, info.files, { signal: controller.signal });
        const filesRoot = path.join(stage, "files"); fs.renameSync(path.join(output, "app"), filesRoot);
        const appFiles = info.files.filter(file => file.path.startsWith("app/")).map(file => ({ path: file.path.slice(4), size: file.size }));
        let files = (await Inno.validateOutput(filesRoot, appFiles, { signal: controller.signal })).map(({ path: relative, ...file }) => ({ relative, ...file })).sort(ordered);
        const datasetSha256 = dataset(files);
        if (!files.length || known && (files.length !== pack.files || files.reduce((sum, file) => sum + file.size, 0) !== pack.bytes || datasetSha256 !== pack.datasetSha256))
          throw new Error("Extracted RTP data does not match its selected version.");
        function freeze(directory) {
          for (const name of fs.readdirSync(directory)) { const file = path.join(directory, name), stat = fs.lstatSync(file); if (stat.isDirectory()) freeze(file); else fs.chmodSync(file, 0o444); }
          fs.chmodSync(directory, 0o555);
        }
        const generation = datasetSha256 + "-" + crypto.randomUUID(), destination = path.join(root, generation);
        controller.signal.throwIfAborted();
        fs.mkdirSync(destination, { mode: 0o700 }); unpublished = destination;
        fs.renameSync(filesRoot, path.join(destination, "files"));
        freeze(path.join(destination, "files"));
        files = files.map(file => ({ ...file, identity: Inno.identity(path.join(destination, "files", file.relative)) }));
        fs.chmodSync(destination, 0o555);
        writeJsonAtomic(path.join(root, "current.json"), { schemaVersion: 1, id, version: pack.version, archiveSha256, integrity: known ? "catalog-sha256" : "recorded-local",
          datasetSha256, dataProfile: pack.dataProfile, sourceUrl: file.url, ...(archiveFile ? { manual: true } : {}), termsUrl: pack.termsUrl, generation, files });
        unpublished = null;
        onProgress?.({ phase: "ready", label: pack.label });
        return { id, version: pack.version, installVersion: pack.installVersion, path: path.join(destination, "files"), datasetSha256, source: "official" };
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); removeTemporary(stage); if (unpublished) removeTemporary(unpublished);
      }
    })();
    pending.set(key, work); try { return await work; } finally { pending.delete(key); }
  }

  async function resolveForEntry(entry, context = {}) {
    const ids = Declarations.requiredPacks(entry, context.runtimeSettings);
    let legacyRoots;
    const values = [];
    for (const id of ids) {
      let value = await resolvePack({ ...context, id, legacyRoots: [] });
      if (!value) {
        legacyRoots ||= Assets.getLegacyRtpRoots(context.userDataDir);
        value = await resolvePack({ ...context, id, legacyRoots });
      }
      values.push(value);
    }
    return { ids, values, paths: values.filter(Boolean).map(value => value.path) };
  }
  async function getRuntimeRequirements(entry, context, { runtimeVersion } = {}) {
    const { ids, values } = await resolveForEntry(entry, context), plans = [];
    for (const value of values.filter(Boolean)) {
      const version = value.installVersion || runtimeVersion;
      // Before MKXP-Z is selected, launch records this use with the selection.
      if (!version) continue;
      context.recordRuntimeUse?.({ managerId: "mkxpz", version, sectionId: "rtp-" + value.id, sourcePath: value.path });
    }
    for (let index = 0; index < ids.length; index++) if (!values[index]) {
      const pack = packFor(ids[index]);
      plans.push({ managerId: "mkxpz", label: pack.label, version: pack.installVersion, requiresDownload: true, installOptions: { rtpPack: pack.id },
        message: `Download ${pack.label} ${pack.version}?`, confirmLabel: "Agree, Download and Play", licenseRequired: true,
        detail: `This game declares ${pack.id}. Download size: ${Math.ceil(pack.archive.size / 1024 ** 2)} MiB. The pack is shared between games. Publisher's RTP terms apply: ${pack.termsUrl}` });
    }
    return plans;
  }
  return { catalog, packFor, resolvePack, resolveForEntry, installPack, getRuntimeRequirements };
}

module.exports = { ...createRtpStore(), createRtpStore, dataset, validateCatalog, LIMITS, source };
