// Shared browser injection for Electron and both NW.js hosts. The builder is
// pure Node code; it does not import or require a launcher host.
function buildStoragePatchScript(engineId, saveDir) {
  const cfg = { engine: engineId, saveDir };
  return `
(() => {
  const cfg = ${JSON.stringify(cfg)};
  if (!cfg.saveDir) return;

  const normalizeDir = p => {
    const fixed = String(p).replaceAll("\\\\", "/");
    return fixed.endsWith("/") ? fixed : fixed + "/";
  };
  const wantMV = cfg.engine === "mv";
  const wantMZ = cfg.engine === "mz";
  const isReady = SM => {
    if (!SM || typeof SM.isLocalMode !== "function") return false;
    if (wantMV) return typeof SM.save === "function" && typeof SM.localFileDirectoryPath === "function";
    if (wantMZ) return typeof SM.saveZip === "function" && typeof SM.fileDirectoryPath === "function";
    return false;
  };

  function tryPatch() {
    const SM = window.StorageManager;
    if (!isReady(SM)) return false;
    if (SM.__maclauncher_patched) return true;
    try {
      const directory = normalizeDir(cfg.saveDir);
      SM.isLocalMode = () => true;
      if (wantMV) SM.localFileDirectoryPath = () => directory;
      if (wantMZ) SM.fileDirectoryPath = () => directory;
      SM.__maclauncher_patched = true;
      return true;
    } catch (error) {
      console.error("[MacLauncher] Storage patch failed:", error);
      return false;
    }
  }

  let tries = 0;
  (function loop() {
    if (tryPatch()) return;
    if (++tries > 4000) return;
    setTimeout(loop, 10);
  })();
})();
`;
}

function buildNwjsStorageInjection(engineId, entry) {
  const saveDir = entry?.saveDirOverride || entry?.defaultSaveDir;
  if (typeof saveDir !== "string" || !saveDir) return {};
  const injectionPath = "__maclauncher/mvmz-storage.js";
  return {
    injectStart: [injectionPath],
    extraFiles: [{ path: injectionPath, contents: buildStoragePatchScript(engineId, saveDir) }]
  };
}

module.exports = { buildStoragePatchScript, buildNwjsStorageInjection };
