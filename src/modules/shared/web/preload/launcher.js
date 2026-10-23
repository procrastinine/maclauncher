const { contextBridge, ipcRenderer, webUtils } = require("electron");

const activitySubscribers = new Set();
const activityListener = (_event, message) => {
  if (!Number.isSafeInteger(message?.sequence) || !message?.activity) return;
  let failed = false, failure;
  try {
    for (const subscription of [...activitySubscribers]) {
      if (!activitySubscribers.has(subscription)) continue;
      try { subscription.callback(message.activity); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  } finally { ipcRenderer.send("launcher:activityAck", message.sequence); }
  if (failed) throw failure;
};

function subscribeActivity(callback) {
  const subscription = { callback };
  activitySubscribers.add(subscription);
  if (activitySubscribers.size === 1) {
    ipcRenderer.on("launcher:activity", activityListener);
    ipcRenderer.send("launcher:activityReady");
  }
  return () => {
    if (!activitySubscribers.delete(subscription)) return;
    if (activitySubscribers.size === 0) {
      ipcRenderer.removeListener("launcher:activity", activityListener);
      ipcRenderer.send("launcher:activityStopped");
    }
  };
}

contextBridge.exposeInMainWorld("MacLauncher", {
  launcher: {
    getState: () => ipcRenderer.invoke("launcher:getState"),
    openUtilityWindow: request => ipcRenderer.invoke("launcher:openUtilityWindow", request),
    steamState: () => ipcRenderer.invoke("launcher:steamState"),
    steamScan: () => ipcRenderer.invoke("launcher:steamScan"),
    steamImport: ids => ipcRenderer.invoke("launcher:steamImport", ids),
    steamImportDownload: id => ipcRenderer.invoke("launcher:steamImportDownload", id),
    steamConnect: credentials => ipcRenderer.invoke("launcher:steamConnect", credentials),
    steamSelectAccount: id => ipcRenderer.invoke("launcher:steamSelectAccount", id),
    steamRemoveAccount: id => ipcRenderer.invoke("launcher:steamRemoveAccount", id),
    externalState: store => ipcRenderer.invoke("launcher:externalState", store),
    externalDownloaded: () => ipcRenderer.invoke("launcher:externalDownloaded"),
    externalImportCopies: ids => ipcRenderer.invoke("launcher:externalImportCopies", ids),
    externalOpenDownloads: store => ipcRenderer.invoke("launcher:externalOpenDownloads", store),
    externalConnect: (store, credentials) => ipcRenderer.invoke("launcher:externalConnect", store, credentials),
    externalAuth: (store, response) => ipcRenderer.invoke("launcher:externalAuth", store, response),
    externalDisconnect: store => ipcRenderer.invoke("launcher:externalDisconnect", store),
    externalForget: store => ipcRenderer.invoke("launcher:externalForget", store),
    externalOpenLogin: store => ipcRenderer.invoke("launcher:externalOpenLogin", store),
    externalLibrary: (store, refresh) => ipcRenderer.invoke("launcher:externalLibrary", store, refresh),
    externalSearch: (store, query, options) => ipcRenderer.invoke("launcher:externalSearch", store, query, options),
    externalAddToLibrary: (store, appId, options) => ipcRenderer.invoke("launcher:externalAddToLibrary", store, appId, options),
    externalAddGame: (store, url) => ipcRenderer.invoke("launcher:externalAddGame", store, url),
    externalVersions: (store, appId, refresh, options) => ipcRenderer.invoke("launcher:externalVersions", store, appId, refresh, options),
    externalAccounts: (store, refresh) => ipcRenderer.invoke("launcher:externalAccounts", store, refresh),
    externalOpenAccounts: store => ipcRenderer.invoke("launcher:externalOpenAccounts", store),
    externalDownload: (store, selection) => ipcRenderer.invoke("launcher:externalDownload", store, selection),
    externalCancel: (store, id) => ipcRenderer.invoke("launcher:externalCancel", store, id),
    externalImportDownload: (store, id) => ipcRenderer.invoke("launcher:externalImportDownload", store, id),
    onExternalState: callback => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("launcher:externalState", handler);
      return () => ipcRenderer.removeListener("launcher:externalState", handler);
    },
    steamAuth: response => ipcRenderer.invoke("launcher:steamAuth", response),
    steamDisconnect: () => ipcRenderer.invoke("launcher:steamDisconnect"),
    steamLibrary: refresh => ipcRenderer.invoke("launcher:steamLibrary", refresh),
    steamVersions: (appId, refresh) => ipcRenderer.invoke("launcher:steamVersions", appId, refresh),
    steamPreviousVersions: (appId, depotIds, refresh) => ipcRenderer.invoke("launcher:steamPreviousVersions", appId, depotIds, refresh),
    steamOpenHistory: (appId, depotId) => ipcRenderer.invoke("launcher:steamOpenHistory", appId, depotId),
    steamDownload: selection => ipcRenderer.invoke("launcher:steamDownload", selection),
    steamCancel: id => ipcRenderer.invoke("launcher:steamCancel", id),
    steamChooseDirectory: () => ipcRenderer.invoke("launcher:steamChooseDirectory"),
    onSteamState: callback => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("launcher:steamState", handler);
      return () => ipcRenderer.removeListener("launcher:steamState", handler);
    },
    openGameDialog: () => ipcRenderer.invoke("launcher:openGameDialog"),
    getPathForFile: file => {
      try {
        if (file && typeof file.path === "string" && file.path) return file.path;
      } catch {}
      try {
        if (webUtils && typeof webUtils.getPathForFile === "function") {
          const p = webUtils.getPathForFile(file);
          return typeof p === "string" && p ? p : null;
        }
      } catch {}
      return null;
    },
    addRecent: inputPath => ipcRenderer.invoke("launcher:addRecent", inputPath),
    cancelImport: inputPath => ipcRenderer.invoke("launcher:cancelImport", inputPath),
    forgetGame: gamePath => ipcRenderer.invoke("launcher:forgetGame", gamePath),
    findMissingGames: gamePaths => ipcRenderer.invoke("launcher:findMissingGames", gamePaths),
    forgetGames: gamePaths => ipcRenderer.invoke("launcher:forgetGames", gamePaths),
    deleteGames: gamePaths => ipcRenderer.invoke("launcher:deleteGames", gamePaths),
    setGameFavorite: (gamePath, favorite) => ipcRenderer.invoke("launcher:setGameFavorite", gamePath, favorite),
    setGameNotes: (gamePath, notes) => ipcRenderer.invoke("launcher:setGameNotes", gamePath, notes),
    setGameLaunchArguments: (gamePath, value) => ipcRenderer.invoke("launcher:setGameLaunchArguments", gamePath, value),
    setGameNetworkAccess: (gamePath, value) => ipcRenderer.invoke("launcher:setGameNetworkAccess", gamePath, value),
    setGameReShade: (gamePath, patch, expectedSelection) => ipcRenderer.invoke("launcher:setGameReShade", gamePath, patch,
      ...(expectedSelection === undefined ? [] : [expectedSelection])),
    setGameGraphics: (gamePath, patch, expectedSpatialShader) => ipcRenderer.invoke("launcher:setGameGraphics", gamePath, patch,
      ...(expectedSpatialShader === undefined ? [] : [expectedSpatialShader])), 
    listEffectsPresets: () => ipcRenderer.invoke("launcher:listEffectsPresets"),
    saveEffectsPreset: value => ipcRenderer.invoke("launcher:saveEffectsPreset", value),
    deleteEffectsPreset: (id, updatedAt) => ipcRenderer.invoke("launcher:deleteEffectsPreset", id, updatedAt),
    getEffectsPresetEditor: plan => ipcRenderer.invoke("launcher:getEffectsPresetEditor", plan),
    getEffectsPresetParameters: (nodeId, plan) => ipcRenderer.invoke("launcher:getEffectsPresetParameters", nodeId, plan),
    pickEffectsPresetFile: kind => ipcRenderer.invoke("launcher:pickEffectsPresetFile", kind),
    getGameEffects: gamePath => ipcRenderer.invoke("launcher:getGameEffects", gamePath),
    getGameGraphicsStatus: gamePath => ipcRenderer.invoke("launcher:getGameGraphicsStatus", gamePath),
    setGameEffects: (gamePath, plan) => ipcRenderer.invoke("launcher:setGameEffects", gamePath, plan),
    resetGameEffects: gamePath => ipcRenderer.invoke("launcher:resetGameEffects", gamePath),
    getGameEffectParameters: (gamePath, nodeId, draftPlan) => ipcRenderer.invoke("launcher:getGameEffectParameters", gamePath, nodeId, draftPlan),
    pickGameEffectFile: (gamePath, kind) => ipcRenderer.invoke("launcher:pickGameEffectFile", gamePath, ...(kind === undefined ? [] : [kind])),
    ensureGameGraphicsModel: (gamePath, kind, patch) => ipcRenderer.invoke("launcher:ensureGameGraphicsModel", gamePath, kind, patch),
    getGameShaderParameters: gamePath => ipcRenderer.invoke("launcher:getGameShaderParameters", gamePath),
    pickGameReShadeEffect: gamePath => ipcRenderer.invoke("launcher:pickGameReShadeEffect", gamePath),
    importReShadeFilters: family => ipcRenderer.invoke("launcher:importReShadeFilters", ...(family === undefined ? [] : [family])),
    updateReShadeFilter: (id, patch) => ipcRenderer.invoke("launcher:updateReShadeFilter", id, patch),
    removeReShadeFilter: id => ipcRenderer.invoke("launcher:removeReShadeFilter", id),
    pickReShadeFilterPath: id => ipcRenderer.invoke("launcher:pickReShadeFilterPath", id),
    setLibrarySort: sort => ipcRenderer.invoke("launcher:setLibrarySort", sort),
    moveGame: (gamePath, delta) => ipcRenderer.invoke("launcher:moveGame", gamePath, delta),
    reorderGame: (gamePath, toIndex) =>
      ipcRenderer.invoke("launcher:reorderGame", gamePath, toIndex),
    deleteGame: gamePath => ipcRenderer.invoke("launcher:deleteGame", gamePath),
    launchGame: gamePath => ipcRenderer.invoke("launcher:launchGame", gamePath),
    openSaveEditor: gamePath => ipcRenderer.invoke("launcher:openSaveEditor", gamePath),
    launchGameWithRuntime: (gamePath, runtime) =>
      ipcRenderer.invoke("launcher:launchGameWithRuntime", gamePath, runtime),
    createGameCommand: gamePath => ipcRenderer.invoke("launcher:createGameCommand", gamePath),
    stopGame: gamePath => ipcRenderer.invoke("launcher:stopGame", gamePath),
    setGameRuntime: (gamePath, runtime) =>
      ipcRenderer.invoke("launcher:setGameRuntime", gamePath, runtime),
    setGameRuntimeSettings: (gamePath, runtimeId, settings) =>
      ipcRenderer.invoke("launcher:setGameRuntimeSettings", gamePath, runtimeId, settings),
    setModuleSettings: (moduleId, patch) =>
      ipcRenderer.invoke("launcher:setModuleSettings", moduleId, patch),
    setLauncherSettings: patch =>
      ipcRenderer.invoke("launcher:setLauncherSettings", patch),
    setModuleRuntimeSettings: (moduleId, runtimeId, settings) =>
      ipcRenderer.invoke("launcher:setModuleRuntimeSettings", moduleId, runtimeId, settings),
    setGameModuleData: (gamePath, patch) =>
      ipcRenderer.invoke("launcher:setGameModuleData", gamePath, patch),
    setGameRuntimeData: (gamePath, runtimeId, patch) =>
      ipcRenderer.invoke("launcher:setGameRuntimeData", gamePath, runtimeId, patch),
    cancelDownload: downloadId => ipcRenderer.invoke("launcher:cancelDownload", downloadId),
    openRuntimeSettings: payload =>
      ipcRenderer.invoke("launcher:openRuntimeSettings", payload),
    runtimeAction: (managerId, action, payload) =>
      ipcRenderer.invoke("launcher:runtimeAction", managerId, action, payload),
    moduleAction: (gamePath, action, payload, options) =>
      ipcRenderer.invoke("launcher:moduleAction", gamePath, action, payload, options),
    cancelModuleAction: requestId => ipcRenderer.invoke("launcher:cancelModuleAction", requestId),
    moduleSettingsAction: (moduleId, action, payload) =>
      ipcRenderer.invoke("launcher:moduleSettingsAction", moduleId, action, payload),
    setGameLibVersion: (gamePath, depId, versionId) =>
      ipcRenderer.invoke("launcher:setGameLibVersion", gamePath, depId, versionId),
    getLibsPatchStatus: gamePath => ipcRenderer.invoke("launcher:getLibsPatchStatus", gamePath),
    patchLibs: gamePath => ipcRenderer.invoke("launcher:patchLibs", gamePath),
    unpatchLibs: gamePath => ipcRenderer.invoke("launcher:unpatchLibs", gamePath),
    pickSaveDir: gamePath => ipcRenderer.invoke("launcher:pickSaveDir", gamePath),
    resetSaveDir: gamePath => ipcRenderer.invoke("launcher:resetSaveDir", gamePath),
    setCheats: (gamePath, cheats) => ipcRenderer.invoke("launcher:setCheats", gamePath, cheats),
    getCheatsPatchStatus: gamePath => ipcRenderer.invoke("launcher:getCheatsPatchStatus", gamePath),
    patchCheatsIntoGame: gamePath => ipcRenderer.invoke("launcher:patchCheatsIntoGame", gamePath),
    unpatchCheatsFromGame: gamePath => ipcRenderer.invoke("launcher:unpatchCheatsFromGame", gamePath),
    getSaveInfo: gamePath => ipcRenderer.invoke("launcher:getSaveInfo", gamePath),
    selectSaveLocation: (gamePath, directory) => ipcRenderer.invoke("launcher:selectSaveLocation", gamePath, directory),
    listSaveFiles: gamePath => ipcRenderer.invoke("launcher:listSaveFiles", gamePath),
    importSaveDir: gamePath => ipcRenderer.invoke("launcher:importSaveDir", gamePath),
    exportSaveDir: gamePath => ipcRenderer.invoke("launcher:exportSaveDir", gamePath),
    importSaveFiles: gamePath => ipcRenderer.invoke("launcher:importSaveFiles", gamePath),
    readSaveJson: (gamePath, fileName) =>
      ipcRenderer.invoke("launcher:readSaveJson", gamePath, fileName),
    writeSaveJson: (gamePath, fileName, json, expectedHash) =>
      ipcRenderer.invoke("launcher:writeSaveJson", gamePath, fileName, json, expectedHash),
    openSaveJsonInExternalEditor: (gamePath, fileName, json) =>
      ipcRenderer.invoke("launcher:openSaveJsonInExternalEditor", gamePath, fileName, json),
    readExternalSaveJson: (gamePath, fileName) =>
      ipcRenderer.invoke("launcher:readExternalSaveJson", gamePath, fileName),
    revealInFinder: targetPath => ipcRenderer.invoke("launcher:revealInFinder", targetPath),
    openExternal: url => ipcRenderer.invoke("launcher:openExternal", url),
    onGameImported: callback => {
      const listener = (_event, gamePath) => callback(gamePath);
      ipcRenderer.on("launcher:gameImported", listener);
      return () => ipcRenderer.removeListener("launcher:gameImported", listener);
    },
    onGameFailed: callback => {
      const listener = (_event, failure) => callback(failure);
      ipcRenderer.on("launcher:gameFailed", listener);
      return () => ipcRenderer.removeListener("launcher:gameFailed", listener);
    },
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("launcher:state", listener);
      return () => ipcRenderer.removeListener("launcher:state", listener);
    },
    onActivity: subscribeActivity
  }
});
