const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("MacLauncher", {
  launcher: {
    getState: () => ipcRenderer.invoke("launcher:getState"),
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
    forgetGame: gamePath => ipcRenderer.invoke("launcher:forgetGame", gamePath),
    moveGame: (gamePath, delta) => ipcRenderer.invoke("launcher:moveGame", gamePath, delta),
    reorderGame: (gamePath, toIndex) =>
      ipcRenderer.invoke("launcher:reorderGame", gamePath, toIndex),
    deleteGame: gamePath => ipcRenderer.invoke("launcher:deleteGame", gamePath),
    launchGame: gamePath => ipcRenderer.invoke("launcher:launchGame", gamePath),
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
    listSaveFiles: gamePath => ipcRenderer.invoke("launcher:listSaveFiles", gamePath),
    importSaveDir: gamePath => ipcRenderer.invoke("launcher:importSaveDir", gamePath),
    exportSaveDir: gamePath => ipcRenderer.invoke("launcher:exportSaveDir", gamePath),
    importSaveFiles: gamePath => ipcRenderer.invoke("launcher:importSaveFiles", gamePath),
    readSaveJson: (gamePath, fileName) =>
      ipcRenderer.invoke("launcher:readSaveJson", gamePath, fileName),
    writeSaveJson: (gamePath, fileName, json) =>
      ipcRenderer.invoke("launcher:writeSaveJson", gamePath, fileName, json),
    openSaveJsonInExternalEditor: (gamePath, fileName, json) =>
      ipcRenderer.invoke("launcher:openSaveJsonInExternalEditor", gamePath, fileName, json),
    readExternalSaveJson: (gamePath, fileName) =>
      ipcRenderer.invoke("launcher:readExternalSaveJson", gamePath, fileName),
    revealInFinder: targetPath => ipcRenderer.invoke("launcher:revealInFinder", targetPath),
    openExternal: url => ipcRenderer.invoke("launcher:openExternal", url),
    onOpenSettings: callback => {
      const listener = () => callback();
      ipcRenderer.on("launcher:openSettings", listener);
      return () => ipcRenderer.removeListener("launcher:openSettings", listener);
    },
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("launcher:state", listener);
      return () => ipcRenderer.removeListener("launcher:state", listener);
    }
  }
});
