const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { applyGameName } = require("./game-name");
const GameData = require("../modules/shared/game-data");
const GameStore = require("./game-store");
const Icons = require("./icon-utils");
const GameIcons = require("./game-icons");
const { recordReads, unchanged } = require("./file-observations");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { mergeDetectedEntry, detectedNativeRuntime } = require("./launch-utils");
const { hydrateGameSaveLocations } = require("./save-locations");
const { resolveModuleId, mergeSettingsChanges } = require("./launcher");
const Installers = require("../modules/shared/installers");
const GameAvailability = require("./game-availability");
const Relocation = require("./game-relocation");
const GameCommands = require("../main/game-command");
const { prepareModuleInput, atomicWrite, assertOwnDirectory } = require("../modules/shared/writable-input");
const { throwIfAborted, isAbortError } = require("../modules/shared/runtime/download-utils");

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sourceRoots(entry) {
  return [...new Set([entry.importPath, entry.gamePath, entry.contentRootDir, entry.releaseRootDir, entry.nativeAppPath,
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
function createGameMetadataService({ userDataDir, registry, app, ui, logger = console, inputPreparation = Installers.prepareInput,
  extractIcon = require("./icon-extraction").extractIcon, runtimeCoordinator, downloads, confirmRuntimeInstall, onRuntimeStateChange } = {}) {
  runtimeCoordinator ||= require("./runtime-coordinator").coordinatorFor(userDataDir).client();
  const gameLifecycle = require("./game-lifecycle").createGameLifecycle({ userDataDir, coordinator: runtimeCoordinator });
  function debug(message, error) {
    try { logger.debug?.(message, error?.message || String(error))?.catch?.(() => {}); } catch {}
  }
  // Source metadata changes in a development checkout invalidate old analysis.
  const sourceFiles = [__filename, require.resolve("./game-icons"), require.resolve("./icon-utils"), require.resolve("./icon-extraction"),
    require.resolve("./save-locations"), require.resolve("./game-name"), require.resolve("../modules/registry"), require.resolve("../modules/detection"), require.resolve("../modules/shared/web/release-root"),
    require.resolve("../modules/shared/writable-input"),
    ...["index.js", "inno.js", "inno-header.js", "runtime/innoextract-manager.js"].map(name => path.join(__dirname, "../modules/shared/installers", name)),
    ...registry.listModuleIds().flatMap(id => {
      const directory = registry.getModuleDir(id) || "", sources = registry.getModule(id)?.metadataSources;
      return ["main.js", "detect.js", "manifest.json", ...(Array.isArray(sources) ? sources.slice(0, 32) : [])]
        .filter(name => typeof name === "string" && name.length <= 1024 && !name.includes("\0") && !path.isAbsolute(name))
        .map(name => path.resolve(directory, name));
    })];
  const profile = hash(["game-metadata-v1", app?.getVersion?.() || null, registry.listModules(), [...new Set(sourceFiles)].map(file => {
    try { const stat = fs.statSync(file); return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; } catch { return [file, null]; }
  })]);
  function cacheFile(entry) { return path.join(GameData.resolveGameDir(userDataDir, entry.gameId), "metadata.json"); }
  function readCache(entry) {
    try { const file = cacheFile(entry), stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 ** 2 ? readJsonObject(file) : null; } catch { return null; }
  }
  function key(entry, settings) {
    const info = registry.getModuleInfo(resolveModuleId(entry));
    const managerIds = [...new Set(Object.values(info?.runtime?.manager || {}))];
    const mod = registry.getModule(resolveModuleId(entry));
    const sourceData = typeof mod?.metadataCacheKey === "function" ? mod.metadataCacheKey(entry, { userDataDir, app, settings }) :
      Object.fromEntries(Object.entries(entry.moduleData || {}).filter(([name]) => /(?:path|dir|root|directory|source|format|kind|generation|extractedReady|gameOnly)$/i.test(name)));
    return hash([entry.importPath, entry.gamePath, entry.contentRootDir, entry.nativeAppPath, entry.iconPath, entry.iconSource,
    entry.moduleId, entry.runtimeId, entry.runtimeData, sourceData, entry.containerData,
    settings?.modules?.[resolveModuleId(entry)], managerIds.map(id => [id, settings?.runtimes?.[id]])]); }
  async function selectIcon(entry, mod, settings, signal) {
    let moduleIcon;
    try { moduleIcon = await mod?.resolveGameIcon?.(entry, { userDataDir, settings, app, ui, fs, path, signal }); }
    catch (error) { throwIfAborted(signal); if (isAbortError(error)) throw error; debug("[icons] module lookup", error); }
    throwIfAborted(signal);
    const moduleDefault = path.join(registry.getModuleDir(resolveModuleId(entry)) || "", "resources", "icon.png");
    return GameIcons.selectIconForEntry({ entry, moduleIconPath: moduleIcon, moduleDefaultIconPath: moduleDefault,
      canRenderPath: imagePath, signal,
      extractCandidate: async candidate => {
        throwIfAborted(signal);
        const fingerprint = GameIcons.sourceFingerprint(candidate);
        if (!fingerprint) return null;
        const directory = GameData.resolveGameIconsDir(userDataDir, entry.gameId);
        const output = path.join(directory, `icon-${candidate.source}.png`), receipt = output + ".source.json";
        const cached = readJsonObject(receipt);
        if (cached?.fingerprint === fingerprint && imagePath(output)) return output;
        if (cached?.fingerprint === fingerprint && cached.missing === true) return null;
        assertOwnDirectory(userDataDir, directory);
        const bytes = (await extractIcon(candidate.path, candidate.source, { signal }))?.png;
        throwIfAborted(signal);
        if (bytes?.length) { atomicWrite(output, bytes, { root: userDataDir }); if (imagePath(output)) { writeJsonAtomic(receipt, { fingerprint }); return output; } }
        writeJsonAtomic(receipt, { fingerprint, missing: true }); return null;
      }
    });
  }
  async function refreshEntryOnce(entry, settings, { force = false, findExisting, relocate, previous, importing = false, signal, onProgress } = {}) {
    const cache = readCache(entry), cacheKey = key(entry, settings);
    const previousName = cache?.automaticName || cache?.facts?.name || cache?.detected?.name;
    const customName = entry.name && previousName && entry.name !== previousName ? entry.name : null;
    if (!force && cache?.profile === profile && cache.key === cacheKey && Installers.containerSourcesUnchanged(entry.containerData) && unchanged(cache.files)) {
      const merged = mergeDetectedEntry(entry, cache.detected, { now: entry.lastPlayedAt || 0 });
      let result = { ...merged, ...cache.facts, moduleData: { ...merged.moduleData, ...cache.moduleDataPatch } };
      const mod = registry.getModule(resolveModuleId(result));
      if (typeof mod?.mergeEntry === "function") result = mod.mergeEntry(entry, result, settings, { userDataDir });
      if (customName) result.name = customName;
      prepareModuleInput(result, registry, { settings, userDataDir, logger, app, ui, readOnly: true, signal });
      return result;
    }
    const originalPath = entry.importPath || entry.gamePath;
    const prepared = await inputPreparation(originalPath, { userDataDir, gameId: entry.gameId, signal, onProgress,
      entry, settings, logger, downloads, confirmRuntimeInstall, onRuntimeStateChange });
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
      if (relocate) entry = relocate(entry, detected);
      await gameLifecycle.claim(entry);
      let merged = mergeDetectedEntry(entry, detected, { now: entry.lastPlayedAt || 0 });
      merged.moduleId = resolveModuleId(merged);
      const mod = registry.getModule(merged.moduleId);
      if (typeof mod?.mergeEntry === "function") merged = mod.mergeEntry(existing || (importing ? null : entry), merged, settings, { userDataDir });
      if (importing && !existing && (merged.nativeAppPath || /\.app$/i.test(merged.gamePath || ""))) {
        const native = detectedNativeRuntime(null, detected, registry.getModuleInfo(merged.moduleId), settings?.modules?.[merged.moduleId]);
        if (native) merged.runtimeId = native;
      }
      if (importing && !existing && typeof mod?.onImport === "function") await mod.onImport(merged, { settings, userDataDir, logger, app, ui });
      const beforeModuleData = { ...merged.moduleData };
      let metadata;
      try { metadata = await mod?.resolveGameMetadata?.(merged, { userDataDir, settings, app, ui, logger, signal }); }
      catch (error) { throwIfAborted(signal); if (isAbortError(error)) throw error; debug("[metadata] module lookup", error); }
      if (metadata) {
        merged = { ...merged, ...metadata, moduleData: { ...merged.moduleData, ...metadata.moduleData } };
        if (typeof mod?.mergeEntry === "function") merged = mod.mergeEntry(existing || (importing ? null : entry), merged, settings, { userDataDir });
      }
      merged = applyGameName(merged, { metadata: Boolean(metadata?.name) });
      const automaticName = applyGameName({ ...merged, name: metadata?.name || detected.name }, { metadata: Boolean(metadata?.name) }).name;
      if (customName) merged.name = customName;
      const icon = await selectIcon(merged, mod, settings, signal);
      prepareModuleInput(merged, registry, { settings, userDataDir, logger, app, ui, signal, onProgress, readOnly: !importing });
      merged = hydrateGameSaveLocations(merged, registry, { settings, userDataDir });
      const facts = { name: merged.name, defaultSaveDir: merged.defaultSaveDir, saveLocations: merged.saveLocations || [], iconPath: icon.path, iconSource: icon.source };
      const moduleDataPatch = Object.fromEntries(Object.entries(merged.moduleData || {}).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(beforeModuleData[name])));
      return { entry: { ...merged, ...facts }, detected, facts, moduleDataPatch, automaticName };
    });
    const active = observed.value.entry;
    throwIfAborted(signal);
    if (observed.cacheable) {
      try { writeJsonAtomic(cacheFile(active), { profile, key: key(active, settings), files: observed.files,
        detected: observed.value.detected, facts: observed.value.facts, moduleDataPatch: observed.value.moduleDataPatch, automaticName: observed.value.automaticName }); }
      catch (error) { throwIfAborted(signal); if (isAbortError(error)) throw error; debug("[metadata] cache write", error); }
    }
    const current = entry.gameId && GameStore.readGameRecord(userDataDir, entry.gameId);
    // A relocated game's changes are measured from the record it replaces.
    const result = current ? mergeSettingsChanges(previous || entry, active, current) : active;
    if (current && JSON.stringify(current) !== JSON.stringify(result)) GameStore.writeGameRecord(userDataDir, result);
    return result;
  }
  async function refreshEntry(entry, settings, options) {
    // A library game whose drive or folder is missing keeps its stored facts.
    // Detection never runs against the absent path, so it cannot re-detect it.
    if (options?.importing !== true) {
      const availability = options?.availability || await GameAvailability.checkGameAvailability(entry, { userDataDir });
      if (!availability.available) throw GameAvailability.unavailableError(availability);
    }
    return gameLifecycle.use(entry, () => refreshEntryOnce(entry, settings, options));
  }
  async function importEntry(inputPath, settings, options = {}) {
    const games = GameStore.loadGames(userDataDir);
    let existing = games.find(entry => [entry.importPath, entry.gamePath].includes(inputPath));
    if (existing) return refreshEntry(existing, settings, options);
    const entry = { gameId: Installers.findCachedInputGameId(userDataDir, inputPath) || GameData.createGameId(), gamePath: inputPath, importPath: inputPath };
    return refreshEntry(entry, settings, { ...options, importing: true, findExisting: detected => games.find(game => game.gamePath === detected.gamePath) });
  }
  // Locate… runs the import's detection at the chosen location. A result of
  // the game's own type replaces its paths and detected data, while its game
  // ID, settings and launcher data stay.
  async function relocateEntry(entry, inputPath, settings, options = {}) {
    const previous = entry?.gameId && GameStore.readGameRecord(userDataDir, entry.gameId);
    if (!previous) throw Object.assign(new Error("Game not found in library."), { code: "GAME_NOT_FOUND" });
    const target = Relocation.target(previous, inputPath, { userDataDir });
    return gameLifecycle.use(previous, async () => {
      let records, result, copies;
      try {
        let base = previous;
        // Container readers validate source receipts before engine detection.
        // Move those references first, then restore them if detection refuses
        // the selected source. Byte verification remains the reader's job; a
        // copy it unpacks for the selected source is removed on refusal.
        if (target.field === "importPath") {
          copies = Relocation.containerCopies(userDataDir, previous.gameId);
          const moves = Relocation.sourceMoves(previous, target);
          records = Relocation.rebaseStoredRecords({ userDataDir, gameId: previous.gameId, moves });
          base = moves.reduce((value, move) => Relocation.rebaseRecord(value, move.from, move.to), previous);
        }
        result = await refreshEntryOnce({ ...base, ...target.paths }, settings, { ...options, force: true, previous,
          relocate: (base, detected) => {
            const adopted = Relocation.adopt(base, detected, { ...target, previous, registry, games: GameStore.loadGames(userDataDir) });
            records ||= Relocation.rebaseStoredRecords({ userDataDir, gameId: previous.gameId, from: target.from, to: adopted[target.field] });
            return GameCommands.rememberGameCommandPaths(adopted, previous);
          } });
      } catch (error) {
        records?.restore();
        if (copies) Relocation.removeAddedContainerCopies(userDataDir, previous.gameId, copies);
        throw error;
      }
      if (!GameStore.readGameRecord(userDataDir, previous.gameId)) throw Object.assign(new Error("Game not found in library."), { code: "GAME_NOT_FOUND" });
      let desktopDir;
      try { desktopDir = app?.getPath?.("desktop"); } catch {}
      GameCommands.relocateGameCommands({ userDataDir, gameId: previous.gameId, from: target.from, to: result[target.field], desktopDir });
      records?.commit();
      return result;
    });
  }
  return { refreshEntry, importEntry, relocateEntry };
}

module.exports = { createGameMetadataService, sourceRoots };
