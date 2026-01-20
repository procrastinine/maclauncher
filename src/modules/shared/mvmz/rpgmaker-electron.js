const fs = require("fs");
const path = require("path");
const Module = require("module");

const { createCheatsHelpers } = require("../cheats/cheats");
const CheatsRuntime = require("./cheats/runtime");
const cheatsSchema = require("./cheats/schema.json");
const cheatsHelpers = createCheatsHelpers(cheatsSchema);

function createRpgmakerElectronRuntime({ engineId } = {}) {
  if (!engineId) throw new Error("rpgmaker electron runtime missing engineId");

  const state = {
    nwShim: null
  };

  function makeNwWindow(ipcRenderer) {
    return {
      showDevTools: () => ipcRenderer.send("maclauncher:debug:openDevTools"),
      isDevToolsOpen: () => false,
      focus: () => ipcRenderer.send("maclauncher:debug:focusWindow"),
      show: () => ipcRenderer.send("maclauncher:window:show"),
      hide: () => ipcRenderer.send("maclauncher:window:hide"),
      maximize: () => ipcRenderer.send("maclauncher:window:maximize"),
      minimize: () => ipcRenderer.send("maclauncher:window:minimize"),
      restore: () => ipcRenderer.send("maclauncher:window:restore"),
      moveTo: (x, y) => ipcRenderer.send("maclauncher:window:moveTo", Number(x), Number(y)),
      resizeTo: (w, h) =>
        ipcRenderer.send("maclauncher:window:resizeTo", Number(w), Number(h), {
          mode: "outer"
        }),
      setAlwaysOnTop: flag =>
        ipcRenderer.send("maclauncher:window:setAlwaysOnTop", Boolean(flag)),
      setResizable: flag => ipcRenderer.send("maclauncher:window:setResizable", Boolean(flag)),
      on: (eventName, callback) => {
        if (eventName !== "close") return;
        if (typeof callback !== "function") return;
        window.addEventListener("beforeunload", () => {
          try {
            if (globalThis.__maclauncher_reloading) return;
            callback();
          } catch {}
        });
      }
    };
  }

  function buildNwShim(context) {
    const manifest = context?.config?.manifest || null;
    const ipcRenderer = context?.ipcRenderer;

    return {
      App: {
        argv: [],
        manifest,
        quit: () => {
          try {
            if (globalThis.__maclauncher_reloading) return;
          } catch {}
          ipcRenderer.send("maclauncher:debug:closeWindow");
        }
      },
      Menu: class Menu {
        constructor(_opts) {
          this.type = _opts?.type;
        }
        createMacBuiltin(_name, _options) {}
      },
      MenuItem: class MenuItem {
        constructor(_opts) {
          this.label = _opts?.label;
        }
      },
      Window: {
        get: () => makeNwWindow(ipcRenderer)
      },
      Shell: {
        openExternal: url => ipcRenderer.send("maclauncher:shell:openExternal", url)
      }
    };
  }

  function setup(context) {
    const nwShim = buildNwShim(context);
    state.nwShim = nwShim;
    context.exposeInMainWorld("nw", nwShim);
    const nwjsVersion =
      typeof context?.config?.nwjsVersion === "string" && context.config.nwjsVersion.trim()
        ? context.config.nwjsVersion.trim()
        : null;
    const shimVersion = nwjsVersion || "0.107.0";
    try {
      process.versions.nw ??= shimVersion;
      process.versions["node-webkit"] ??= shimVersion;
    } catch {}
    return {
      requireOverrides: {
        "nw.gui": nwShim,
        nw: nwShim
      }
    };
  }

  function safeDecodePathname(pathname) {
    try {
      return decodeURIComponent(pathname);
    } catch {
      try {
        const withUnicode = pathname.replace(/%u([0-9a-fA-F]{4})/g, (_m, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
        return decodeURIComponent(withUnicode);
      } catch {
        // eslint-disable-next-line no-undef
        return unescape(pathname);
      }
    }
  }

  function mapUrlToFilePath(urlStr, gameDir) {
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr);
      if (u.protocol === "file:") {
        let p = safeDecodePathname(u.pathname);
        p = p.replace(/^\/([a-zA-Z]:\/)/, "$1");
        return p;
      }
      if (u.protocol === "http:" || u.protocol === "https:") {
        if (!gameDir) return null;
        const pathname = safeDecodePathname(u.pathname);
        return path.resolve(gameDir, "." + pathname);
      }
    } catch {}
    return null;
  }

  function installSmartRequire({ indexHtml, gameDir }) {
    try {
      const baseFile =
        typeof indexHtml === "string" && indexHtml ? indexHtml : path.join(process.cwd(), "index.html");
      const baseRequire = Module.createRequire(baseFile);
      const reqCache = new Map();

      const getForBase = base => {
        const key = base || baseFile;
        let r = reqCache.get(key);
        if (!r) {
          r = Module.createRequire(key);
          reqCache.set(key, r);
        }
        return r;
      };

      const inferCallerUrlFromStack = () => {
        try {
          const stack = String(new Error().stack || "");
          for (const line of stack.split("\n")) {
            const m = /(https?:\/\/[^\s)]+|file:\/\/[^\s)]+)/.exec(line);
            if (!m) continue;
            const url = m[1];
      if (url.includes("electron/js2c")) continue;
      if (url.includes("preload/game.js")) continue;
            return url;
          }
        } catch {}
        return null;
      };

      const inferBaseFile = () => {
        try {
          const cs = document.currentScript;
          if (cs && typeof cs.src === "string" && cs.src) {
            return mapUrlToFilePath(cs.src, gameDir);
          }
        } catch {}
        return mapUrlToFilePath(inferCallerUrlFromStack(), gameDir) || baseFile;
      };

      const smartRequire = request => {
        const base = inferBaseFile();
        return getForBase(base)(request);
      };

      smartRequire.resolve = (request, options) => {
        const base = inferBaseFile();
        return getForBase(base).resolve(request, options);
      };

      smartRequire.cache = baseRequire.cache;
      smartRequire.extensions = baseRequire.extensions;
      smartRequire.main = baseRequire.main;

      try {
        window.require = smartRequire;
      } catch {}
    } catch (e) {
      console.error("[MacLauncher] Failed to install smart require:", e);
    }
  }

  function buildStoragePatchScript(saveDir) {
    const cfg = {
      engine: engineId,
      saveDir
    };
    return `
(() => {
  const cfg = ${JSON.stringify(cfg)};
  if (!cfg.saveDir) return;

  const normalizeDir = (p) => {
    if (!p) return p;
    const fixed = String(p).replaceAll("\\\\", "/");
    return fixed.endsWith("/") ? fixed : fixed + "/";
  };

  const wantMV = cfg.engine === "mv";
  const wantMZ = cfg.engine === "mz";

  const isReady = (SM) => {
    if (!SM) return false;
    if (typeof SM.isLocalMode !== "function") return false;
    if (wantMV) return typeof SM.save === "function" && typeof SM.localFileDirectoryPath === "function";
    if (wantMZ) return typeof SM.saveZip === "function" && typeof SM.fileDirectoryPath === "function";
    return typeof SM.localFileDirectoryPath === "function" || typeof SM.fileDirectoryPath === "function";
  };

  function tryPatch() {
    const SM = window.StorageManager;
    if (!isReady(SM)) return false;
    if (SM.__maclauncher_patched) return true;

    try {
      SM.__maclauncher_patched = true;
      SM.isLocalMode = () => true;
      const saveDir = normalizeDir(cfg.saveDir);
      if (wantMV && typeof SM.localFileDirectoryPath === "function") {
        SM.localFileDirectoryPath = () => saveDir;
      }
      if (wantMZ && typeof SM.fileDirectoryPath === "function") {
        SM.fileDirectoryPath = () => saveDir;
      }
      return true;
    } catch (e) {
      console.error("[MacLauncher] Storage patch failed:", e);
      return false;
    }
  }

  let tries = 0;
  (function loop() {
    if (tryPatch()) return;
    tries++;
    if (tries > 4000) return;
    setTimeout(loop, 10);
  })();
})();
`;
  }

  function buildGlobalInfoPatchScript(saveDir) {
    const cfg = { engine: engineId, saveDir };
    return `
(() => {
  const cfg = ${JSON.stringify(cfg)};
  if (!cfg.saveDir) return;

  const pad2 = n => String(n).padStart(2, "0");
  const framesToPlaytimeText = frames => {
    const sec = Math.floor((Number(frames) || 0) / 60);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return \`\${pad2(h)}:\${pad2(m)}:\${pad2(s)}\`;
  };

  const isMZ = () =>
    cfg.engine === "mz" ||
    (window.StorageManager &&
      typeof window.StorageManager.loadObject === "function" &&
      typeof window.StorageManager.saveObject === "function");

  const isMV = () =>
    cfg.engine === "mv" ||
    (window.StorageManager &&
      typeof window.StorageManager.load === "function" &&
      typeof window.StorageManager.save === "function" &&
      !(window.StorageManager && typeof window.StorageManager.loadObject === "function"));

  const waitFor = (check, maxMs = 5000) =>
    new Promise(resolve => {
      const start = Date.now();
      (function loop() {
        let ok = false;
        try {
          ok = Boolean(check());
        } catch {}
        if (ok) return resolve(true);
        if (Date.now() - start > maxMs) return resolve(false);
        setTimeout(loop, 10);
      })();
    });

  function patchMZ() {
    const DM = window.DataManager;
    const SM = window.StorageManager;
    if (!DM || !SM || typeof DM.loadGlobalInfo !== "function") return false;
    if (DM.__maclauncher_globalInfoPatched) return true;

    const original = DM.loadGlobalInfo;

    DM.loadGlobalInfo = function maclauncherLoadGlobalInfo() {
      if (DM.__maclauncher_globalInfoLoading) return;
      DM.__maclauncher_globalInfoLoading = true;

      // Keep null so Scene_Boot waits for us.
      DM._globalInfo = null;

      (async () => {
        try {
          await waitFor(() => SM.__maclauncher_patched === true, 10000);

          let globalInfo = [];
          try {
            globalInfo = await SM.loadObject("global");
          } catch {
            globalInfo = [];
          }
          if (!Array.isArray(globalInfo)) globalInfo = [];

          let maxFiles = 20;
          try {
            if (typeof DM.maxSavefiles === "function") {
              maxFiles = Number(DM.maxSavefiles()) || maxFiles;
            }
          } catch {}

          for (let id = 0; id < maxFiles; id++) {
            const saveName = typeof DM.makeSavename === "function" ? DM.makeSavename(id) : \`file\${id}\`;
            let exists = false;
            try {
              exists = Boolean(SM.exists(saveName));
            } catch {
              exists = false;
            }

            if (!exists) {
              if (globalInfo[id]) delete globalInfo[id];
              continue;
            }

            const prev = globalInfo[id] && typeof globalInfo[id] === "object" ? globalInfo[id] : {};

            let playtime = prev.playtime;
            try {
              const contents = await SM.loadObject(saveName);
              const sys = contents?.system;
              const frames =
                sys?._framesOnSave ?? sys?._playtime ?? sys?._playtimeFrames ?? sys?._playtimeCount ?? 0;
              playtime = framesToPlaytimeText(frames);
            } catch {}
            if (typeof playtime !== "string" || !playtime) playtime = "00:00:00";

            let timestamp = typeof prev.timestamp === "number" ? prev.timestamp : null;
            if (timestamp == null) {
              try {
                const fs = window.require ? window.require("fs") : null;
                const filePath =
                  typeof SM.filePath === "function" ? SM.filePath(saveName) : null;
                if (fs && filePath && fs.existsSync(filePath)) {
                  timestamp = Math.floor(fs.statSync(filePath).mtimeMs);
                }
              } catch {}
            }
            if (timestamp == null) timestamp = Date.now();

            let title = prev.title;
            try {
              title = title || window.$dataSystem?.gameTitle;
            } catch {}

            globalInfo[id] = { ...prev, title, playtime, timestamp };
          }

          DM._globalInfo = globalInfo;
          try {
            DM.saveGlobalInfo?.();
          } catch {}
        } finally {
          DM.__maclauncher_globalInfoLoading = false;
        }
      })().catch(err => {
        console.warn("[MacLauncher] GlobalInfo patch failed:", err);
        DM._globalInfo = [];
        DM.__maclauncher_globalInfoLoading = false;
        try {
          original?.call(DM);
        } catch {}
      });
    };

    DM.__maclauncher_globalInfoPatched = true;
    return true;
  }

  function patchMV() {
    const DM = window.DataManager;
    const SM = window.StorageManager;
    if (!DM || !SM || typeof DM.loadGlobalInfo !== "function") return false;
    if (DM.__maclauncher_globalInfoPatched) return true;

    const original = DM.loadGlobalInfo;

    DM.loadGlobalInfo = function maclauncherLoadGlobalInfoMV() {
      let globalInfo = [];
      try {
        globalInfo = original.call(this) || [];
      } catch {
        globalInfo = [];
      }
      if (!Array.isArray(globalInfo)) globalInfo = [];

      let maxFiles = 20;
      try {
        if (typeof this.maxSavefiles === "function") maxFiles = Number(this.maxSavefiles()) || maxFiles;
      } catch {}

      let dirty = false;
      for (let id = 1; id <= maxFiles; id++) {
        let exists = false;
        try {
          exists = Boolean(SM.exists(id));
        } catch {
          exists = false;
        }

        if (!exists) {
          if (globalInfo[id]) {
            delete globalInfo[id];
            dirty = true;
          }
          continue;
        }

        let playtime = globalInfo[id]?.playtime;
        try {
          const json = SM.load(id);
          if (json) {
            const obj = JSON.parse(json);
            const frames =
              obj?.system?._framesOnSave ??
              obj?.system?._playtime ??
              obj?.system?._playtimeFrames ??
              obj?.system?._playtimeCount ??
              0;
            playtime = framesToPlaytimeText(frames);
          }
        } catch {}

        if (!globalInfo[id] || typeof globalInfo[id] !== "object") {
          globalInfo[id] = { playtime, timestamp: Date.now() };
          dirty = true;
        } else {
          const nextPlaytime = playtime;
          if (typeof nextPlaytime === "string" && globalInfo[id].playtime !== nextPlaytime) {
            globalInfo[id].playtime = nextPlaytime;
            dirty = true;
          }
        }
      }

      if (dirty) {
        try {
          DM.saveGlobalInfo(globalInfo);
        } catch {}
      }

      return globalInfo;
    };

    DM.__maclauncher_globalInfoPatched = true;
    return true;
  }

  let tries = 0;
  (function loop() {
    try {
      if (isMZ() && patchMZ()) return;
      if (isMV() && patchMV()) return;
    } catch {}
    tries++;
    if (tries > 4000) return;
    setTimeout(loop, 10);
  })();
})();
`;
  }

  function startStoragePatcher({ saveDir, webFrame }) {
    if (process.contextIsolated) {
      webFrame.executeJavaScript(buildStoragePatchScript(saveDir), true).catch(err => {
        console.error("[MacLauncher] Failed to inject storage patch:", err);
      });
      return;
    }

    const wantMV = engineId === "mv";
    const wantMZ = engineId === "mz";

    const isReady = SM => {
      if (!SM) return false;
      if (typeof SM.isLocalMode !== "function") return false;
      if (wantMV) return typeof SM.save === "function" && typeof SM.localFileDirectoryPath === "function";
      if (wantMZ) return typeof SM.saveZip === "function" && typeof SM.fileDirectoryPath === "function";
      return typeof SM.localFileDirectoryPath === "function" || typeof SM.fileDirectoryPath === "function";
    };

    const normalizeDir = p => {
      if (!p) return p;
      const fixed = String(p).replaceAll("\\\\", "/");
      return fixed.endsWith("/") ? fixed : fixed + "/";
    };

    let tries = 0;
    (function loop() {
      const SM = window.StorageManager;
      if (saveDir && isReady(SM) && !SM.__maclauncher_patched) {
        try {
          SM.__maclauncher_patched = true;
          SM.isLocalMode = () => true;
          const dir = normalizeDir(saveDir);
          if (wantMV && typeof SM.localFileDirectoryPath === "function") {
            SM.localFileDirectoryPath = () => dir;
          }
          if (wantMZ && typeof SM.fileDirectoryPath === "function") {
            SM.fileDirectoryPath = () => dir;
          }
        } catch (e) {
          console.error("[MacLauncher] Storage patch failed:", e);
        }
      }

      if (SM?.__maclauncher_patched && isReady(SM)) return;

      tries++;
      if (tries > 4000) return;
      setTimeout(loop, 10);
    })();
  }

  function install(context) {
    const { config, webFrame } = context;
    const saveDir = config.saveDir;
    const gameDir = config.gameDir;
    const indexHtml = config.indexHtml;
    const cheatsFilePath = config.cheatsFilePath;
    const toolsButtonVisible = config.toolsButtonVisible;

    // Some plugins include CommonJS blocks that can clobber globals under Node.
    try {
      globalThis.module = undefined;
      globalThis.exports = undefined;
    } catch {}

    const { defaults: DEFAULT_CHEATS, normalizeCheats } = cheatsHelpers;
    const cheats = normalizeCheats(config.cheats);

    installSmartRequire({ indexHtml, gameDir });

    try {
      CheatsRuntime.installCheatsRuntime({
        DEFAULT_CHEATS,
        normalizeCheats,
        cheatsFilePath,
        initialCheats: cheats,
        toolsButtonVisible,
        enableFileSync: true,
        enablePatcher: true,
        enableToolsUi: true
      });
    } catch (e) {
      console.error("[MacLauncher] Failed to install cheat runtime:", e);
    }

    function initCheatsState() {
      try {
        const existing =
          window.rmmz_cheats && typeof window.rmmz_cheats === "object" ? window.rmmz_cheats : {};
        window.rmmz_cheats = { ...DEFAULT_CHEATS, ...existing, ...(cheats || {}) };
      } catch (e) {
        console.error("[MacLauncher] Failed to initialize cheats state:", e);
      }
    }

    function writeCheatsFileNow(nextCheats) {
      if (!cheatsFilePath) return false;
      try {
        fs.mkdirSync(path.dirname(cheatsFilePath), { recursive: true });
      } catch {}
      try {
        const normalized = normalizeCheats(nextCheats);
        fs.writeFileSync(cheatsFilePath, JSON.stringify(normalized, null, 2), "utf8");
        return true;
      } catch {
        return false;
      }
    }

    let cheatsWriteTimer = null;
    function scheduleCheatsFileWrite() {
      if (!cheatsFilePath) return;
      if (cheatsWriteTimer) clearTimeout(cheatsWriteTimer);
      cheatsWriteTimer = setTimeout(() => {
        cheatsWriteTimer = null;
        try {
          writeCheatsFileNow(window.rmmz_cheats);
        } catch {}
      }, 150);
    }

    function startCheatsFileSync() {
      if (!cheatsFilePath) return;

      let lastMtimeMs = 0;
      try {
        if (fs.existsSync(cheatsFilePath)) lastMtimeMs = fs.statSync(cheatsFilePath).mtimeMs;
      } catch {}

      // Ensure the file exists for the launcher watcher.
      try {
        writeCheatsFileNow(window.rmmz_cheats);
        if (fs.existsSync(cheatsFilePath)) lastMtimeMs = fs.statSync(cheatsFilePath).mtimeMs;
      } catch {}

      setInterval(() => {
        let stat = null;
        try {
          stat = fs.existsSync(cheatsFilePath) ? fs.statSync(cheatsFilePath) : null;
        } catch {
          stat = null;
        }
        const mtimeMs = stat ? stat.mtimeMs : 0;
        if (!(mtimeMs > 0) || mtimeMs === lastMtimeMs) return;
        lastMtimeMs = mtimeMs;

        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(cheatsFilePath, "utf8"));
        } catch {
          parsed = null;
        }
        if (!parsed) return;

        const next = normalizeCheats(parsed);
        const cur =
          window.rmmz_cheats && typeof window.rmmz_cheats === "object" ? window.rmmz_cheats : null;
        if (!cur) return;

        let changed = false;
        for (const k of Object.keys(DEFAULT_CHEATS)) {
          if (cur[k] !== next[k]) {
            cur[k] = next[k];
            changed = true;
          }
        }

        if (changed) {
          try {
            window.dispatchEvent(new Event("maclauncher:cheatsUpdated"));
          } catch {}
        }
      }, 500);
    }

    function startCheatPatcher() {
      const inShopScene = () => {
        try {
          const s = window.SceneManager?._scene;
          if (!s) return false;
          if (window.Scene_Shop && s instanceof window.Scene_Shop) return true;
          return Boolean(s.constructor && s.constructor.name === "Scene_Shop");
        } catch {
          return false;
        }
      };

      const cheatsEnabled = () => {
        try {
          const c = window.rmmz_cheats;
          if (!c || typeof c !== "object") return false;
          return c.enabled === true;
        } catch {
          return false;
        }
      };

      const hookSpeed = (() => {
        let acc = 0;
        return () => {
          if (!window.SceneManager || window.SceneManager._hookedSpeed) return;
          const original = window.SceneManager.updateScene;
          if (typeof original !== "function") return;
          window.SceneManager.updateScene = function () {
            const m = cheatsEnabled() ? Number(window.rmmz_cheats?.speed) || 1 : 1;
            if (!(m > 1)) return original.call(this);
            acc += m;
            const times = Math.max(1, Math.floor(acc));
            acc -= times;
            for (let i = 0; i < times; i++) original.call(this);
          };
          window.SceneManager._hookedSpeed = true;
        };
      })();

      const hookInstantText = () => {
        if (!window.Window_Message || window.Window_Message.prototype._hookedText) return;
        const p = window.Window_Message.prototype;
        const original = p.update;
        if (typeof original !== "function") return;
        p.update = function () {
          if (cheatsEnabled() && window.rmmz_cheats?.instantText) {
            this._showFast = true;
            this._lineShowFast = true;
          }
          return original.call(this);
        };
        p._hookedText = true;
      };

      const hookNoClip = () => {
        if (!window.Game_Player || window.Game_Player.prototype._hookedNoclip) return;
        const p = window.Game_Player.prototype;
        const original = p.isMapPassable;
        if (typeof original !== "function") return;
        p.isMapPassable = function () {
          if (cheatsEnabled() && window.rmmz_cheats?.noClip) return true;
          return original.apply(this, arguments);
        };
        p._hookedNoclip = true;
      };

      const hookNoEncounters = () => {
        if (!window.Game_Player || window.Game_Player.prototype._hookedEnc) return;
        const p = window.Game_Player.prototype;
        const original = p.canEncounter;
        if (typeof original !== "function") return;
        p.canEncounter = function () {
          if (cheatsEnabled() && window.rmmz_cheats?.noEncounter) return false;
          return original.apply(this, arguments);
        };
        p._hookedEnc = true;
      };

      const hookGodMode = () => {
        if (!window.Game_Actor) return;
        const p = window.Game_Actor.prototype;
        if (p._hookedGodMode) return;

        const gainHp = p.gainHp;
        if (typeof gainHp === "function") {
          p.gainHp = function (value) {
            if (cheatsEnabled() && window.rmmz_cheats?.godMode && value < 0) value = 0;
            return gainHp.call(this, value);
          };
        }

        const gainMp = p.gainMp;
        if (typeof gainMp === "function") {
          p.gainMp = function (value) {
            if (cheatsEnabled() && window.rmmz_cheats?.godMode && value < 0) value = 0;
            return gainMp.call(this, value);
          };
        }

        p._hookedGodMode = true;
      };

      const hookInfiniteItems = () => {
        if (!window.Game_Party) return;
        const p = window.Game_Party.prototype;
        if (p._hookedInfItems) return;
        const original = p.consumeItem;
        if (typeof original !== "function") return;
        p.consumeItem = function (item) {
          if (cheatsEnabled() && window.rmmz_cheats?.infiniteItems) return;
          return original.call(this, item);
        };
        p._hookedInfItems = true;
      };

      const hookInfiniteCosts = () => {
        if (!window.Game_BattlerBase) return;
        const p = window.Game_BattlerBase.prototype;
        if (p._hookedInfCosts) return;
        const original = p.paySkillCost;
        if (typeof original !== "function") return;
        p.paySkillCost = function (skill) {
          if (cheatsEnabled() && window.rmmz_cheats?.infiniteCosts) return;
          return original.call(this, skill);
        };
        p._hookedInfCosts = true;
      };

      const hookAlwaysDash = () => {
        if (!window.Game_Player) return;
        const p = window.Game_Player.prototype;
        if (p._hookedAlwaysDash) return;
        const original = p.isDashing;
        if (typeof original !== "function") return;
        p.isDashing = function () {
          if (cheatsEnabled() && window.rmmz_cheats?.alwaysDash) return true;
          return original.call(this);
        };
        p._hookedAlwaysDash = true;
      };

      const hookAlwaysEscape = () => {
        if (!window.BattleManager || window.BattleManager._hookedAlwaysEscape) return;
        const original = window.BattleManager.canEscape;
        if (typeof original !== "function") return;
        window.BattleManager.canEscape = function () {
          if (cheatsEnabled() && window.rmmz_cheats?.alwaysEscape) return true;
          return original.call(this);
        };
        window.BattleManager._hookedAlwaysEscape = true;
      };

      const hookNoGameOver = () => {
        if (
          !window.SceneManager ||
          !window.Scene_Gameover ||
          window.SceneManager._hookedNoGameOver
        ) {
          return;
        }
        const original = window.SceneManager.goto;
        if (typeof original !== "function") return;
        window.SceneManager.goto = function (sceneClass) {
          if (
            cheatsEnabled() &&
            window.rmmz_cheats?.noGameOver &&
            sceneClass === window.Scene_Gameover
          ) {
            if (window.Scene_Map) return original.call(this, window.Scene_Map);
            return;
          }
          return original.call(this, sceneClass);
        };
        window.SceneManager._hookedNoGameOver = true;
      };

      const hookDamageAndHitCrit = () => {
        if (!window.Game_Action) return;
        const p = window.Game_Action.prototype;
        if (p._hookedDmgHitCrit) return;

        const makeDamageValue = p.makeDamageValue;
        if (typeof makeDamageValue === "function") {
          p.makeDamageValue = function (target, critical) {
            let val = makeDamageValue.call(this, target, critical);

            try {
              if (
                cheatsEnabled() &&
                window.rmmz_cheats?.oneHitKill &&
                target?.isEnemy?.() &&
                (this.subject?.() ? this.subject().isActor?.() : false)
              ) {
                return 9999999;
              }
            } catch {}

            try {
              const m = cheatsEnabled() ? Number(window.rmmz_cheats?.dmgMult) || 1 : 1;
              const subj = this.subject?.();
              if (m !== 1 && val > 0 && subj?.isActor?.()) {
                val = Math.floor(val * m);
              }
            } catch {}

            return val;
          };
        }

        const itemHit = p.itemHit;
        if (typeof itemHit === "function") {
          p.itemHit = function (target) {
            if (cheatsEnabled() && window.rmmz_cheats?.alwaysHit) return 1;
            return itemHit.call(this, target);
          };
        }

        const itemEva = p.itemEva;
        if (typeof itemEva === "function") {
          p.itemEva = function (target) {
            if (cheatsEnabled() && window.rmmz_cheats?.alwaysHit) return 0;
            return itemEva.call(this, target);
          };
        }

        const itemCri = p.itemCri;
        if (typeof itemCri === "function") {
          p.itemCri = function (target) {
            if (cheatsEnabled() && window.rmmz_cheats?.alwaysCrit) return 1;
            return itemCri.call(this, target);
          };
        }

        p._hookedDmgHitCrit = true;
      };

      const hookExpMult = () => {
        if (!window.Game_Actor) return;
        const p = window.Game_Actor.prototype;
        if (p._hookedExpMult) return;
        const gainExp = p.gainExp;
        if (typeof gainExp !== "function") return;
        p.gainExp = function (exp) {
          const m = cheatsEnabled() ? Number(window.rmmz_cheats?.expMult) || 1 : 1;
          const scaled = m !== 1 ? Math.floor(Number(exp || 0) * m) : exp;
          return gainExp.call(this, scaled);
        };
        p._hookedExpMult = true;
      };

      const hookStateImmunity = () => {
        if (!window.Game_Battler) return;
        const p = window.Game_Battler.prototype;
        if (p._hookedStateImmune) return;
        const addState = p.addState;
        if (typeof addState !== "function") return;
        p.addState = function (stateId) {
          try {
            if (
              cheatsEnabled() &&
              window.rmmz_cheats?.immuneStates &&
              this.isActor?.() &&
              Number(stateId) !== 1
            ) {
              return;
            }
          } catch {}
          return addState.call(this, stateId);
        };
        p._hookedStateImmune = true;
      };

      const hookShopCheats = () => {
        if (window.Scene_Shop && !window.Scene_Shop.prototype._hookedAllShop) {
          const p = window.Scene_Shop.prototype;
          const prepare = p.prepare;
          if (typeof prepare === "function") {
            p.prepare = function (goods, purchaseOnly) {
              try {
                if (cheatsEnabled() && window.rmmz_cheats?.showAllShop) {
                  const g = [];
                  const items = window.$dataItems || [];
                  const weps = window.$dataWeapons || [];
                  const arms = window.$dataArmors || [];
                  for (let i = 1; i < items.length; i++) if (items[i]) g.push([0, i, 0, 0]);
                  for (let i = 1; i < weps.length; i++) if (weps[i]) g.push([1, i, 0, 0]);
                  for (let i = 1; i < arms.length; i++) if (arms[i]) g.push([2, i, 0, 0]);
                  return prepare.call(this, g, purchaseOnly);
                }
              } catch {}
              return prepare.call(this, goods, purchaseOnly);
            };
          }
          p._hookedAllShop = true;
        }

        if (window.Game_Party && !window.Game_Party.prototype._hookedFreeShop) {
          const p = window.Game_Party.prototype;
          const loseGold = p.loseGold;
          if (typeof loseGold === "function") {
            p.loseGold = function (amount) {
              if (
                cheatsEnabled() &&
                window.rmmz_cheats?.freeShop &&
                amount > 0 &&
                inShopScene()
              ) {
                return;
              }
              return loseGold.call(this, amount);
            };
          }
          p._hookedFreeShop = true;
        }
      };

      const hookFastEvents = () => {
        if (!window.Game_Interpreter) return;
        const p = window.Game_Interpreter.prototype;
        if (p._hookedFastEvents) return;

        const updateWait = p.updateWait;
        if (typeof updateWait === "function") {
          p.updateWait = function () {
            if (cheatsEnabled() && window.rmmz_cheats?.fastEvents) {
              this._waitCount = 0;
              this._waitMode = "";
            }
            return updateWait.call(this);
          };
        }

        const wait = p.wait;
        if (typeof wait === "function") {
          p.wait = function (duration) {
            if (cheatsEnabled() && window.rmmz_cheats?.fastEvents) return;
            return wait.call(this, duration);
          };
        }

        const updateWaitCount = p.updateWaitCount;
        if (typeof updateWaitCount === "function") {
          p.updateWaitCount = function () {
            if (cheatsEnabled() && window.rmmz_cheats?.fastEvents) {
              this._waitCount = 0;
              return false;
            }
            return updateWaitCount.call(this);
          };
        }

        p._hookedFastEvents = true;
      };

      const tick = () => {
        hookSpeed();
        hookInstantText();
        hookNoClip();
        hookNoEncounters();
        hookGodMode();
        hookInfiniteItems();
        hookInfiniteCosts();
        hookAlwaysDash();
        hookAlwaysEscape();
        hookNoGameOver();
        hookDamageAndHitCrit();
        hookExpMult();
        hookStateImmunity();
        hookShopCheats();
        hookFastEvents();
      };

      const maxTries = 60 * 15;
      let tries = 0;
      tick();
      const interval = setInterval(() => {
        tries++;
        try {
          tick();
        } catch {}
        if (tries >= maxTries) clearInterval(interval);
      }, 1000);
    }

    function startInGameToolsUi() {
      try {
        if (window.__maclauncher_toolsUiStarted) return;
        window.__maclauncher_toolsUiStarted = true;
      } catch {}

      const TOGGLES = [
        ["instantText", "Instant text"],
        ["noClip", "No clip"],
        ["noEncounter", "No encounters"],
        ["godMode", "God mode"],
        ["oneHitKill", "One-hit kill"],
        ["alwaysHit", "Always hit"],
        ["alwaysCrit", "Always crit"],
        ["immuneStates", "Immune to states"],
        ["infiniteItems", "Infinite items"],
        ["infiniteCosts", "No skill costs"],
        ["alwaysDash", "Always dash"],
        ["alwaysEscape", "Always escape"],
        ["noGameOver", "No game over"],
        ["fastEvents", "Fast events"],
        ["showAllShop", "Show all shop items"],
        ["freeShop", "Free shop"]
      ];

      const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

      const getCheats = () => {
        try {
          const c =
            window.rmmz_cheats && typeof window.rmmz_cheats === "object"
              ? window.rmmz_cheats
              : null;
          if (c) return c;
          window.rmmz_cheats = { ...DEFAULT_CHEATS, ...(cheats || {}) };
          return window.rmmz_cheats;
        } catch {
          return { ...DEFAULT_CHEATS, ...(cheats || {}) };
        }
      };

      const stop = e => {
        try {
          e.stopPropagation();
        } catch {}
      };

      const run = () => {
        try {
          if (!document?.body) return;
          if (document.getElementById("maclauncher-tools")) return;

          const style = document.createElement("style");
          style.id = "maclauncher-tools-style";
          style.textContent = `
#maclauncher-tools{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#e6e9ef}
#maclauncher-tools *{box-sizing:border-box}
#maclauncher-tools .handle{position:absolute;top:50%;right:0;transform:translateY(-50%);pointer-events:auto;writing-mode:vertical-rl;text-orientation:mixed;background:rgba(15,23,36,.92);border:1px solid rgba(255,255,255,.18);border-right:0;border-radius:12px 0 0 12px;padding:10px 8px;font-size:12px;letter-spacing:.2px;cursor:pointer;user-select:none}
#maclauncher-tools .handle:hover{background:rgba(15,23,36,.98)}
#maclauncher-tools.open .handle{display:none}
#maclauncher-tools .panel{position:absolute;top:0;right:0;width:340px;height:100%;pointer-events:auto;transform:translateX(100%);transition:transform 160ms ease;background:rgba(15,23,36,.94);border-left:1px solid rgba(255,255,255,.12);backdrop-filter:blur(12px);box-shadow:-18px 0 50px rgba(0,0,0,.35);display:flex;flex-direction:column}
#maclauncher-tools.open .panel{transform:translateX(0)}
#maclauncher-tools .header{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 12px;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(17,28,45,.9)}
#maclauncher-tools .title{font-weight:650;font-size:13px;letter-spacing:.2px}
#maclauncher-tools .subtitle{margin-top:2px;font-size:11px;color:rgba(230,233,239,.72)}
#maclauncher-tools .close{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:6px 10px;font-size:12px;cursor:pointer}
#maclauncher-tools .close:hover{background:rgba(255,255,255,.07)}
#maclauncher-tools .body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:12px}
#maclauncher-tools .section{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.02);border-radius:12px;padding:10px 10px}
#maclauncher-tools .row{display:flex;justify-content:space-between;align-items:center;gap:10px}
#maclauncher-tools .label{font-size:12px;color:rgba(230,233,239,.8)}
#maclauncher-tools .value{font-size:12px;color:rgba(230,233,239,.85)}
#maclauncher-tools .range{width:100%}
#maclauncher-tools .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-top:10px}
#maclauncher-tools .check{display:flex;gap:8px;align-items:center;font-size:12px;color:rgba(230,233,239,.88);user-select:none}
#maclauncher-tools input[type="checkbox"]{accent-color:#7aa2ff}
#maclauncher-tools .btnRow{display:flex;gap:8px;flex-wrap:wrap}
#maclauncher-tools .btn{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:7px 10px;font-size:12px;cursor:pointer}
#maclauncher-tools .btn:hover{background:rgba(255,255,255,.07)}
`;
          document.head.appendChild(style);

          const root = document.createElement("div");
          root.id = "maclauncher-tools";
          root.innerHTML = `
  <button class="handle" type="button" aria-label="Open tools">Tools</button>
  <div class="panel" role="dialog" aria-label="MacLauncher tools">
    <div class="header">
      <div>
        <div class="title">MacLauncher Tools</div>
        <div class="subtitle">Toggle: Ctrl/Cmd + Shift + T</div>
      </div>
      <button class="close" type="button">Close</button>
    </div>
    <div class="body">
      <div class="section">
        <label class="check">
          <input id="mcg-enabled" type="checkbox" />
          <span>Enable cheats</span>
        </label>
      </div>

      <div class="section">
        <div class="row">
          <div class="label">Speed</div>
          <div class="value"><span id="mcg-speed-val">1.0</span>x</div>
        </div>
        <input class="range" id="mcg-speed" type="range" min="1" max="10" step="0.5" />

        <div style="height:10px"></div>

        <div class="row">
          <div class="label">Damage mult</div>
          <div class="value"><span id="mcg-dmg-val">1.0</span>x</div>
        </div>
        <input class="range" id="mcg-dmg" type="range" min="0" max="50" step="0.5" />

        <div style="height:10px"></div>

        <div class="row">
          <div class="label">EXP mult</div>
          <div class="value"><span id="mcg-exp-val">1.0</span>x</div>
        </div>
        <input class="range" id="mcg-exp" type="range" min="0" max="50" step="0.5" />
      </div>

      <div class="section">
        <div class="label">Toggles</div>
        <div class="grid" id="mcg-toggles"></div>
      </div>

      <div class="btnRow">
        <button class="btn" id="mcg-reset" type="button">Reset</button>
      </div>
    </div>
  </div>
`;
          document.body.appendChild(root);

          const panel = root.querySelector(".panel");
          const handle = root.querySelector(".handle");
          const closeBtn = root.querySelector(".close");
          const togglesEl = root.querySelector("#mcg-toggles");

          const elEnabled = root.querySelector("#mcg-enabled");
          const elSpeed = root.querySelector("#mcg-speed");
          const elSpeedVal = root.querySelector("#mcg-speed-val");
          const elDmg = root.querySelector("#mcg-dmg");
          const elDmgVal = root.querySelector("#mcg-dmg-val");
          const elExp = root.querySelector("#mcg-exp");
          const elExpVal = root.querySelector("#mcg-exp-val");
          const elReset = root.querySelector("#mcg-reset");

          if (
            !panel ||
            !handle ||
            !closeBtn ||
            !togglesEl ||
            !(elEnabled instanceof HTMLInputElement) ||
            !(elSpeed instanceof HTMLInputElement) ||
            !elSpeedVal ||
            !(elDmg instanceof HTMLInputElement) ||
            !elDmgVal ||
            !(elExp instanceof HTMLInputElement) ||
            !elExpVal ||
            !elReset
          ) {
            return;
          }

          for (const [key, label] of TOGGLES) {
            const wrap = document.createElement("label");
            wrap.className = "check";
            wrap.innerHTML = `<input type="checkbox" data-key="${key}" /> <span>${label}</span>`;
            togglesEl.appendChild(wrap);
          }

          const toggleUi = open => {
            root.classList.toggle("open", Boolean(open));
          };

          const syncFromState = () => {
            const c = getCheats();

            elEnabled.checked = Boolean(c.enabled);

            const speedRaw = Number(c.speed);
            const speed = clamp(Number.isFinite(speedRaw) ? speedRaw : 1, 1, 10);
            elSpeed.value = String(speed);
            elSpeedVal.textContent = speed.toFixed(1);

            const dmgRaw = Number(c.dmgMult);
            const dmg = clamp(Number.isFinite(dmgRaw) ? dmgRaw : 1, 0, 50);
            elDmg.value = String(dmg);
            elDmgVal.textContent = dmg.toFixed(1);

            const expRaw = Number(c.expMult);
            const exp = clamp(Number.isFinite(expRaw) ? expRaw : 1, 0, 50);
            elExp.value = String(exp);
            elExpVal.textContent = exp.toFixed(1);

            togglesEl.querySelectorAll('input[type="checkbox"][data-key]').forEach(inp => {
              const k = inp.getAttribute("data-key");
              if (!k) return;
              inp.checked = Boolean(c[k]);
            });
          };

          const applyEnabled = enabled => {
            const c = getCheats();
            c.enabled = Boolean(enabled);
            scheduleCheatsFileWrite();
          };

          const applySpeed = value => {
            const c = getCheats();
            const parsed = Number(value);
            const v = clamp(Number.isFinite(parsed) ? parsed : 1, 1, 10);
            c.speed = v;
            elSpeedVal.textContent = v.toFixed(1);
            scheduleCheatsFileWrite();
          };

          const applyDmg = value => {
            const c = getCheats();
            const parsed = Number(value);
            const v = clamp(Number.isFinite(parsed) ? parsed : 1, 0, 50);
            c.dmgMult = v;
            elDmgVal.textContent = v.toFixed(1);
            scheduleCheatsFileWrite();
          };

          const applyExp = value => {
            const c = getCheats();
            const parsed = Number(value);
            const v = clamp(Number.isFinite(parsed) ? parsed : 1, 0, 50);
            c.expMult = v;
            elExpVal.textContent = v.toFixed(1);
            scheduleCheatsFileWrite();
          };

          handle.addEventListener("click", e => {
            stop(e);
            toggleUi(true);
            syncFromState();
          });

          closeBtn.addEventListener("click", e => {
            stop(e);
            toggleUi(false);
          });

          elEnabled.addEventListener("change", e => {
            stop(e);
            applyEnabled(elEnabled.checked);
          });
          elSpeed.addEventListener("input", e => {
            stop(e);
            applySpeed(elSpeed.value);
          });
          elDmg.addEventListener("input", e => {
            stop(e);
            applyDmg(elDmg.value);
          });
          elExp.addEventListener("input", e => {
            stop(e);
            applyExp(elExp.value);
          });

          togglesEl.addEventListener("change", e => {
            stop(e);
            const target = e.target;
            if (!(target instanceof HTMLInputElement)) return;
            const key = target.getAttribute("data-key");
            if (!key) return;
            const c = getCheats();
            c[key] = target.checked;
            scheduleCheatsFileWrite();
          });

          elReset.addEventListener("click", e => {
            stop(e);
            try {
              const c = getCheats();
              for (const k of Object.keys(DEFAULT_CHEATS)) c[k] = DEFAULT_CHEATS[k];
            } catch {}
            syncFromState();
            scheduleCheatsFileWrite();
          });

          root.addEventListener("mousedown", stop);
          root.addEventListener("mouseup", stop);
          root.addEventListener("click", stop);
          root.addEventListener("wheel", stop, { passive: false });
          root.addEventListener("keydown", stop);
          root.addEventListener("keyup", stop);
          root.addEventListener("keypress", stop);

          window.addEventListener(
            "keydown",
            e => {
              const key = String(e.key || "").toLowerCase();
              const mod = e.ctrlKey || e.metaKey;
              if (!mod || !e.shiftKey || key !== "t") return;
              try {
                e.preventDefault();
                e.stopPropagation();
              } catch {}
              const open = !root.classList.contains("open");
              toggleUi(open);
              if (open) syncFromState();
            },
            true
          );

          window.addEventListener("maclauncher:cheatsUpdated", syncFromState);
          syncFromState();
        } catch (e) {
          console.error("[MacLauncher] Failed to init tools UI:", e);
        }
      };

      try {
        if (document.readyState === "loading") {
          window.addEventListener("DOMContentLoaded", run, { once: true });
        } else {
          run();
        }
      } catch {
        try {
          run();
        } catch {}
      }
    }

    function ensureSaveDir() {
      if (!saveDir) return;
      fs.mkdirSync(saveDir, { recursive: true });
    }

    if (!window.__maclauncher_cheatsRuntimeInstalled) {
      initCheatsState();
      startCheatsFileSync();
      startCheatPatcher();
      startInGameToolsUi();
    }

    startStoragePatcher({ saveDir, webFrame });

    webFrame.executeJavaScript(buildGlobalInfoPatchScript(saveDir), true).catch(err => {
      console.error("[MacLauncher] Failed to inject global info patch:", err);
    });

    ensureSaveDir();
  }

  return {
    setup,
    install
  };
}

module.exports = {
  createRpgmakerElectronRuntime
};
