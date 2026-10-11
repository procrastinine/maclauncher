const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("MacLauncher", {
  launcher: {
    getState: () => ipcRenderer.invoke("launcher:getState"),
    openUtilityWindow: request => ipcRenderer.invoke("launcher:openUtilityWindow", request),
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
    moduleAction: (gamePath, action, payload) =>
      ipcRenderer.invoke("launcher:moduleAction", gamePath, action, payload),
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
    }
  }
});
