const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const GameData = require("../modules/shared/game-data");
const GameStore = require("./game-store");
const Icons = require("./icon-utils");
const GameIcons = require("./game-icons");
const { recordReads, unchanged } = require("./file-observations");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { mergeDetectedEntry } = require("./launch-utils");
const { hydrateGameSaveLocations } = require("./save-locations");
const { resolveModuleId, mergeSettingsChanges } = require("./launcher");
const Installers = require("../modules/shared/installers");
const { prepareModuleInput } = require("../modules/shared/writable-input");

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sourceRoots(entry) {
  return [...new Set([entry.importPath, entry.gamePath, entry.contentRootDir, entry.nativeAppPath,
    entry.containerData?.extractedRoot && path.dirname(path.dirname(entry.containerData.extractedRoot)),
    entry.moduleData?.extractedReady && entry.moduleData?.extractedRoot].filter(value =>
    typeof value === "string" && path.isAbsolute(value)).map(value => {
      try { return fs.statSync(value).isDirectory() ? value : path.dirname(value); } catch { return path.dirname(value); }
    }))];
}
function imagePath(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 ** 2 && Icons.isSupportedImageBuffer(fs.readFileSync(file)) ? file : null;
  } catch { return null; }
}
function createGameMetadataService({ userDataDir, registry, app, ui, logger = console, inputPreparation = Installers.prepareInput, runtimeCoordinator } = {}) {
  runtimeCoordinator ||= require("./runtime-coordinator").coordinatorFor(userDataDir).client();
  const gameLifecycle = require("./game-lifecycle").createGameLifecycle({ userDataDir, coordinator: runtimeCoordinator });
  // Source metadata changes in a development checkout invalidate old analysis.
  const sourceFiles = [__filename, require.resolve("./game-icons"), require.resolve("./icon-utils"),
    require.resolve("./save-locations"), require.resolve("../modules/registry"), require.resolve("../modules/detection"),
    require.resolve("../modules/shared/writable-input"),
    ...["index.js", "inno.js", "inno-header.js", "runtime/innoextract-build.js"].map(name => path.join(__dirname, "../modules/shared/installers", name)),
    ...registry.listModuleIds().flatMap(id => ["main.js", "detect.js", "manifest.json"].map(name => path.join(registry.getModuleDir(id) || "", name)))];
  const profile = hash(["game-metadata-v1", app?.getVersion?.() || null, registry.listModules(), sourceFiles.map(file => {
    try { const stat = fs.statSync(file); return [file, stat.size, stat.mtimeMs]; } catch { return [file, null]; }
  })]);
  function cacheFile(entry) { return path.join(GameData.resolveGameDir(userDataDir, entry.gameId), "metadata.json"); }
  function readCache(entry) {
    try { const file = cacheFile(entry), stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 ** 2 ? readJsonObject(file) : null; } catch { return null; }
  }
  function key(entry, settings) {
    const info = registry.getModuleInfo(resolveModuleId(entry));
    const managerIds = [...new Set(Object.values(info?.runtime?.manager || {}))];
    const mod = registry.getModule(resolveModuleId(entry));
    const sourceData = typeof mod?.metadataCacheKey === "function" ? mod.metadataCacheKey(entry) :
      Object.fromEntries(Object.entries(entry.moduleData || {}).filter(([name]) => /(?:path|dir|root|directory|source|format|kind|generation|extractedReady|gameOnly)$/i.test(name)));
    return hash([entry.importPath, entry.gamePath, entry.contentRootDir, entry.nativeAppPath,
    entry.moduleId, entry.runtimeId, entry.runtimeData, sourceData, entry.containerData,
    settings?.modules?.[resolveModuleId(entry)], managerIds.map(id => [id, settings?.runtimes?.[id]])]); }
  async function selectIcon(entry, mod) {
    let moduleIcon;
    try { moduleIcon = mod?.resolveGameIcon?.(entry, { userDataDir, app, ui, fs, path }); } catch (error) { logger.debug?.("[icons] module lookup", error.message); }
    const moduleDefault = path.join(registry.getModuleDir(resolveModuleId(entry)) || "", "resources", "icon.png");
    return GameIcons.selectIconForEntry({ entry, moduleIconPath: moduleIcon, moduleDefaultIconPath: moduleDefault,
      canRenderPath: imagePath,
      extractCandidate: candidate => {
        const fingerprint = GameIcons.sourceFingerprint(candidate);
        if (!fingerprint) return null;
        const directory = GameData.resolveGameIconsDir(userDataDir, entry.gameId);
        const output = path.join(directory, `icon-${candidate.source}.png`), receipt = output + ".source.json";
        const cached = readJsonObject(receipt);
        if (cached?.fingerprint === fingerprint && imagePath(output)) return output;
        if (cached?.fingerprint === fingerprint && cached.missing === true) return null;
        fs.mkdirSync(directory, { recursive: true });
        let bytes;
        if (candidate.source === "exe") bytes = Icons.extractExeIconPngBuffer(candidate.path);
        else {
          const source = Icons.findAppBundleIconPath(candidate.path);
          if (source) {
            const result = spawnSync("/usr/bin/sips", ["-s", "format", "png", source, "--out", output], { stdio: "ignore", timeout: 10000 });
            if (result.status === 0 && imagePath(output)) { writeJsonAtomic(receipt, { fingerprint }); return output; }
          }
        }
        if (bytes?.length) { fs.writeFileSync(output, bytes); if (imagePath(output)) { writeJsonAtomic(receipt, { fingerprint }); return output; } }
        writeJsonAtomic(receipt, { fingerprint, missing: true }); return null;
      }
    });
  }
  async function refreshEntryOnce(entry, settings, { force = false, findExisting, importing = false, signal, onProgress } = {}) {
    const cache = readCache(entry), cacheKey = key(entry, settings);
    if (!force && cache?.profile === profile && cache.key === cacheKey && Installers.containerSourcesUnchanged(entry.containerData) && unchanged(cache.files)) {
      const merged = mergeDetectedEntry(entry, cache.detected, { now: entry.lastPlayedAt || 0 });
      const result = { ...merged, ...cache.facts, moduleData: { ...merged.moduleData, ...cache.moduleDataPatch } };
      prepareModuleInput(result, registry, { settings, userDataDir, logger, app, ui, readOnly: true, signal });
      return result;
    }
    const originalPath = entry.importPath || entry.gamePath;
    const prepared = await inputPreparation(originalPath, { userDataDir, gameId: entry.gameId, signal, onProgress });
    if (prepared.containerData) entry = { ...entry, containerData: prepared.containerData, contentRootDir: prepared.inputPath };
    const roots = sourceRoots(entry), detectPath = prepared.inputPath;
    const observed = await recordReads({ roots, excluded: [GameData.resolveGameIconsDir(userDataDir, entry.gameId)] }, async () => {
      // The selected source itself must be part of negative/existing observations.
      fs.statSync(detectPath);
      for (const source of entry.containerData?.sources || []) fs.lstatSync(source.path);
      if (entry.containerData?.extractedRoot) {
        const generation = path.dirname(entry.containerData.extractedRoot);
        fs.lstatSync(path.join(generation, "receipt.json"));
        fs.lstatSync(path.join(path.dirname(generation), "current.json"));
      }
      const detected = await registry.detectGameAsync(detectPath, { workerMode: "inline" });
      const existing = findExisting?.(detected);
      if (existing) entry = { ...existing, importPath: existing.importPath || originalPath, containerData: entry.containerData || existing.containerData };
      await gameLifecycle.claim(entry);
      let merged = mergeDetectedEntry(entry, detected, { now: entry.lastPlayedAt || 0 });
      merged.moduleId = resolveModuleId(merged);
      const mod = registry.getModule(merged.moduleId);
      if (typeof mod?.mergeEntry === "function") merged = mod.mergeEntry(existing || (importing ? null : entry), merged, settings);
      if (importing && !existing && typeof mod?.onImport === "function") await mod.onImport(merged, { settings, userDataDir, logger, app, ui });
      const beforeModuleData = { ...merged.moduleData };
      const icon = await selectIcon(merged, mod);
      prepareModuleInput(merged, registry, { settings, userDataDir, logger, app, ui, signal, onProgress, readOnly: !importing });
      merged = hydrateGameSaveLocations(merged, registry, { settings, userDataDir });
      const facts = { defaultSaveDir: merged.defaultSaveDir, saveLocations: merged.saveLocations || [], iconPath: icon.path, iconSource: icon.source };
      const moduleDataPatch = Object.fromEntries(Object.entries(merged.moduleData || {}).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(beforeModuleData[name])));
      return { entry: { ...merged, ...facts }, detected, facts, moduleDataPatch };
    });
    const active = observed.value.entry;
    if (observed.cacheable) writeJsonAtomic(cacheFile(active), { profile, key: key(active, settings), files: observed.files,
      detected: observed.value.detected, facts: observed.value.facts, moduleDataPatch: observed.value.moduleDataPatch });
    const current = entry.gameId && GameStore.readGameRecord(userDataDir, entry.gameId);
    const result = current ? mergeSettingsChanges(entry, active, current) : active;
    if (current && JSON.stringify(current) !== JSON.stringify(result)) GameStore.writeGameRecord(userDataDir, result);
    return result;
  }
  function refreshEntry(entry, settings, options) {
    return gameLifecycle.use(entry, () => refreshEntryOnce(entry, settings, options));
  }
  async function importEntry(inputPath, settings, options = {}) {
    const games = GameStore.loadGames(userDataDir);
    let existing = games.find(entry => [entry.importPath, entry.gamePath].includes(inputPath));
    if (existing) return refreshEntry(existing, settings, options);
    const entry = { gameId: Installers.findCachedInputGameId(userDataDir, inputPath) || GameData.createGameId(), gamePath: inputPath, importPath: inputPath };
    return refreshEntry(entry, settings, { ...options, importing: true, findExisting: detected => games.find(game => game.gamePath === detected.gamePath) });
  }
  return { refreshEntry, importEntry };
}

module.exports = { createGameMetadataService, sourceRoots };
