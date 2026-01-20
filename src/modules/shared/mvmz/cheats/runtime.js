const fs = require("fs");
const path = require("path");

function installCheatsRuntime(options) {
  const DEFAULT_CHEATS =
    options?.DEFAULT_CHEATS && typeof options.DEFAULT_CHEATS === "object"
      ? options.DEFAULT_CHEATS
      : null;
  const normalizeCheats = typeof options?.normalizeCheats === "function" ? options.normalizeCheats : null;

  if (!DEFAULT_CHEATS) throw new Error("installCheatsRuntime: missing DEFAULT_CHEATS");
  if (!normalizeCheats) throw new Error("installCheatsRuntime: missing normalizeCheats");

  const cheatsFilePath =
    typeof options?.cheatsFilePath === "string" && options.cheatsFilePath
      ? options.cheatsFilePath
      : null;
  const enableFileSync = options?.enableFileSync !== false;
  const enablePatcher = options?.enablePatcher !== false;
  const enableToolsUi = options?.enableToolsUi !== false;
  const toolsButtonVisible = options?.toolsButtonVisible !== false;

  const isElectron =
    typeof process === "object" &&
    process &&
    process.versions &&
    typeof process.versions.electron === "string" &&
    process.versions.electron;
  const toolsRuntimeLogPath =
    !isElectron && cheatsFilePath ? `${cheatsFilePath}.tools-runtime.log` : null;
  const logRuntime = msg => {
    try {
      if (!toolsRuntimeLogPath) return;
      try {
        fs.mkdirSync(path.dirname(toolsRuntimeLogPath), { recursive: true });
      } catch {}
      fs.appendFileSync(
        toolsRuntimeLogPath,
        "[" + new Date().toISOString() + "] " + String(msg || "") + "\n",
        "utf8"
      );
    } catch {}
  };

  logRuntime("installCheatsRuntime start");
  logRuntime(
    "cheatsFilePath=" +
      String(cheatsFilePath || "") +
      " enableFileSync=" +
      String(enableFileSync) +
      " enablePatcher=" +
      String(enablePatcher) +
      " enableToolsUi=" +
      String(enableToolsUi) +
      " toolsButtonVisible=" +
      String(toolsButtonVisible)
  );

  const globalWindow = (() => {
    try {
      return typeof globalThis === "object" && globalThis && typeof globalThis.window === "object"
        ? globalThis.window
        : null;
    } catch {
      return null;
    }
  })();
  const globalDocument = (() => {
    try {
      return typeof globalThis === "object" && globalThis && typeof globalThis.document === "object"
        ? globalThis.document
        : null;
    } catch {
      return null;
    }
  })();

  const nwDomWindow = (() => {
    try {
      if (typeof nw !== "object" || !nw) return null;
      if (!nw.Window || typeof nw.Window.get !== "function") return null;
      const w = nw.Window.get();
      return w && w.window ? w.window : null;
    } catch {
      return null;
    }
  })();

  const windowSource =
    options?.window && typeof options.window === "object"
      ? "options.window"
      : nwDomWindow
        ? "nw.Window.get().window"
        : globalWindow
          ? "globalThis.window"
          : "none";
  const hostWindow =
    options?.window && typeof options.window === "object"
      ? options.window
      : nwDomWindow || globalWindow;
  const documentSource =
    options?.document && typeof options.document === "object"
      ? "options.document"
      : (() => {
          try {
            return hostWindow && hostWindow.document ? "hostWindow.document" : globalDocument ? "globalThis.document" : "none";
          } catch {
            return globalDocument ? "globalThis.document" : "none";
          }
        })();
  const hostDocument =
    options?.document && typeof options.document === "object"
      ? options.document
      : (() => {
          try {
            return hostWindow && hostWindow.document ? hostWindow.document : globalDocument;
          } catch {
            return globalDocument;
          }
        })();

  // In NW.js context separation, CommonJS modules may not share the same global `document` as the page script.
  // Always bind to the actual page `window/document` (passed in or resolved via `nw.Window.get().window`).
  const window = hostWindow;
  const document = hostDocument;

  logRuntime(
    "domContext: hasWindow=" +
      String(Boolean(window)) +
      " hasDocument=" +
      String(Boolean(document))
  );
  logRuntime(
    "domContext: windowSource=" +
      String(windowSource) +
      " documentSource=" +
      String(documentSource)
  );
  try {
    logRuntime(
      "domContext: winType=" +
        String(Object.prototype.toString.call(window)) +
        " docType=" +
        String(Object.prototype.toString.call(document))
    );
  } catch {}
  try {
    logRuntime(
      "domContext: winHasNw=" +
        String(Boolean(window && window.nw)) +
        " winHasRequire=" +
        String(Boolean(window && typeof window.require === "function")) +
        " winHasProcess=" +
        String(Boolean(window && window.process))
    );
  } catch {}
  try {
    logRuntime(
      "domContext: href=" +
        String(window?.location?.href || "") +
        " documentURL=" +
        String(document?.URL || "") +
        " baseURI=" +
        String(document?.baseURI || "")
    );
  } catch {}
  try {
    logRuntime(
      "domContext: readyState=" +
        String(document?.readyState) +
        " hasBody=" +
        String(Boolean(document?.body)) +
        " hasHead=" +
        String(Boolean(document?.head))
    );
  } catch {}
  try {
    logRuntime(
      "domContext: docEqWinDoc=" +
        String(Boolean(window && document && window.document === document)) +
        " winEqGlobal=" +
        String(Boolean(window && globalWindow && window === globalWindow)) +
        " docEqGlobal=" +
        String(Boolean(document && globalDocument && document === globalDocument))
    );
  } catch {}

  if (!window || !document) {
    logRuntime("fatal: could not resolve DOM window/document");
    throw new Error("installCheatsRuntime: could not resolve DOM window/document");
  }

  const dom = (() => {
    const out = {
      Element: null,
      HTMLInputElement: null,
      HTMLButtonElement: null,
      HTMLStyleElement: null
    };
    try {
      out.Element = typeof window.Element === "function" ? window.Element : null;
    } catch {}
    try {
      out.HTMLInputElement = typeof window.HTMLInputElement === "function" ? window.HTMLInputElement : null;
    } catch {}
    try {
      out.HTMLButtonElement = typeof window.HTMLButtonElement === "function" ? window.HTMLButtonElement : null;
    } catch {}
    try {
      out.HTMLStyleElement = typeof window.HTMLStyleElement === "function" ? window.HTMLStyleElement : null;
    } catch {}
    return out;
  })();

  const isElementNode = el => {
    try {
      if (!el || typeof el !== "object") return false;
      if (dom.Element && el instanceof dom.Element) return true;
      return el.nodeType === 1 && typeof el.tagName === "string";
    } catch {
      return false;
    }
  };

  const isInputElement = el => {
    try {
      if (!el || typeof el !== "object") return false;
      if (dom.HTMLInputElement && el instanceof dom.HTMLInputElement) return true;
      return String(el.tagName || "").toLowerCase() === "input";
    } catch {
      return false;
    }
  };

  const isButtonElement = el => {
    try {
      if (!el || typeof el !== "object") return false;
      if (dom.HTMLButtonElement && el instanceof dom.HTMLButtonElement) return true;
      return String(el.tagName || "").toLowerCase() === "button";
    } catch {
      return false;
    }
  };

  const dispatchToolsAction = action => {
    try {
      if (action === "toggle" && typeof window.__maclauncher_toolsUiV2RequestToggle === "function") {
        window.__maclauncher_toolsUiV2RequestToggle();
        return;
      }
      if (action === "open" && typeof window.__maclauncher_toolsUiV2RequestOpen === "function") {
        window.__maclauncher_toolsUiV2RequestOpen();
        return;
      }
      if (action === "close" && typeof window.__maclauncher_toolsUiV2RequestClose === "function") {
        window.__maclauncher_toolsUiV2RequestClose();
        return;
      }
    } catch {}

    const eventName =
      action === "open"
        ? "maclauncher:openTools"
        : action === "close"
          ? "maclauncher:closeTools"
          : "maclauncher:toggleTools";
    try {
      if (action === "toggle") {
        window.__maclauncher_toolsPendingOpen = !window.__maclauncher_toolsPendingOpen;
      } else {
        window.__maclauncher_toolsPendingOpen = action === "open";
      }
    } catch {}
    try {
      window.dispatchEvent(new Event(eventName));
    } catch {}
  };

  function installNwjsToolsMenu() {
    try {
      if (typeof process === "object" && process?.platform && process.platform !== "darwin") {
        return;
      }
    } catch {}

    try {
      if (window.__maclauncher_toolsMenuInstalled) return;
    } catch {}

    const nw = window.nw;
    if (!nw || typeof nw.Menu !== "function" || typeof nw.MenuItem !== "function") return;

    let testMenu = null;
    try {
      testMenu = new nw.Menu({ type: "menubar" });
    } catch {
      return;
    }
    if (!testMenu || typeof testMenu.append !== "function") return;

    let win = null;
    try {
      win = typeof nw.Window?.get === "function" ? nw.Window.get() : null;
    } catch {}
    if (!win) return;

    let menu = win.menu;
    if (!menu || typeof menu.append !== "function") {
      try {
        menu = new nw.Menu({ type: "menubar" });
        if (typeof menu.createMacBuiltin === "function") {
          menu.createMacBuiltin("MacLauncher");
        }
        win.menu = menu;
      } catch {
        return;
      }
    }

    try {
      const items = Array.isArray(menu.items) ? menu.items : [];
      if (items.some(item => item && item.label === "Tools")) {
        window.__maclauncher_toolsMenuInstalled = true;
        return;
      }
    } catch {}

    try {
      const toolsMenu = new nw.Menu();
      toolsMenu.append(
        new nw.MenuItem({
          label: "Toggle Tools Panel",
          click: () => dispatchToolsAction("toggle")
        })
      );
      toolsMenu.append(
        new nw.MenuItem({
          label: "Open Tools Panel",
          click: () => dispatchToolsAction("open")
        })
      );
      toolsMenu.append(
        new nw.MenuItem({
          label: "Close Tools Panel",
          click: () => dispatchToolsAction("close")
        })
      );
      menu.append(new nw.MenuItem({ label: "Tools", submenu: toolsMenu }));
      window.__maclauncher_toolsMenuInstalled = true;
    } catch (e) {
      logRuntime(
        "toolsMenu failed: " +
          String(e && (e.stack || e.message) ? e.stack || e.message : e)
      );
    }
  }

  const isStyleElement = el => {
    try {
      if (!el || typeof el !== "object") return false;
      if (dom.HTMLStyleElement && el instanceof dom.HTMLStyleElement) return true;
      return String(el.tagName || "").toLowerCase() === "style";
    } catch {
      return false;
    }
  };

  const describeEl = el => {
    try {
      if (!el) return "null";
      const tag = String(el.tagName || "");
      const ctor = el && el.constructor && el.constructor.name ? String(el.constructor.name) : "";
      const btnWin = dom.HTMLButtonElement ? el instanceof dom.HTMLButtonElement : null;
      const inpWin = dom.HTMLInputElement ? el instanceof dom.HTMLInputElement : null;
      return `${tag || "?"}/${ctor || "?"} btnWin=${String(btnWin)} inpWin=${String(inpWin)}`;
    } catch {
      return "err";
    }
  };

  const schema =
    options?.schema && typeof options.schema === "object"
      ? options.schema
      : (() => {
          try {
            return require("./schema.json");
          } catch {
            return null;
          }
        })();
  const schemaFields = Array.isArray(schema?.fields) ? schema.fields : null;

  try {
    if (window.__maclauncher_cheatsRuntimeInstalled) {
      const existing = window.__maclauncher_cheatsRuntimeInstalled;
      logRuntime("already installed: ensuring existing runtime");
      try {
        if (enablePatcher && typeof existing?.ensurePatcher === "function") {
          existing.ensurePatcher();
        }
      } catch (e) {
        logRuntime(
          "ensurePatcher failed: " + String(e && (e.stack || e.message) ? e.stack || e.message : e)
        );
      }
      try {
        if (enableToolsUi && typeof existing?.ensureToolsUi === "function") {
          existing.ensureToolsUi();
        }
      } catch (e) {
        logRuntime(
          "ensureToolsUi failed: " + String(e && (e.stack || e.message) ? e.stack || e.message : e)
        );
      }
      return existing;
    }
  } catch {}

  const safeNormalize = input => {
    try {
      return normalizeCheats(input);
    } catch {
      return { ...DEFAULT_CHEATS };
    }
  };

  const getCheatsState = () => {
    try {
      const c =
        window.rmmz_cheats && typeof window.rmmz_cheats === "object" ? window.rmmz_cheats : null;
      if (c) return c;
      window.rmmz_cheats = { ...DEFAULT_CHEATS };
      return window.rmmz_cheats;
    } catch {
      return { ...DEFAULT_CHEATS };
    }
  };

  const mergeCheatsState = nextCheats => {
    const current = getCheatsState();
    const normalized = safeNormalize(nextCheats);
    let changed = false;
    for (const k of Object.keys(DEFAULT_CHEATS)) {
      if (current[k] !== normalized[k]) {
        current[k] = normalized[k];
        changed = true;
      }
    }
    if (changed) {
      try {
        window.dispatchEvent(new Event("maclauncher:cheatsUpdated"));
      } catch {}
    }
    return changed;
  };

  let lastWrittenJson = null;
  let writeTimer = null;
  const writeCheatsFileNow = nextCheats => {
    if (!cheatsFilePath) return false;
    let json = null;
    try {
      json = JSON.stringify(safeNormalize(nextCheats), null, 2);
    } catch {
      json = JSON.stringify({ ...DEFAULT_CHEATS }, null, 2);
    }
    if (json === lastWrittenJson) return true;
    try {
      fs.mkdirSync(path.dirname(cheatsFilePath), { recursive: true });
    } catch {}
    try {
      fs.writeFileSync(cheatsFilePath, json, "utf8");
      lastWrittenJson = json;
      return true;
    } catch {
      return false;
    }
  };

  const scheduleCheatsFileWrite = () => {
    if (!cheatsFilePath) return;
    if (!enableFileSync) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        writeCheatsFileNow(getCheatsState());
      } catch {}
    }, 150);
  };

  const readCheatsFile = () => {
    if (!cheatsFilePath) return null;
    if (!enableFileSync) return null;
    try {
      if (!fs.existsSync(cheatsFilePath)) return null;
      const raw = fs.readFileSync(cheatsFilePath, "utf8");
      lastWrittenJson = JSON.stringify(safeNormalize(JSON.parse(raw)), null, 2);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const initialCheats =
    options && "initialCheats" in options ? safeNormalize(options.initialCheats) : null;
  const fromFile = enableFileSync ? safeNormalize(readCheatsFile()) : null;
  const merged = {
    ...DEFAULT_CHEATS,
    ...getCheatsState(),
    ...(fromFile || {}),
    ...(initialCheats || {})
  };
  mergeCheatsState(merged);

  if (enableFileSync) {
    try {
      writeCheatsFileNow(getCheatsState());
    } catch {}
  }

  let lastMtimeMs = 0;
  if (enableFileSync && cheatsFilePath) {
    try {
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
      const parsed = readCheatsFile();
      if (!parsed) return;
      mergeCheatsState(parsed);
    }, 500);
  }

  function startCheatPatcher() {
    try {
      if (window.__maclauncher_cheatPatcherStarted) return;
      window.__maclauncher_cheatPatcherStarted = true;
    } catch {}

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
        const c = getCheatsState();
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
          const m = cheatsEnabled() ? Number(getCheatsState()?.speed) || 1 : 1;
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
        if (cheatsEnabled() && getCheatsState()?.instantText) {
          this._showFast = true;
          this._lineShowFast = true;
        }
        return original.call(this);
      };
      p._hookedText = true;
    };

    const hookMessageSkip = () => {
      if (window.Window_Message && !window.Window_Message.prototype._hookedMessageSkip) {
        const p = window.Window_Message.prototype;

        const updateShowFast = p.updateShowFast;
        if (typeof updateShowFast === "function") {
          p.updateShowFast = function () {
            const ret = updateShowFast.call(this);
            if (cheatsEnabled() && getCheatsState()?.messageSkip) {
              this._showFast = true;
              this._pauseSkip = true;
            }
            return ret;
          };
        }

        const updateInput = p.updateInput;
        if (typeof updateInput === "function") {
          p.updateInput = function () {
            const ret = updateInput.call(this);
            if (this.pause && cheatsEnabled() && getCheatsState()?.messageSkip) {
              this.pause = false;
              if (!this._textState) {
                try {
                  this.terminateMessage();
                } catch {}
              }
              return true;
            }
            return ret;
          };
        }

        p._hookedMessageSkip = true;
      }

      if (window.Window_ScrollText && !window.Window_ScrollText.prototype._hookedMessageSkip) {
        const p = window.Window_ScrollText.prototype;
        const scrollSpeed = p.scrollSpeed;
        if (typeof scrollSpeed === "function") {
          p.scrollSpeed = function () {
            let v = scrollSpeed.call(this);
            if (cheatsEnabled() && getCheatsState()?.messageSkip) v *= 100;
            return v;
          };
        }
        p._hookedMessageSkip = true;
      }

      if (window.Window_BattleLog && !window.Window_BattleLog.prototype._hookedMessageSkip) {
        const p = window.Window_BattleLog.prototype;
        const messageSpeed = p.messageSpeed;
        if (typeof messageSpeed === "function") {
          p.messageSpeed = function () {
            let v = messageSpeed.call(this);
            if (cheatsEnabled() && getCheatsState()?.messageSkip) v = 1;
            return v;
          };
        }
        p._hookedMessageSkip = true;
      }
    };

    const applyMoveSpeed = (() => {
      let lastDesired = null;
      return () => {
        if (!cheatsEnabled()) {
          lastDesired = null;
          return;
        }
        const c = getCheatsState();
        if (!c) return;
        if (!window.$gamePlayer || typeof window.$gamePlayer.setMoveSpeed !== "function") return;

        const raw = Number(c.moveSpeed);
        if (!Number.isFinite(raw)) return;
        const desired = Math.min(10, Math.max(1, raw));

        const lock = Boolean(c.lockMoveSpeed);

        let current = null;
        try {
          if (typeof window.$gamePlayer.moveSpeed === "function") {
            current = Number(window.$gamePlayer.moveSpeed());
          } else if (typeof window.$gamePlayer._moveSpeed === "number") {
            current = Number(window.$gamePlayer._moveSpeed);
          }
        } catch {}

        const desiredChanged =
          lastDesired == null || Math.abs(Number(lastDesired) - Number(desired)) > 1e-6;
        const differsNow = current == null || Math.abs(Number(current) - Number(desired)) > 1e-6;

        if (desiredChanged || (lock && differsNow)) {
          try {
            window.$gamePlayer.setMoveSpeed(desired);
          } catch {}
          lastDesired = desired;
        }
      };
    })();

    const hookNoClip = () => {
      if (!window.Game_Player || window.Game_Player.prototype._hookedNoclip) return;
      const p = window.Game_Player.prototype;
      const original = p.isMapPassable;
      if (typeof original !== "function") return;
      p.isMapPassable = function () {
        if (cheatsEnabled() && getCheatsState()?.noClip) return true;
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
        if (cheatsEnabled() && getCheatsState()?.noEncounter) return false;
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
          if (cheatsEnabled() && getCheatsState()?.godMode && value < 0) value = 0;
          return gainHp.call(this, value);
        };
      }

      const gainMp = p.gainMp;
      if (typeof gainMp === "function") {
        p.gainMp = function (value) {
          if (cheatsEnabled() && getCheatsState()?.godMode && value < 0) value = 0;
          return gainMp.call(this, value);
        };
      }

      p._hookedGodMode = true;
    };

    const hookInfiniteItems = () => {
      if (!window.Game_Party || window.Game_Party.prototype._hookedInfItems) return;
      const p = window.Game_Party.prototype;
      const consumeItem = p.consumeItem;
      if (typeof consumeItem !== "function") return;
      p.consumeItem = function () {
        if (cheatsEnabled() && getCheatsState()?.infiniteItems) return;
        return consumeItem.apply(this, arguments);
      };
      p._hookedInfItems = true;
    };

    const hookInfiniteCosts = () => {
      if (!window.Game_BattlerBase || window.Game_BattlerBase.prototype._hookedInfCosts) return;
      const p = window.Game_BattlerBase.prototype;
      const paySkillCost = p.paySkillCost;
      if (typeof paySkillCost !== "function") return;
      p.paySkillCost = function () {
        if (cheatsEnabled() && getCheatsState()?.infiniteCosts) return;
        return paySkillCost.apply(this, arguments);
      };
      p._hookedInfCosts = true;
    };

    const hookAlwaysDash = () => {
      if (!window.Game_Player || window.Game_Player.prototype._hookedDash) return;
      const p = window.Game_Player.prototype;
      const isDashing = p.isDashing;
      if (typeof isDashing !== "function") return;
      p.isDashing = function () {
        if (cheatsEnabled() && getCheatsState()?.alwaysDash) return true;
        return isDashing.apply(this, arguments);
      };
      p._hookedDash = true;
    };

    const hookAlwaysEscape = () => {
      if (!window.BattleManager || window.BattleManager._hookedEscape) return;
      const orig = window.BattleManager.canEscape;
      if (typeof orig !== "function") return;
      window.BattleManager.canEscape = function () {
        if (cheatsEnabled() && getCheatsState()?.alwaysEscape) return true;
        return orig.apply(this, arguments);
      };
      window.BattleManager._hookedEscape = true;
    };

    const hookNoGameOver = () => {
      if (!window.SceneManager || window.SceneManager._hookedNoGameOver) return;
      const origGoto = window.SceneManager.goto;
      if (typeof origGoto !== "function") return;
      window.SceneManager.goto = function (sceneClass) {
        try {
          if (cheatsEnabled() && getCheatsState()?.noGameOver && sceneClass === window.Scene_Gameover) {
            return;
          }
        } catch {}
        return origGoto.call(this, sceneClass);
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
              getCheatsState()?.oneHitKill &&
              target?.isEnemy?.() &&
              (this.subject?.() ? this.subject().isActor?.() : false)
            ) {
              return 9999999;
            }
          } catch {}

          try {
            const m = cheatsEnabled() ? Number(getCheatsState()?.dmgMult) || 1 : 1;
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
          if (cheatsEnabled() && getCheatsState()?.alwaysHit) return 1;
          return itemHit.call(this, target);
        };
      }

      const itemEva = p.itemEva;
      if (typeof itemEva === "function") {
        p.itemEva = function (target) {
          if (cheatsEnabled() && getCheatsState()?.alwaysHit) return 0;
          return itemEva.call(this, target);
        };
      }

      const itemCri = p.itemCri;
      if (typeof itemCri === "function") {
        p.itemCri = function (target) {
          if (cheatsEnabled() && getCheatsState()?.alwaysCrit) return 1;
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
        const m = cheatsEnabled() ? Number(getCheatsState()?.expMult) || 1 : 1;
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
          if (cheatsEnabled() && getCheatsState()?.immuneStates && this.isActor?.() && Number(stateId) !== 1) {
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
              if (cheatsEnabled() && getCheatsState()?.showAllShop) {
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
            if (cheatsEnabled() && getCheatsState()?.freeShop && amount > 0 && inShopScene()) {
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
          if (cheatsEnabled() && getCheatsState()?.fastEvents) {
            this._waitCount = 0;
            this._waitMode = "";
          }
          return updateWait.call(this);
        };
      }

      const wait = p.wait;
      if (typeof wait === "function") {
        p.wait = function (duration) {
          if (cheatsEnabled() && getCheatsState()?.fastEvents) return;
          return wait.call(this, duration);
        };
      }

      const updateWaitCount = p.updateWaitCount;
      if (typeof updateWaitCount === "function") {
        p.updateWaitCount = function () {
          if (cheatsEnabled() && getCheatsState()?.fastEvents) {
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
      hookMessageSkip();
      applyMoveSpeed();
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
      ["messageSkip", "Skip messages"],
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
      ["freeShop", "Free shop"],
      ["lockMoveSpeed", "Lock move speed"]
    ];

    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

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
#maclauncher-tools{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;font-size:12px;line-height:1.25;color:#e6e9ef}
#maclauncher-tools *{box-sizing:border-box}
#maclauncher-tools button,#maclauncher-tools input,#maclauncher-tools select{font:inherit;color:inherit}
#maclauncher-tools button{appearance:none;-webkit-appearance:none}
#maclauncher-tools button:focus-visible,#maclauncher-tools input:focus-visible,#maclauncher-tools select:focus-visible{outline:2px solid rgba(122,162,255,.55);outline-offset:2px}
#maclauncher-tools .handle{position:absolute;top:50%;right:0;transform:translateY(-50%);pointer-events:auto;writing-mode:vertical-rl;text-orientation:mixed;background:rgba(15,23,36,.92);border:1px solid rgba(255,255,255,.18);border-right:0;border-radius:12px 0 0 12px;padding:10px 8px;font-size:12px;letter-spacing:.2px;cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:center;line-height:1}
#maclauncher-tools .handle:hover{background:rgba(15,23,36,.98)}
#maclauncher-tools.open .handle{display:none}
#maclauncher-tools.hide-handle .handle{display:none}
#maclauncher-tools .panel{position:absolute;top:0;right:0;width:340px;height:100%;pointer-events:auto;transform:translateX(100%);transition:transform 160ms ease;background:rgba(15,23,36,.94);border-left:1px solid rgba(255,255,255,.12);backdrop-filter:blur(12px);box-shadow:-18px 0 50px rgba(0,0,0,.35);display:flex;flex-direction:column}
#maclauncher-tools.open .panel{transform:translateX(0)}
#maclauncher-tools .header{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 12px;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(17,28,45,.9)}
#maclauncher-tools .title{font-weight:650;font-size:13px;letter-spacing:.2px}
#maclauncher-tools .subtitle{margin-top:2px;font-size:11px;color:rgba(230,233,239,.72)}
#maclauncher-tools .close{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:0 10px;height:30px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1}
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
        if (!toolsButtonVisible) root.classList.add("hide-handle");
        root.innerHTML = `
  <button class="handle" type="button" aria-label="Open tools">Tools</button>
  <div class="panel" role="dialog" aria-modal="false">
    <div class="header">
      <div>
        <div class="title">MacLauncher Tools</div>
        <div class="subtitle">⇧⌘T to toggle</div>
      </div>
      <button class="close" type="button" aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.7 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29 10.59 10.6 16.89 4.29z"
          />
        </svg>
      </button>
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
          <div class="label">Game speed</div>
          <div class="value"><span id="mcg-speed-val">1.0</span>x</div>
        </div>
        <input class="range" id="mcg-speed" type="range" min="1" max="10" step="0.5" />

        <div style="height:10px"></div>

        <div class="row">
          <div class="label">Move speed</div>
          <div class="value"><span id="mcg-move-val">4.0</span></div>
        </div>
        <input class="range" id="mcg-move" type="range" min="1" max="10" step="0.5" />

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
        const elMove = root.querySelector("#mcg-move");
        const elMoveVal = root.querySelector("#mcg-move-val");
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
          !isInputElement(elEnabled) ||
          !isInputElement(elSpeed) ||
          !elSpeedVal ||
          !isInputElement(elMove) ||
          !elMoveVal ||
          !isInputElement(elDmg) ||
          !elDmgVal ||
          !isInputElement(elExp) ||
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
          const c = getCheatsState();

          elEnabled.checked = Boolean(c.enabled);

          const speedRaw = Number(c.speed);
          const speed = clamp(Number.isFinite(speedRaw) ? speedRaw : 1, 1, 10);
          elSpeed.value = String(speed);
          elSpeedVal.textContent = speed.toFixed(1);

          const moveRaw = Number(c.moveSpeed);
          const move = clamp(Number.isFinite(moveRaw) ? moveRaw : 4, 1, 10);
          elMove.value = String(move);
          elMoveVal.textContent = move.toFixed(1);

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
          const c = getCheatsState();
          c.enabled = Boolean(enabled);
          scheduleCheatsFileWrite();
        };

        const applySpeed = value => {
          const c = getCheatsState();
          const parsed = Number(value);
          const v = clamp(Number.isFinite(parsed) ? parsed : 1, 1, 10);
          c.speed = v;
          elSpeedVal.textContent = v.toFixed(1);
          scheduleCheatsFileWrite();
        };

        const applyMoveSpeed = value => {
          const c = getCheatsState();
          const parsed = Number(value);
          const v = clamp(Number.isFinite(parsed) ? parsed : 4, 1, 10);
          c.moveSpeed = v;
          elMoveVal.textContent = v.toFixed(1);
          scheduleCheatsFileWrite();
        };

        const applyDmg = value => {
          const c = getCheatsState();
          const parsed = Number(value);
          const v = clamp(Number.isFinite(parsed) ? parsed : 1, 0, 50);
          c.dmgMult = v;
          elDmgVal.textContent = v.toFixed(1);
          scheduleCheatsFileWrite();
        };

        const applyExp = value => {
          const c = getCheatsState();
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
        elMove.addEventListener("input", e => {
          stop(e);
          applyMoveSpeed(elMove.value);
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
          if (!isInputElement(target)) return;
          const key = target.getAttribute("data-key");
          if (!key) return;
          const c = getCheatsState();
          c[key] = target.checked;
          scheduleCheatsFileWrite();
        });

        elReset.addEventListener("click", e => {
          stop(e);
          try {
            const c = getCheatsState();
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

    const ensureUi = () => {
      try {
        if (!document?.body) return;
        if (document.getElementById("maclauncher-tools")) return;
        run();
      } catch {}
    };

    try {
      if (!window.__maclauncher_toolsUiV2KeepAlive) {
        window.__maclauncher_toolsUiV2KeepAlive = setInterval(ensureUi, 750);
      }
    } catch {}

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

    try {
      setTimeout(ensureUi, 0);
      setTimeout(ensureUi, 250);
      setTimeout(ensureUi, 1000);
      setTimeout(ensureUi, 2500);
    } catch {}
  }

  function startInGameToolsUiV2() {
    logRuntime("toolsUiV2 start");
    let alreadyStarted = false;
    try {
      alreadyStarted = Boolean(window.__maclauncher_toolsUiStartedV2);
      window.__maclauncher_toolsUiStartedV2 = true;
    } catch {}
    if (alreadyStarted) logRuntime("toolsUiV2 already started (ensuring)");

    const fields = Array.isArray(schemaFields)
      ? schemaFields.filter(
          f => f && typeof f.key === "string" && (f.type === "boolean" || f.type === "number")
        )
      : [];

    const fieldByKey = new Map();
    for (const f of fields) fieldByKey.set(String(f.key), f);

    const pages = [
      { id: "common", label: "Quick" },
      { id: "cheats", label: "Toggles" },
      { id: "actions", label: "Actions" },
      { id: "inventory", label: "Inventory" },
      { id: "teleport", label: "Teleport" },
      { id: "data", label: "Vars/Switches" },
      { id: "actors", label: "Actors" }
    ];

    const actionMeta = [
      { id: "gotoTitle", label: "Go to title", page: "actions" },
      { id: "toggleSaveScene", label: "Open Save scene", page: "actions" },
      { id: "toggleLoadScene", label: "Open Load scene", page: "actions" },
      { id: "quickSave", label: "Quick save", page: "actions" },
      { id: "quickLoad", label: "Quick load", page: "actions" },
      { id: "recoverAllParty", label: "Recover party", page: "actions" },
      { id: "setAllPartyHp", label: "Set party HP", page: "actions" },
      { id: "setAllPartyMp", label: "Set party MP", page: "actions" },
      { id: "setAllPartyTp", label: "Set party TP", page: "actions" },
      { id: "setAllEnemyHp", label: "Set enemy HP", page: "actions" },
      { id: "forceEncounter", label: "Force encounter", page: "actions" },
      { id: "forceVictory", label: "Force victory", page: "actions" },
      { id: "forceDefeat", label: "Force defeat", page: "actions" },
      { id: "forceEscape", label: "Force escape", page: "actions" },
      { id: "forceAbort", label: "Force abort", page: "actions" },
      { id: "startBattle", label: "Start battle (troop)", page: "actions" },
      { id: "setGold", label: "Set gold", page: "inventory" },
      { id: "setItemAmount", label: "Set item amount", page: "inventory" },
      { id: "teleport", label: "Teleport", page: "teleport" },
      { id: "saveLocation", label: "Save location", page: "teleport" },
      { id: "recallLocation", label: "Recall location", page: "teleport" },
      { id: "setVariable", label: "Set variable", page: "data" },
      { id: "toggleSwitch", label: "Toggle switch", page: "data" },
      { id: "setActorLevel", label: "Set actor level", page: "actors" },
      { id: "setActorExp", label: "Set actor EXP", page: "actors" },
      { id: "addActorExp", label: "Give actor EXP", page: "actors" },
      { id: "setActorParam", label: "Set actor parameter", page: "actors" },
      { id: "clearActorStates", label: "Clear actor states", page: "actors" },
      { id: "clearPartyStates", label: "Clear party states", page: "actors" },
      { id: "addSkill", label: "Add skill", page: "actors" },
      { id: "renameActor", label: "Rename actor", page: "actors" },
      { id: "changeClass", label: "Change class", page: "actors" }
    ];

    const stop = e => {
      try {
        e.stopPropagation();
      } catch {}
    };

    const clamp = (n, min, max) => {
      if (!Number.isFinite(n)) return min;
      if (Number.isFinite(min)) n = Math.max(min, n);
      if (Number.isFinite(max)) n = Math.min(max, n);
      return n;
    };

    const parseVariableValue = raw => {
      const s = String(raw ?? "").trim();
      if (!s) return "";
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      if (s === "true") return true;
      if (s === "false") return false;
      if (s === "null") return null;
      if (s === "undefined") return undefined;
      return raw;
    };

    const decimalsForStep = step => {
      const s = Number(step);
      if (!Number.isFinite(s)) return 0;
      if (Math.abs(s - Math.round(s)) < 1e-9) return 0;
      return 1;
    };

    let pendingOpen = false;
    let isOpenFn = null;
    let setOpenFn = null;
    try {
      if (typeof window.__maclauncher_toolsPendingOpen === "boolean") {
        pendingOpen = Boolean(window.__maclauncher_toolsPendingOpen);
        window.__maclauncher_toolsPendingOpen = false;
      }
    } catch {}

    const isTypingElementActive = () => {
      try {
        const el = document.activeElement;
        if (!isElementNode(el)) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return true;
        if (el.isContentEditable) return true;
      } catch {}
      return false;
    };

    const stopHotkey = e => {
      try {
        e.preventDefault();
        e.stopImmediatePropagation?.();
        e.stopPropagation();
      } catch {}
    };

    const setPendingOpen = next => {
      pendingOpen = Boolean(next);
      try {
        window.__maclauncher_toolsPendingOpen = pendingOpen;
      } catch {}
      logRuntime("toolsUiV2 pendingOpen=" + String(pendingOpen));
    };

    const requestToggle = () => {
      logRuntime(
        "toolsUiV2 requestToggle (hasSetOpenFn=" +
          String(typeof setOpenFn === "function") +
          " hasIsOpenFn=" +
          String(typeof isOpenFn === "function") +
          " pendingOpen=" +
          String(pendingOpen) +
          ")"
      );
      try {
        if (typeof isOpenFn === "function" && typeof setOpenFn === "function") {
          setOpenFn(!isOpenFn());
          return;
        }
      } catch {}
      setPendingOpen(!pendingOpen);
    };

    const requestClose = () => {
      logRuntime("toolsUiV2 requestClose");
      try {
        if (typeof setOpenFn === "function") setOpenFn(false);
      } catch {}
      setPendingOpen(false);
    };

    const requestOpen = () => {
      logRuntime("toolsUiV2 requestOpen");
      try {
        if (typeof setOpenFn === "function") setOpenFn(true);
        else setPendingOpen(true);
      } catch {
        setPendingOpen(true);
      }
    };

    try {
      window.__maclauncher_toolsUiV2RequestToggle = requestToggle;
      window.__maclauncher_toolsUiV2RequestClose = requestClose;
      window.__maclauncher_toolsUiV2RequestOpen = requestOpen;
    } catch {}

    try {
      if (!window.__maclauncher_toolsUiV2HotkeysInstalled) {
        window.__maclauncher_toolsUiV2HotkeysInstalled = true;
        window.addEventListener(
          "keydown",
          e => {
            const key = String(e.key || "");
            const keyLower = key.toLowerCase();
            const isTyping = isTypingElementActive();

            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.shiftKey && keyLower === "t") {
              stopHotkey(e);
              try {
                window.__maclauncher_toolsUiV2RequestToggle?.();
              } catch {}
              return;
            }

            if (!isTyping && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && key === "1") {
              stopHotkey(e);
              try {
                window.__maclauncher_toolsUiV2RequestToggle?.();
              } catch {}
              return;
            }

            if (keyLower === "escape") {
              const root = document.getElementById("maclauncher-tools");
              let pending = false;
              try {
                pending = Boolean(window.__maclauncher_toolsPendingOpen);
              } catch {}
              const open = pending || (root && root.classList.contains("open"));
              if (!open) return;
              stopHotkey(e);
              try {
                window.__maclauncher_toolsUiV2RequestClose?.();
              } catch {}
            }
          },
          true
        );
      }
    } catch {}

    try {
      if (!window.__maclauncher_toolsUiV2EventsInstalled) {
        window.__maclauncher_toolsUiV2EventsInstalled = true;
        window.addEventListener("maclauncher:toggleTools", () => {
          try {
            window.__maclauncher_toolsUiV2RequestToggle?.();
          } catch {}
        });
        window.addEventListener("maclauncher:closeTools", () => {
          try {
            window.__maclauncher_toolsUiV2RequestClose?.();
          } catch {}
        });
        window.addEventListener("maclauncher:openTools", () => {
          try {
            window.__maclauncher_toolsUiV2RequestOpen?.();
          } catch {}
        });
      }
    } catch {}

    let loggedNoBody = false;
    let uiMountedCount = 0;
    const run = () => {
      try {
        if (!document?.body) {
          if (!loggedNoBody) {
            loggedNoBody = true;
            logRuntime("toolsUiV2 run: document.body missing (readyState=" + String(document?.readyState) + ")");
          }
          return;
        }
        const existing = document.getElementById("maclauncher-tools");
        if (existing) {
          const inited = existing.getAttribute("data-mcg-init") === "1";
          if (inited) return;
          logRuntime("toolsUiV2 run: found existing root without init; remounting");
          try {
            existing.remove?.();
          } catch {
            try {
              existing.parentNode?.removeChild?.(existing);
            } catch {}
          }
        }

        uiMountedCount++;
        logRuntime("toolsUiV2 run: mount attempt " + String(uiMountedCount));

        let style = document.getElementById("maclauncher-tools-style");
        if (!isStyleElement(style)) {
          style = document.createElement("style");
          style.id = "maclauncher-tools-style";
          style.textContent = `
#maclauncher-tools{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;font-size:12px;line-height:1.25;color:#e6e9ef}
#maclauncher-tools *{box-sizing:border-box}
#maclauncher-tools button,#maclauncher-tools input,#maclauncher-tools select{font:inherit;color:inherit}
#maclauncher-tools button{appearance:none;-webkit-appearance:none}
#maclauncher-tools button:focus-visible,#maclauncher-tools input:focus-visible,#maclauncher-tools select:focus-visible{outline:2px solid rgba(122,162,255,.55);outline-offset:2px}
#maclauncher-tools .handle{position:absolute;top:50%;right:0;transform:translateY(-50%);pointer-events:auto;writing-mode:vertical-rl;text-orientation:mixed;background:rgba(15,23,36,.92);border:1px solid rgba(255,255,255,.18);border-right:0;border-radius:12px 0 0 12px;padding:10px 8px;font-size:12px;letter-spacing:.2px;cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:center;line-height:1}
#maclauncher-tools .handle:hover{background:rgba(15,23,36,.98)}
#maclauncher-tools.open .handle{display:none}
#maclauncher-tools.hide-handle .handle{display:none}
#maclauncher-tools .panel{position:absolute;top:0;right:0;width:380px;max-width:92vw;height:100%;pointer-events:auto;transform:translateX(100%);transition:transform 160ms ease;background:rgba(15,23,36,.94);border-left:1px solid rgba(255,255,255,.12);backdrop-filter:blur(12px);box-shadow:-18px 0 50px rgba(0,0,0,.35);display:flex;flex-direction:column}
#maclauncher-tools.open .panel{transform:translateX(0)}
#maclauncher-tools .header{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 12px;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(17,28,45,.9)}
#maclauncher-tools .title{font-weight:650;font-size:13px;letter-spacing:.2px}
#maclauncher-tools .subtitle{margin-top:2px;font-size:11px;color:rgba(230,233,239,.72)}
#maclauncher-tools .close{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:0 10px;height:30px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1}
#maclauncher-tools .close:hover{background:rgba(255,255,255,.07)}
#maclauncher-tools .toolbar{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)}
#maclauncher-tools .search{flex:1;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:0 12px;height:38px;line-height:38px;font-size:12px;outline:none}
#maclauncher-tools .search:focus{border-color:rgba(122,162,255,.6)}
#maclauncher-tools .iconBtn{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;width:38px;height:38px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
#maclauncher-tools .iconBtn:hover{background:rgba(255,255,255,.07)}
#maclauncher-tools .tabStrip{display:flex;align-items:center;gap:8px;padding:8px 12px 0;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(17,28,45,.9)}
#maclauncher-tools .tabNav{border:0;background:transparent;color:#e6e9ef;border-radius:8px;width:26px;height:26px;font-size:16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;line-height:1}
#maclauncher-tools .tabNav:hover{color:#fff}
#maclauncher-tools .tabNav:disabled{color:rgba(230,233,239,.35);cursor:default}
#maclauncher-tools .tabs{display:flex;align-items:flex-end;gap:6px;overflow:auto;scrollbar-width:none;flex:1;padding:0 2px}
#maclauncher-tools .tabs::-webkit-scrollbar{display:none}
#maclauncher-tools .tab{border:1px solid transparent;background:transparent;color:rgba(230,233,239,.82);border-radius:10px 10px 0 0;padding:0 10px;height:30px;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;line-height:1;margin-bottom:-1px}
#maclauncher-tools .tab:hover{background:rgba(255,255,255,.06)}
#maclauncher-tools .tab.active{border-color:rgba(255,255,255,.2);border-bottom-color:rgba(15,23,36,.94);background:rgba(255,255,255,.06);color:#e6e9ef}
#maclauncher-tools .body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:12px}
#maclauncher-tools .section{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.02);border-radius:12px;padding:10px 10px;display:flex;flex-direction:column;gap:10px}
#maclauncher-tools .sectionTitle{font-size:12px;font-weight:650;color:rgba(230,233,239,.88);margin:0}
#maclauncher-tools .row{display:flex;justify-content:space-between;align-items:center;gap:10px}
#maclauncher-tools .label{font-size:12px;color:rgba(230,233,239,.82)}
#maclauncher-tools .iconInline{display:inline-flex;align-items:center;margin-right:6px}
#maclauncher-tools .value{font-size:12px;color:rgba(230,233,239,.9)}
#maclauncher-tools .range{width:100%}
#maclauncher-tools .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;align-items:start}
#maclauncher-tools .grid1{display:grid;grid-template-columns:1fr;gap:8px}
#maclauncher-tools .check{display:flex;gap:8px;align-items:center;font-size:12px;color:rgba(230,233,239,.9);user-select:none}
#maclauncher-tools input[type="checkbox"]{accent-color:#7aa2ff;width:16px;height:16px}
#maclauncher-tools .btnRow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#maclauncher-tools .btn{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:0 10px;height:30px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1}
#maclauncher-tools .btn:hover{background:rgba(255,255,255,.07)}
#maclauncher-tools .btn.danger{border-color:rgba(255,99,132,.38)}
#maclauncher-tools .btn.primary{border-color:rgba(122,162,255,.6);background:rgba(122,162,255,.14)}
#maclauncher-tools .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
#maclauncher-tools .hint{margin:0;font-size:11px;color:rgba(230,233,239,.66);line-height:1.25}
#maclauncher-tools .input,#maclauncher-tools .select{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#e6e9ef;border-radius:10px;padding:0 9px;height:30px;line-height:30px;font-size:12px;outline:none;width:100%}
#maclauncher-tools .input:focus,#maclauncher-tools .select:focus{border-color:rgba(122,162,255,.6)}
#maclauncher-tools .stack{display:flex;flex-direction:column;gap:6px}
#maclauncher-tools .list{display:flex;flex-direction:column;gap:6px}
#maclauncher-tools .listRow{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02);border-radius:10px;padding:7px 8px;min-height:34px;font-size:12px;line-height:1.2}
#maclauncher-tools .listRow .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#maclauncher-tools .toast{position:absolute;left:12px;right:12px;bottom:12px;pointer-events:none;display:none}
#maclauncher-tools .toastInner{border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 10px;font-size:12px;background:rgba(17,28,45,.92);backdrop-filter:blur(10px)}
	#maclauncher-tools .toastInner.error{border-color:rgba(255,99,132,.4)}
	`;
          (document.head || document.documentElement || document.body).appendChild(style);
        }

        const root = document.createElement("div");
        root.id = "maclauncher-tools";
        if (!toolsButtonVisible) root.classList.add("hide-handle");
        root.innerHTML = `
	  <button class="handle" type="button" aria-label="Open tools">Tools</button>
	  <div class="panel" role="dialog" aria-label="MacLauncher tools">
    <div class="header">
      <div>
        <div class="title">MacLauncher Tools</div>
        <div class="subtitle">1 · Ctrl/Cmd + Shift + T</div>
      </div>
      <button class="close" type="button" aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.7 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29 10.59 10.6 16.89 4.29z"
          />
        </svg>
      </button>
    </div>
    <div class="toolbar">
      <input id="mcg-search" class="search" type="text" placeholder="Search cheats & actions…" />
      <button id="mcg-refresh" class="iconBtn" type="button" title="Refresh" aria-label="Refresh">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6c1.66 0 3.14.69 4.22 1.78L14 10h6V4l-2.35 2.35z"
          />
        </svg>
      </button>
    </div>
	    <div class="tabStrip">
	      <button id="mcg-tab-left" class="tabNav" type="button" aria-label="Scroll tabs left" title="Scroll tabs left">‹</button>
	      <div class="tabs" id="mcg-tabs" role="tablist"></div>
	      <button id="mcg-tab-right" class="tabNav" type="button" aria-label="Scroll tabs right" title="Scroll tabs right">›</button>
	    </div>
    <div class="body" id="mcg-body"></div>
	    <div class="toast" id="mcg-toast"><div class="toastInner" id="mcg-toast-inner"></div></div>
	  </div>
	`;
        document.body.appendChild(root);
        logRuntime("toolsUiV2 run: appended #maclauncher-tools");

        const handle = root.querySelector(".handle");
        const closeBtn = root.querySelector(".close");
        const tabLeftBtn = root.querySelector("#mcg-tab-left");
        const tabRightBtn = root.querySelector("#mcg-tab-right");
        const tabsEl = root.querySelector("#mcg-tabs");
        const bodyEl = root.querySelector("#mcg-body");
        const searchEl = root.querySelector("#mcg-search");
        const refreshBtn = root.querySelector("#mcg-refresh");
        const toastEl = root.querySelector("#mcg-toast");
        const toastInnerEl = root.querySelector("#mcg-toast-inner");

        if (
          !isButtonElement(handle) ||
          !isButtonElement(closeBtn) ||
          !isButtonElement(tabLeftBtn) ||
          !isButtonElement(tabRightBtn) ||
          !tabsEl ||
          !bodyEl ||
          !isInputElement(searchEl) ||
          !isButtonElement(refreshBtn) ||
          !toastEl ||
          !toastInnerEl
        ) {
          logRuntime(
            "toolsUiV2 run: missing expected elements; aborting init " +
              " handle=" +
              describeEl(handle) +
              " close=" +
              describeEl(closeBtn) +
              " left=" +
              describeEl(tabLeftBtn) +
              " right=" +
              describeEl(tabRightBtn) +
              " search=" +
              describeEl(searchEl) +
              " refresh=" +
              describeEl(refreshBtn)
          );
          try {
            root.remove?.();
          } catch {
            try {
              root.parentNode?.removeChild?.(root);
            } catch {}
          }
          return;
        }

        try {
          root.setAttribute("data-mcg-init", "1");
        } catch {}

        const ui = {
          page: "common",
          globalSearch: "",
          actionsSlot: 1,
          troopId: 1,
          aliveOnly: true,
          inventoryKind: "item",
          inventorySearch: "",
          inventoryOnlyOwned: false,
          inventoryHideNameless: false,
          teleportSearch: "",
          teleportX: "",
          teleportY: "",
          teleportAlias: "",
          dataTab: "variables",
          dataSearch: "",
          dataHideNameless: true,
          actorId: null,
          actorKeepExp: false,
          actorGiveExp: 0
        };

        let syncing = false;
        let toastTimer = null;
        let liveTimer = null;

        const showToast = (text, level = "info") => {
          try {
            if (toastTimer) clearTimeout(toastTimer);
            toastEl.style.display = "block";
            toastInnerEl.className = `toastInner${level === "error" ? " error" : ""}`;
            toastInnerEl.textContent = String(text || "");
            toastTimer = setTimeout(() => {
              toastTimer = null;
              toastEl.style.display = "none";
            }, 2800);
          } catch {}
        };

        const isOpen = () => root.classList.contains("open");

        const setOpen = open => {
          logRuntime("toolsUiV2 setOpen=" + String(Boolean(open)));
          root.classList.toggle("open", Boolean(open));
          try {
            const panel = root.querySelector(".panel");
            const cs =
              panel && typeof window.getComputedStyle === "function" ? window.getComputedStyle(panel) : null;
            logRuntime(
              "toolsUiV2 panelStyle " +
                "display=" +
                String(cs?.display || "") +
                " visibility=" +
                String(cs?.visibility || "") +
                " opacity=" +
                String(cs?.opacity || "") +
                " transform=" +
                String(cs?.transform || "") +
                " pointerEvents=" +
                String(cs?.pointerEvents || "") +
                " zIndex=" +
                String(cs?.zIndex || "")
            );
          } catch {}
          if (!open) {
            if (liveTimer) clearInterval(liveTimer);
            liveTimer = null;
            return;
          }
          ui.page = "common";
          ui.globalSearch = "";
          searchEl.value = "";
          render();
          if (!liveTimer) {
            liveTimer = setInterval(() => {
              if (!isOpen()) return;
              syncLive();
            }, 500);
          }
        };

        isOpenFn = isOpen;
        setOpenFn = setOpen;

        const clear = el => {
          while (el.firstChild) el.removeChild(el.firstChild);
        };

        const makeSection = title => {
          const section = document.createElement("div");
          section.className = "section";
          if (title) {
            const t = document.createElement("div");
            t.className = "sectionTitle";
            t.textContent = title;
            section.appendChild(t);
          }
          return section;
        };

        const makeButton = (text, onClick, opts = {}) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `btn${opts.primary ? " primary" : ""}${opts.danger ? " danger" : ""}`;
          btn.textContent = text;
          btn.addEventListener("click", e => {
            stop(e);
            try {
              onClick();
            } catch (err) {
              showToast(String(err?.message || err), "error");
            }
          });
          return btn;
        };

        const execAction = (label, fn, { successToast = true } = {}) => {
          try {
            if (!actions) throw new Error("Cheat actions not ready");
            const res = fn();
            if (res && typeof res.then === "function") {
              res
                .then(() => {
                  if (successToast) showToast(`${label}: OK`);
                })
                .catch(e => showToast(String(e?.message || e), "error"));
              return;
            }
            if (successToast) showToast(`${label}: OK`);
          } catch (e) {
            showToast(String(e?.message || e), "error");
          }
        };

        const getGold = () => {
          try {
            if (window.$gameParty?.gold) return Number(window.$gameParty.gold()) || 0;
            return Number(window.$gameParty?._gold) || 0;
          } catch {
            return 0;
          }
        };

        const getSceneName = () => {
          try {
            const s = window.SceneManager?._scene;
            const name = s?.constructor?.name;
            return name ? String(name) : "Unknown";
          } catch {
            return "Unknown";
          }
        };

        const getMasterVolumePercent = () => {
          try {
            const audio = window.AudioManager;
            if (!audio) return 100;
            const raw = Number.isFinite(audio.masterVolume)
              ? audio.masterVolume
              : Number.isFinite(audio._masterVolume)
                ? audio._masterVolume
                : null;
            if (Number.isFinite(raw)) return clamp(Math.round(raw * 100), 0, 200);
          } catch {}
          return 100;
        };

        const setMasterVolumePercent = next => {
          const parsed = Number(next);
          const percent = clamp(
            Number.isFinite(parsed) ? Math.round(parsed) : getMasterVolumePercent(),
            0,
            200
          );
          const value = percent / 100;
          let applied = false;
          try {
            if (window.AudioManager && "masterVolume" in window.AudioManager) {
              window.AudioManager.masterVolume = value;
              applied = true;
            }
          } catch {}
          if (!applied) {
            try {
              if (window.AudioManager && typeof window.AudioManager._masterVolume === "number") {
                window.AudioManager._masterVolume = value;
                window.WebAudio?.setMasterVolume?.(value);
                window.Graphics?.setVideoVolume?.(value);
                applied = true;
              }
            } catch {}
          }
          if (!applied) {
            try {
              if (window.AudioManager) {
                if ("bgmVolume" in window.AudioManager) window.AudioManager.bgmVolume = percent;
                if ("bgsVolume" in window.AudioManager) window.AudioManager.bgsVolume = percent;
                if ("meVolume" in window.AudioManager) window.AudioManager.meVolume = percent;
                if ("seVolume" in window.AudioManager) window.AudioManager.seVolume = percent;
              }
            } catch {}
          }
          return percent;
        };

        const syncLive = () => {
          try {
            root.querySelectorAll('[data-live="gold"]').forEach(el => {
              el.textContent = String(getGold());
            });
            root.querySelectorAll('[data-live="scene"]').forEach(el => {
              el.textContent = getSceneName();
            });
            root.querySelectorAll('[data-live="map"]').forEach(el => {
              try {
                const mapId = window.$gameMap?.mapId?.();
                const info = mapId ? window.$dataMapInfos?.[mapId] : null;
                const name = info?.name ? String(info.name) : "Unknown";
                el.textContent = mapId ? `${name} (#${mapId})` : "Unknown";
              } catch {
                el.textContent = "Unknown";
              }
            });
            root.querySelectorAll('[data-live="pos"]').forEach(el => {
              try {
                const x = window.$gamePlayer?.x;
                const y = window.$gamePlayer?.y;
                if (Number.isFinite(x) && Number.isFinite(y)) el.textContent = `${x}, ${y}`;
              } catch {}
            });
          } catch {}
        };

        const syncCheatControls = () => {
          const c = getCheatsState();
          const cheatsEnabled = Boolean(c.enabled);

          syncing = true;
          try {
            root.querySelectorAll('input[data-cheat-bool]').forEach(inp => {
              if (!isInputElement(inp)) return;
              const key = inp.getAttribute("data-cheat-bool");
              if (!key) return;
              inp.checked = Boolean(c[key]);
              const isMaster = inp.getAttribute("data-cheat-master") === "1";
              inp.disabled = !isMaster && !cheatsEnabled;
            });

            root.querySelectorAll('input[data-cheat-number]').forEach(inp => {
              if (!isInputElement(inp)) return;
              const key = inp.getAttribute("data-cheat-number");
              if (!key) return;
              const raw = Number(c[key]);
              const v = Number.isFinite(raw) ? raw : 0;
              inp.value = String(v);
              inp.disabled = !cheatsEnabled;

              const val = document.getElementById(`mcg-val-${key}`);
              if (val) {
                const dec = Number(val.getAttribute("data-decimals") || "0") || 0;
                val.textContent = dec > 0 ? v.toFixed(dec) : String(Math.round(v));
              }
            });
          } catch {}
          syncing = false;

          syncLive();
        };

        const renderCheatField = (field, parent) => {
          const key = String(field.key || "");
          if (!key) return;

          if (field.type === "boolean") {
            const label = document.createElement("label");
            label.className = "check";
            label.id = `mcg-field-${key}`;

            const input = document.createElement("input");
            input.type = "checkbox";
            input.setAttribute("data-cheat-bool", key);
            if (key === "enabled") input.setAttribute("data-cheat-master", "1");

            const span = document.createElement("span");
            span.textContent = String(field.label || key);

            input.addEventListener("change", e => {
              stop(e);
              if (syncing) return;
              const checked = input.checked;
              mergeCheatsState({ ...getCheatsState(), [key]: checked });
              scheduleCheatsFileWrite();
              syncCheatControls();
            });

            label.appendChild(input);
            label.appendChild(span);
            parent.appendChild(label);
            return;
          }

          if (field.type === "number") {
            const wrap = document.createElement("div");
            wrap.className = "grid1";
            wrap.id = `mcg-field-${key}`;

            const header = document.createElement("div");
            header.className = "row";

            const left = document.createElement("div");
            left.className = "label";
            left.textContent = String(field.label || key);

            const right = document.createElement("div");
            right.className = "value";
            const valueSpan = document.createElement("span");
            valueSpan.id = `mcg-val-${key}`;
            valueSpan.setAttribute("data-decimals", String(decimalsForStep(field.step ?? 1)));
            right.appendChild(valueSpan);

            header.appendChild(left);
            header.appendChild(right);

            const range = document.createElement("input");
            range.className = "range";
            range.type = "range";
            if (field.min != null) range.min = String(field.min);
            if (field.max != null) range.max = String(field.max);
            range.step = String(field.step ?? 1);
            range.setAttribute("data-cheat-number", key);

            range.addEventListener("input", e => {
              stop(e);
              if (syncing) return;
              const raw = Number(range.value);
              const min = Number.isFinite(Number(field.min)) ? Number(field.min) : -Infinity;
              const max = Number.isFinite(Number(field.max)) ? Number(field.max) : Infinity;
              const v = clamp(Number.isFinite(raw) ? raw : 0, min, max);
              mergeCheatsState({ ...getCheatsState(), [key]: v });
              scheduleCheatsFileWrite();
              syncCheatControls();
            });

            wrap.appendChild(header);
            wrap.appendChild(range);
            parent.appendChild(wrap);
          }
        };

        const focusField = key => {
          try {
            document.getElementById(`mcg-field-${key}`)?.scrollIntoView?.({ block: "nearest" });
          } catch {}
        };

        const updateTabNavState = () => {
          try {
            const max = Math.max(0, tabsEl.scrollWidth - tabsEl.clientWidth);
            const left = tabsEl.scrollLeft;
            const hasOverflow = max > 2;
            tabLeftBtn.disabled = !hasOverflow || left <= 1;
            tabRightBtn.disabled = !hasOverflow || left >= max - 1;
          } catch {}
        };

        const scrollTabs = dir => {
          try {
            const amount = Math.max(140, Math.floor(tabsEl.clientWidth * 0.75));
            tabsEl.scrollBy({ left: dir * amount, behavior: "smooth" });
            setTimeout(updateTabNavState, 180);
          } catch {}
        };

        const focusTabById = pageId => {
          try {
            const el = tabsEl.querySelector(`button.tab[data-page="${String(pageId)}"]`);
            el?.focus?.();
            el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
          } catch {}
        };

        const renderTabs = () => {
          const prevScrollLeft = tabsEl.scrollLeft;
          clear(tabsEl);
          for (const p of pages) {
            const isCurrent = ui.page === p.id;
            const isSelected = isCurrent && !ui.globalSearch;
            const b = document.createElement("button");
            b.type = "button";
            b.className = `tab${isSelected ? " active" : ""}`;
            b.setAttribute("data-page", p.id);
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", String(Boolean(isSelected)));
            b.tabIndex = isCurrent ? 0 : -1;
            b.textContent = p.label;
            b.addEventListener("click", e => {
              stop(e);
              ui.page = p.id;
              ui.globalSearch = "";
              searchEl.value = "";
              render();
            });
            b.addEventListener("keydown", e => {
              const key = String(e.key || "");
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
              try {
                e.preventDefault();
                e.stopPropagation();
              } catch {}

              const currentIdx = Math.max(0, pages.findIndex(pp => pp.id === p.id));
              let nextIdx = currentIdx;
              if (key === "ArrowLeft") nextIdx = (currentIdx - 1 + pages.length) % pages.length;
              else if (key === "ArrowRight") nextIdx = (currentIdx + 1) % pages.length;
              else if (key === "Home") nextIdx = 0;
              else if (key === "End") nextIdx = pages.length - 1;

              const next = pages[nextIdx];
              if (!next) return;
              ui.page = next.id;
              ui.globalSearch = "";
              searchEl.value = "";
              render();
              requestAnimationFrame(() => focusTabById(next.id));
            });
            tabsEl.appendChild(b);
          }
          tabsEl.scrollLeft = prevScrollLeft;
          requestAnimationFrame(() => {
            try {
              const el = tabsEl.querySelector(`button.tab[data-page="${String(ui.page)}"]`);
              el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
            } catch {}
            updateTabNavState();
          });
        };

        tabLeftBtn.addEventListener("click", e => {
          stop(e);
          scrollTabs(-1);
        });
        tabRightBtn.addEventListener("click", e => {
          stop(e);
          scrollTabs(1);
        });
        tabsEl.addEventListener("scroll", updateTabNavState, { passive: true });
        tabsEl.addEventListener(
          "wheel",
          e => {
            try {
              const max = tabsEl.scrollWidth - tabsEl.clientWidth;
              if (!(max > 2)) return;
              const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
              if (!delta) return;
              e.preventDefault();
              e.stopPropagation();
              tabsEl.scrollLeft += delta;
              updateTabNavState();
            } catch {}
          },
          { passive: false }
        );
        window.addEventListener("resize", updateTabNavState);

        const renderSearchPage = () => {
          clear(bodyEl);
          const q = String(ui.globalSearch || "").trim().toLowerCase();

          const sec = makeSection("Search");
          const list = document.createElement("div");
          list.className = "btnRow";

          const hits = [];
          for (const f of fields) {
            const label = String(f.label || f.key || "");
            const cat = String(f.category || "");
            const key = String(f.key || "");
            const hay = `${label} ${cat} ${key}`.toLowerCase();
            if (q && hay.includes(q)) hits.push({ type: "field", key, label, page: f.common ? "common" : "cheats" });
          }
          for (const a of actionMeta) {
            const hay = `${a.label} ${a.id}`.toLowerCase();
            if (q && hay.includes(q)) hits.push({ type: "action", id: a.id, label: a.label, page: a.page });
          }

          if (hits.length === 0) {
            sec.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No matches." }));
            bodyEl.appendChild(sec);
            return;
          }

          for (const h of hits.slice(0, 30)) {
            list.appendChild(
              makeButton(h.label, () => {
                ui.globalSearch = "";
                searchEl.value = "";
                ui.page = h.page;
                render();
                if (h.type === "field") focusField(h.key);
              }, { primary: h.type === "field" })
            );
          }

          sec.appendChild(list);
          sec.appendChild(
            Object.assign(document.createElement("div"), {
              className: "hint",
              textContent: "Tip: Inventory/Teleport/Vars pages include their own search boxes for large lists."
            })
          );
          bodyEl.appendChild(sec);
        };

        const renderCommonPage = () => {
          clear(bodyEl);

          const enabledField = fieldByKey.get("enabled");
          const commonFields = fields.filter(f => f?.common);
          const numbers = commonFields.filter(f => f.type === "number");
          const toggles = commonFields.filter(f => f.type === "boolean" && f.key !== "enabled");

          const master = makeSection("Enable");
          const grid = document.createElement("div");
          grid.className = "grid1";
          if (enabledField) renderCheatField(enabledField, grid);
          master.appendChild(grid);
          master.appendChild(
            Object.assign(document.createElement("div"), {
              className: "hint",
              textContent: "Cheats are enabled by default; individual cheats default off."
            })
          );
          bodyEl.appendChild(master);

          if (numbers.length) {
            const sec = makeSection("Common sliders");
            const g = document.createElement("div");
            g.className = "grid1";
            for (const f of numbers) renderCheatField(f, g);
            sec.appendChild(g);
            bodyEl.appendChild(sec);
          }

          if (toggles.length) {
            const sec = makeSection("Common toggles");
            const g = document.createElement("div");
            g.className = "grid2";
            for (const f of toggles) renderCheatField(f, g);
            sec.appendChild(g);
            bodyEl.appendChild(sec);
          }

          const volume = makeSection("Volume");
          const volumeGrid = document.createElement("div");
          volumeGrid.className = "grid1";
          const volumeRow = document.createElement("div");
          volumeRow.className = "row";
          const volumeLabel = document.createElement("div");
          volumeLabel.className = "label";
          volumeLabel.innerHTML =
            '<span class="iconInline"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.26 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></span>Volume';
          const volumeValue = document.createElement("div");
          volumeValue.className = "value";
          const volumeValueSpan = document.createElement("span");
          volumeValue.appendChild(volumeValueSpan);
          volumeRow.appendChild(volumeLabel);
          volumeRow.appendChild(volumeValue);
          volumeGrid.appendChild(volumeRow);

          const volumeRange = document.createElement("input");
          volumeRange.className = "range";
          volumeRange.type = "range";
          volumeRange.min = "0";
          volumeRange.max = "200";
          volumeRange.step = "1";
          const currentVolume = getMasterVolumePercent();
          volumeRange.value = String(currentVolume);
          volumeValueSpan.textContent = `${currentVolume}%`;
          volumeRange.addEventListener("input", e => {
            stop(e);
            const next = setMasterVolumePercent(volumeRange.value);
            volumeRange.value = String(next);
            volumeValueSpan.textContent = `${next}%`;
          });

          volumeGrid.appendChild(volumeRange);
          volume.appendChild(volumeGrid);
          bodyEl.appendChild(volume);

          const quick = makeSection("Quick actions");
          const btns = document.createElement("div");
          btns.className = "btnRow";
          btns.appendChild(makeButton("Recover party", () => execAction("Recover party", () => actions.recoverAllParty())));
          btns.appendChild(makeButton("Teleport…", () => {
            ui.page = "teleport";
            render();
          }));
          btns.appendChild(makeButton("Inventory…", () => {
            ui.page = "inventory";
            render();
          }));
          quick.appendChild(btns);
          quick.appendChild(
            Object.assign(document.createElement("div"), {
              className: "hint",
              innerHTML: `Scene: <span class="mono" data-live="scene"></span> · Map: <span data-live="map"></span> · Pos: <span class="mono" data-live="pos"></span>`
            })
          );
          bodyEl.appendChild(quick);
        };

        const renderCheatsPage = () => {
          clear(bodyEl);
          const reset = makeSection();
          const btns = document.createElement("div");
          btns.className = "btnRow";
          btns.appendChild(
            makeButton("Reset to defaults", () => {
              mergeCheatsState(DEFAULT_CHEATS);
              scheduleCheatsFileWrite();
              syncCheatControls();
            }, { danger: true })
          );
          reset.appendChild(btns);
          bodyEl.appendChild(reset);

          const order = [
            "Common",
            "Movement",
            "Text",
            "World",
            "Combat",
            "Inventory",
            "Shop",
            "Events",
            "System",
            "Other"
          ];

          const groups = new Map();
          for (const f of fields) {
            if (!f || f.key === "enabled") continue;
            const cat = String(f.category || "Other");
            if (!groups.has(cat)) groups.set(cat, []);
            groups.get(cat).push(f);
          }

          const cats = Array.from(groups.keys()).sort((a, b) => {
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            return a.localeCompare(b);
          });

          for (const cat of cats) {
            const sec = makeSection(cat);
            const list = document.createElement("div");
            list.className = "grid1";
            for (const f of groups.get(cat) || []) renderCheatField(f, list);
            sec.appendChild(list);
            bodyEl.appendChild(sec);
          }
        };

        const renderActionsPage = () => {
          clear(bodyEl);

          const sys = makeSection("System");
          const sysBtns = document.createElement("div");
          sysBtns.className = "btnRow";
          sysBtns.appendChild(
            makeButton(
              "Go to title",
              () => {
                const ok = window.confirm("Go to title? Unsaved progress may be lost.");
                if (!ok) return;
                execAction("Go to title", () => actions.gotoTitle());
              },
              { danger: true }
            )
          );
          sysBtns.appendChild(makeButton("Open Save", () => execAction("Save scene", () => actions.toggleSaveScene())));
          sysBtns.appendChild(makeButton("Open Load", () => execAction("Load scene", () => actions.toggleLoadScene())));
          sys.appendChild(sysBtns);
          bodyEl.appendChild(sys);

          const slot = makeSection("Quick save/load");
          const grid = document.createElement("div");
          grid.className = "grid2";
          const slotInput = document.createElement("input");
          slotInput.className = "input";
          slotInput.type = "number";
          slotInput.min = "1";
          slotInput.step = "1";
          slotInput.value = String(ui.actionsSlot);
          slotInput.addEventListener("change", () => {
            ui.actionsSlot = Math.max(1, Math.floor(Number(slotInput.value) || 1));
            slotInput.value = String(ui.actionsSlot);
          });
          const slotCol = document.createElement("div");
          slotCol.className = "stack";
          slotCol.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Slot" }));
          slotCol.appendChild(slotInput);
          grid.appendChild(slotCol);

          const quickBtns = document.createElement("div");
          quickBtns.className = "btnRow";
          quickBtns.appendChild(makeButton("Quick save", () => execAction("Quick save", () => actions.quickSave(ui.actionsSlot))));
          quickBtns.appendChild(
            makeButton(
              "Quick load",
              () => {
                const ok = window.confirm(`Quick load slot ${ui.actionsSlot}? Unsaved progress will be lost.`);
                if (!ok) return;
                execAction("Quick load", () => actions.quickLoad(ui.actionsSlot));
              },
              { danger: true }
            )
          );
          slot.appendChild(grid);
          slot.appendChild(quickBtns);
          bodyEl.appendChild(slot);

          const battle = makeSection("Battle");
          const bBtns = document.createElement("div");
          bBtns.className = "btnRow";
          bBtns.appendChild(makeButton("Force encounter", () => execAction("Force encounter", () => actions.forceEncounter())));
          bBtns.appendChild(makeButton("Victory", () => execAction("Victory", () => actions.forceVictory()), { primary: true }));
          bBtns.appendChild(makeButton("Defeat", () => execAction("Defeat", () => actions.forceDefeat()), { danger: true }));
          bBtns.appendChild(makeButton("Escape", () => execAction("Escape", () => actions.forceEscape())));
          bBtns.appendChild(makeButton("Abort", () => execAction("Abort", () => actions.forceAbort())));
          battle.appendChild(bBtns);

          const troopGrid = document.createElement("div");
          troopGrid.className = "grid2";
          const troopInput = document.createElement("input");
          troopInput.className = "input";
          troopInput.type = "number";
          troopInput.min = "1";
          troopInput.step = "1";
          troopInput.value = String(ui.troopId);
          troopInput.addEventListener("change", () => {
            ui.troopId = Math.max(1, Math.floor(Number(troopInput.value) || 1));
            troopInput.value = String(ui.troopId);
          });
          const troopCol = document.createElement("div");
          troopCol.className = "stack";
          troopCol.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Troop ID" }));
          troopCol.appendChild(troopInput);
          troopGrid.appendChild(troopCol);
          const startCol = document.createElement("div");
          startCol.className = "stack";
          startCol.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Start battle" }));
          startCol.appendChild(
            makeButton(
              "Start",
              () => {
                const ok = window.confirm(`Start battle with troop ${ui.troopId}?`);
                if (!ok) return;
                execAction("Start battle", () => actions.startBattle(ui.troopId, true, false));
              },
              { danger: true }
            )
          );
          troopGrid.appendChild(startCol);
          battle.appendChild(troopGrid);
          battle.appendChild(
            Object.assign(document.createElement("div"), {
              className: "hint",
              innerHTML: `Scene: <span class="mono" data-live="scene"></span>`
            })
          );
          bodyEl.appendChild(battle);

          const hp = makeSection("Party / Enemy");
          const aliveLabel = document.createElement("label");
          aliveLabel.className = "check";
          const aliveInp = document.createElement("input");
          aliveInp.type = "checkbox";
          aliveInp.checked = Boolean(ui.aliveOnly);
          aliveInp.addEventListener("change", () => (ui.aliveOnly = aliveInp.checked));
          aliveLabel.appendChild(aliveInp);
          aliveLabel.appendChild(Object.assign(document.createElement("span"), { textContent: "Alive only" }));
          hp.appendChild(aliveLabel);

          const partyBtns = document.createElement("div");
          partyBtns.className = "btnRow";
          partyBtns.appendChild(makeButton("Party HP 0", () => execAction("Party HP", () => actions.setAllPartyHp(0, ui.aliveOnly), { successToast: false })));
          partyBtns.appendChild(makeButton("Party HP 1", () => execAction("Party HP", () => actions.setAllPartyHp(1, ui.aliveOnly), { successToast: false })));
          partyBtns.appendChild(makeButton("Party MP 0", () => execAction("Party MP", () => actions.setAllPartyMp(0, ui.aliveOnly), { successToast: false })));
          partyBtns.appendChild(makeButton("Party MP 1", () => execAction("Party MP", () => actions.setAllPartyMp(1, ui.aliveOnly), { successToast: false })));
          partyBtns.appendChild(makeButton("Party TP 0", () => execAction("Party TP", () => actions.setAllPartyTp(0, ui.aliveOnly), { successToast: false })));
          partyBtns.appendChild(makeButton("Party TP 1", () => execAction("Party TP", () => actions.setAllPartyTp(1, ui.aliveOnly), { successToast: false })));
          partyBtns.appendChild(makeButton("Recover party", () => execAction("Recover party", () => actions.recoverAllParty()), { primary: true }));
          hp.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Party" }));
          hp.appendChild(partyBtns);

          const enemyBtns = document.createElement("div");
          enemyBtns.className = "btnRow";
          enemyBtns.appendChild(makeButton("Enemy HP 0", () => execAction("Enemy HP", () => actions.setAllEnemyHp(0, ui.aliveOnly), { successToast: false })));
          enemyBtns.appendChild(makeButton("Enemy HP 1", () => execAction("Enemy HP", () => actions.setAllEnemyHp(1, ui.aliveOnly), { successToast: false })));
          enemyBtns.appendChild(makeButton("Recover enemies", () => execAction("Recover enemies", () => actions.recoverAllEnemy())));
          hp.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Enemy" }));
          hp.appendChild(enemyBtns);
          bodyEl.appendChild(hp);
        };

        const renderInventoryPage = () => {
          clear(bodyEl);

          const gold = makeSection("Gold");
          const grid = document.createElement("div");
          grid.className = "grid2";
          const cur = document.createElement("div");
          cur.className = "hint";
          cur.innerHTML = `Current: <span class="mono" data-live="gold"></span>`;
          grid.appendChild(cur);
          const goldInput = document.createElement("input");
          goldInput.className = "input";
          goldInput.type = "number";
          goldInput.min = "0";
          goldInput.step = "1";
          goldInput.value = String(getGold());
          grid.appendChild(goldInput);
          gold.appendChild(grid);

          const btns = document.createElement("div");
          btns.className = "btnRow";
          btns.appendChild(
            makeButton(
              "Set",
              () => {
                const desired = Math.max(0, Math.floor(Number(goldInput.value) || 0));
                execAction("Set gold", () => actions.setGold(desired));
                goldInput.value = String(getGold());
              },
              { primary: true }
            )
          );
          btns.appendChild(makeButton("+1000", () => execAction("Add gold", () => actions.addGold(1000), { successToast: false })));
          btns.appendChild(makeButton("-1000", () => execAction("Add gold", () => actions.addGold(-1000), { successToast: false })));
          gold.appendChild(btns);
          bodyEl.appendChild(gold);

          const inv = makeSection("Items / Weapons / Armors");

          const kindRow = document.createElement("div");
          kindRow.className = "btnRow";
          const kinds = [
            { id: "item", label: "Items" },
            { id: "weapon", label: "Weapons" },
            { id: "armor", label: "Armors" }
          ];
          for (const k of kinds) {
            kindRow.appendChild(
              makeButton(k.label, () => {
                ui.inventoryKind = k.id;
                render();
              }, { primary: ui.inventoryKind === k.id })
            );
          }
          inv.appendChild(kindRow);

          const search = document.createElement("input");
          search.className = "input";
          search.type = "text";
          search.placeholder = "Search…";
          search.value = ui.inventorySearch;
          search.addEventListener("input", () => {
            ui.inventorySearch = search.value;
            render();
          });
          inv.appendChild(search);

          const flags = document.createElement("div");
          flags.className = "grid2";

          const owned = document.createElement("label");
          owned.className = "check";
          const ownedInp = document.createElement("input");
          ownedInp.type = "checkbox";
          ownedInp.checked = Boolean(ui.inventoryOnlyOwned);
          ownedInp.addEventListener("change", () => {
            ui.inventoryOnlyOwned = ownedInp.checked;
            render();
          });
          owned.appendChild(ownedInp);
          owned.appendChild(Object.assign(document.createElement("span"), { textContent: "Only owned" }));
          flags.appendChild(owned);

          const nameless = document.createElement("label");
          nameless.className = "check";
          const namelessInp = document.createElement("input");
          namelessInp.type = "checkbox";
          namelessInp.checked = Boolean(ui.inventoryHideNameless);
          namelessInp.addEventListener("change", () => {
            ui.inventoryHideNameless = namelessInp.checked;
            render();
          });
          nameless.appendChild(namelessInp);
          nameless.appendChild(Object.assign(document.createElement("span"), { textContent: "Hide nameless" }));
          flags.appendChild(nameless);

          inv.appendChild(flags);

          const list = document.createElement("div");
          list.className = "list";

          const db =
            ui.inventoryKind === "weapon"
              ? window.$dataWeapons
              : ui.inventoryKind === "armor"
                ? window.$dataArmors
                : window.$dataItems;

          if (!db || !window.$gameParty?.numItems) {
            list.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Game database not loaded yet." }));
          } else {
            const query = String(ui.inventorySearch || "").trim().toLowerCase();
            const out = [];
            for (let i = 1; i < db.length; i++) {
              const item = db[i];
              if (!item) continue;
              const name = String(item.name || "");
              if (ui.inventoryHideNameless && !name.trim()) continue;
              if (query && !name.toLowerCase().includes(query) && !String(i).includes(query)) continue;
              const count = window.$gameParty.numItems(item);
              if (ui.inventoryOnlyOwned && !(count > 0)) continue;
              out.push({ id: i, item, name, count });
              if (out.length >= 30) break;
            }

            for (const r of out) {
              const row = document.createElement("div");
              row.className = "listRow";

              const idEl = document.createElement("div");
              idEl.className = "mono";
              idEl.textContent = `#${r.id}`;

              const nameEl = document.createElement("div");
              nameEl.className = "name";
              nameEl.textContent = r.name || "(unnamed)";

              const amt = document.createElement("input");
              amt.className = "input";
              amt.type = "number";
              amt.min = "0";
              amt.step = "1";
              amt.value = String(r.count);
              amt.style.width = "90px";
              amt.addEventListener("change", () => {
                const desired = Math.max(0, Math.floor(Number(amt.value) || 0));
                execAction("Set amount", () => actions.setItemAmount(ui.inventoryKind, r.id, desired), { successToast: false });
                try {
                  amt.value = String(window.$gameParty.numItems(r.item));
                } catch {}
              });

              row.appendChild(idEl);
              row.appendChild(nameEl);
              row.appendChild(amt);
              list.appendChild(row);
            }

            if (out.length === 0) {
              list.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No matches." }));
            }
          }

          inv.appendChild(list);
          bodyEl.appendChild(inv);
        };

        const renderTeleportPage = () => {
          clear(bodyEl);

          const info = makeSection("Current");
          info.appendChild(
            Object.assign(document.createElement("div"), {
              className: "hint",
              innerHTML: `Map: <span data-live="map"></span> · Pos: <span class="mono" data-live="pos"></span>`
            })
          );
          bodyEl.appendChild(info);

          const tp = makeSection("Teleport");
          const xy = document.createElement("div");
          xy.className = "grid2";
          const xInp = document.createElement("input");
          xInp.className = "input";
          xInp.type = "number";
          xInp.step = "1";
          xInp.placeholder = "X";
          xInp.value = ui.teleportX || String(window.$gamePlayer?.x ?? 0);
          xInp.addEventListener("input", () => (ui.teleportX = xInp.value));
          const yInp = document.createElement("input");
          yInp.className = "input";
          yInp.type = "number";
          yInp.step = "1";
          yInp.placeholder = "Y";
          yInp.value = ui.teleportY || String(window.$gamePlayer?.y ?? 0);
          yInp.addEventListener("input", () => (ui.teleportY = yInp.value));
          const xCol = document.createElement("div");
          xCol.className = "stack";
          xCol.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "X" }));
          xCol.appendChild(xInp);
          xy.appendChild(xCol);
          const yCol = document.createElement("div");
          yCol.className = "stack";
          yCol.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Y" }));
          yCol.appendChild(yInp);
          xy.appendChild(yCol);
          tp.appendChild(xy);

          const mapSearch = document.createElement("input");
          mapSearch.className = "input";
          mapSearch.type = "text";
          mapSearch.placeholder = "Search maps…";
          mapSearch.value = ui.teleportSearch;
          mapSearch.addEventListener("input", () => {
            ui.teleportSearch = mapSearch.value;
            render();
          });
          tp.appendChild(mapSearch);

          const list = document.createElement("div");
          list.className = "list";
          const infos = window.$dataMapInfos || null;
          if (!infos) {
            list.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Map data not loaded yet." }));
          } else {
            const query = String(ui.teleportSearch || "").trim().toLowerCase();
            let shown = 0;
            for (let i = 1; i < infos.length; i++) {
              const mi = infos[i];
              if (!mi) continue;
              const name = String(mi.name || "");
              if (query && !name.toLowerCase().includes(query) && !String(i).includes(query)) continue;

              const row = document.createElement("div");
              row.className = "listRow";

              const idEl = document.createElement("div");
              idEl.className = "mono";
              idEl.textContent = `#${i}`;

              const nameEl = document.createElement("div");
              nameEl.className = "name";
              nameEl.textContent = name || "(unnamed)";

              const btn = makeButton("Go", () => {
                const x = Math.floor(Number(xInp.value) || 0);
                const y = Math.floor(Number(yInp.value) || 0);
                execAction("Teleport", () => actions.teleport(i, x, y));
              }, { primary: true });

              row.appendChild(idEl);
              row.appendChild(nameEl);
              row.appendChild(btn);
              list.appendChild(row);

              shown++;
              if (shown >= 25) break;
            }
            if (shown === 0) list.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No matches." }));
          }
          tp.appendChild(list);
          bodyEl.appendChild(tp);

          const saved = makeSection("Saved locations");
          const alias = document.createElement("input");
          alias.className = "input";
          alias.type = "text";
          alias.placeholder = "Alias (optional)…";
          alias.value = ui.teleportAlias;
          alias.addEventListener("input", () => (ui.teleportAlias = alias.value));
          saved.appendChild(alias);

          const btns = document.createElement("div");
          btns.className = "btnRow";
          btns.appendChild(
            makeButton(
              "Save current",
              () => {
                execAction("Save location", () => actions.saveLocation(ui.teleportAlias));
                ui.teleportAlias = "";
                alias.value = "";
                render();
              },
              { primary: true }
            )
          );
          saved.appendChild(btns);

          const locList = document.createElement("div");
          locList.className = "list";
          const locs = actions.listLocations();
          if (!locs.length) {
            locList.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No saved locations yet." }));
          } else {
            locs.forEach((loc, idx) => {
              const row = document.createElement("div");
              row.className = "listRow";

              const idEl = document.createElement("div");
              idEl.className = "mono";
              idEl.textContent = `#${idx + 1}`;

              const nameEl = document.createElement("div");
              nameEl.className = "name";
              nameEl.textContent = `${loc.name ? loc.name + " · " : ""}Map ${loc.mapId} (${loc.x}, ${loc.y})`;

              const actionsEl = document.createElement("div");
              actionsEl.style.display = "flex";
              actionsEl.style.gap = "6px";
              actionsEl.appendChild(makeButton("Go", () => execAction("Teleport", () => actions.recallLocation(idx)), { primary: true }));
              actionsEl.appendChild(
                makeButton(
                  "Del",
                  () => {
                    const ok = window.confirm("Delete this saved location?");
                    if (!ok) return;
                    execAction("Delete location", () => actions.deleteLocation(idx), { successToast: false });
                    render();
                  },
                  { danger: true }
                )
              );

              row.appendChild(idEl);
              row.appendChild(nameEl);
              row.appendChild(actionsEl);
              locList.appendChild(row);
            });
          }
          saved.appendChild(locList);
          bodyEl.appendChild(saved);
        };

        const renderDataPage = () => {
          clear(bodyEl);

          const top = makeSection("Variables / Switches");
          const row = document.createElement("div");
          row.className = "btnRow";
          row.appendChild(makeButton("Variables", () => { ui.dataTab = "variables"; render(); }, { primary: ui.dataTab === "variables" }));
          row.appendChild(makeButton("Switches", () => { ui.dataTab = "switches"; render(); }, { primary: ui.dataTab === "switches" }));
          top.appendChild(row);

          const search = document.createElement("input");
          search.className = "input";
          search.type = "text";
          search.placeholder = "Search…";
          search.value = ui.dataSearch;
          search.addEventListener("input", () => {
            ui.dataSearch = search.value;
            render();
          });
          top.appendChild(search);

          const hide = document.createElement("label");
          hide.className = "check";
          const hideInp = document.createElement("input");
          hideInp.type = "checkbox";
          hideInp.checked = Boolean(ui.dataHideNameless);
          hideInp.addEventListener("change", () => {
            ui.dataHideNameless = hideInp.checked;
            render();
          });
          hide.appendChild(hideInp);
          hide.appendChild(Object.assign(document.createElement("span"), { textContent: "Hide nameless" }));
          top.appendChild(hide);

          bodyEl.appendChild(top);

          const listSec = makeSection(ui.dataTab === "variables" ? "Variables" : "Switches");
          const out = document.createElement("div");
          out.className = "list";

          const query = String(ui.dataSearch || "").trim().toLowerCase();

          if (ui.dataTab === "variables") {
            const names = window.$dataSystem?.variables || null;
            if (!names || !window.$gameVariables?.value || !window.$gameVariables?.setValue) {
              out.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Variables not available yet." }));
            } else {
              let shown = 0;
              for (let i = 1; i < names.length; i++) {
                const name = String(names[i] || "");
                if (ui.dataHideNameless && !name.trim()) continue;
                if (query && !name.toLowerCase().includes(query) && !String(i).includes(query)) continue;

                const row = document.createElement("div");
                row.className = "listRow";

                const idEl = document.createElement("div");
                idEl.className = "mono";
                idEl.textContent = `#${i}`;

                const nameEl = document.createElement("div");
                nameEl.className = "name";
                nameEl.textContent = name || "(unnamed)";

                const inp = document.createElement("input");
                inp.className = "input";
                inp.type = "text";
                inp.style.width = "120px";
                try {
                  inp.value = String(window.$gameVariables.value(i) ?? "");
                } catch {
                  inp.value = "";
                }
                inp.addEventListener("change", () => {
                  execAction("Set variable", () => actions.setVariable(i, parseVariableValue(inp.value)), { successToast: false });
                  try {
                    inp.value = String(window.$gameVariables.value(i) ?? "");
                  } catch {}
                });

                row.appendChild(idEl);
                row.appendChild(nameEl);
                row.appendChild(inp);
                out.appendChild(row);

                shown++;
                if (shown >= 30) break;
              }
              if (shown === 0) out.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No matches." }));
            }
          } else {
            const names = window.$dataSystem?.switches || null;
            if (!names || !window.$gameSwitches?.value || !window.$gameSwitches?.setValue) {
              out.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Switches not available yet." }));
            } else {
              let shown = 0;
              for (let i = 1; i < names.length; i++) {
                const name = String(names[i] || "");
                if (ui.dataHideNameless && !name.trim()) continue;
                if (query && !name.toLowerCase().includes(query) && !String(i).includes(query)) continue;

                const row = document.createElement("div");
                row.className = "listRow";

                const idEl = document.createElement("div");
                idEl.className = "mono";
                idEl.textContent = `#${i}`;

                const nameEl = document.createElement("div");
                nameEl.className = "name";
                nameEl.textContent = name || "(unnamed)";

                const chk = document.createElement("input");
                chk.type = "checkbox";
                chk.checked = Boolean(window.$gameSwitches.value(i));
                chk.addEventListener("change", () => {
                  execAction("Set switch", () => actions.setSwitch(i, chk.checked), { successToast: false });
                  chk.checked = Boolean(window.$gameSwitches.value(i));
                });

                row.appendChild(idEl);
                row.appendChild(nameEl);
                row.appendChild(chk);
                out.appendChild(row);

                shown++;
                if (shown >= 30) break;
              }
              if (shown === 0) out.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No matches." }));
            }
          }

          listSec.appendChild(out);
          bodyEl.appendChild(listSec);
        };

        const renderActorsPage = () => {
          clear(bodyEl);

          const sec = makeSection("Actor");
          const party = window.$gameParty?.members?.() || [];

          const select = document.createElement("select");
          select.className = "select";
          const noneOpt = document.createElement("option");
          noneOpt.value = "";
          noneOpt.textContent = "Select party member…";
          select.appendChild(noneOpt);
          for (const a of party) {
            const id = a?._actorId;
            if (!id) continue;
            const opt = document.createElement("option");
            opt.value = String(id);
            opt.textContent = `${a._name || a.name?.() || "Actor"} (#${id})`;
            select.appendChild(opt);
          }
          if (ui.actorId != null) select.value = String(ui.actorId);
          select.addEventListener("change", () => {
            ui.actorId = select.value ? Math.max(1, Math.floor(Number(select.value) || 1)) : null;
            render();
          });

          sec.appendChild(select);

          const actorId = ui.actorId ?? (party[0]?._actorId || 1);
          const actor = window.$gameActors?.actor?.(actorId) || party.find(p => p?._actorId === actorId) || null;
          if (!actor) {
            sec.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Actor not available yet." }));
            bodyEl.appendChild(sec);
            return;
          }

          ui.actorId = actor._actorId || actorId;
          sec.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: `Selected: ${actor._name || actor.name?.() || "Actor"} (#${ui.actorId})` }));
          bodyEl.appendChild(sec);

          const edit = makeSection("Edit");

          const nameGrid = document.createElement("div");
          nameGrid.className = "grid2";
          const nameInp = document.createElement("input");
          nameInp.className = "input";
          nameInp.type = "text";
          nameInp.value = String(actor._name || actor.name?.() || "");
          nameGrid.appendChild(nameInp);
          nameGrid.appendChild(makeButton("Rename", () => execAction("Rename", () => actions.renameActor(ui.actorId, nameInp.value))));
          edit.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Name" }));
          edit.appendChild(nameGrid);

          const classGrid = document.createElement("div");
          classGrid.className = "grid2";
          const classInp = document.createElement("input");
          classInp.className = "input";
          classInp.type = "number";
          classInp.min = "1";
          classInp.step = "1";
          classInp.value = String(actor._classId || 1);
          classGrid.appendChild(classInp);
          classGrid.appendChild(makeButton("Change class", () => execAction("Change class", () => actions.changeClass(ui.actorId, classInp.value, ui.actorKeepExp))));
          edit.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Class ID" }));
          edit.appendChild(classGrid);

          const keepLabel = document.createElement("label");
          keepLabel.className = "check";
          const keepInp = document.createElement("input");
          keepInp.type = "checkbox";
          keepInp.checked = Boolean(ui.actorKeepExp);
          keepInp.addEventListener("change", () => (ui.actorKeepExp = keepInp.checked));
          keepLabel.appendChild(keepInp);
          keepLabel.appendChild(Object.assign(document.createElement("span"), { textContent: "Keep EXP" }));
          edit.appendChild(keepLabel);

          const lvGrid = document.createElement("div");
          lvGrid.className = "grid2";
          const lvInp = document.createElement("input");
          lvInp.className = "input";
          lvInp.type = "number";
          lvInp.min = "1";
          lvInp.step = "1";
          lvInp.value = String(actor.level ?? actor._level ?? 1);
          lvGrid.appendChild(lvInp);
          lvGrid.appendChild(makeButton("Set level", () => execAction("Set level", () => actions.setActorLevel(ui.actorId, lvInp.value))));
          edit.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Level" }));
          edit.appendChild(lvGrid);

          const expGrid = document.createElement("div");
          expGrid.className = "grid2";
          const expInp = document.createElement("input");
          expInp.className = "input";
          expInp.type = "number";
          expInp.min = "0";
          expInp.step = "1";
          expInp.value = String(actor.currentExp?.() ?? 0);
          expGrid.appendChild(expInp);
          expGrid.appendChild(makeButton("Set EXP", () => execAction("Set EXP", () => actions.setActorExp(ui.actorId, expInp.value))));
          edit.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "EXP" }));
          edit.appendChild(expGrid);

          const giveGrid = document.createElement("div");
          giveGrid.className = "grid2";
          const giveInp = document.createElement("input");
          giveInp.className = "input";
          giveInp.type = "number";
          giveInp.step = "1";
          giveInp.value = String(ui.actorGiveExp || 0);
          giveInp.addEventListener("change", () => (ui.actorGiveExp = Number(giveInp.value) || 0));
          giveGrid.appendChild(giveInp);
          giveGrid.appendChild(makeButton("Give EXP", () => execAction("Give EXP", () => actions.addActorExp(ui.actorId, giveInp.value))));
          edit.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Give EXP" }));
          edit.appendChild(giveGrid);

          const skillGrid = document.createElement("div");
          skillGrid.className = "grid2";
          const skillInp = document.createElement("input");
          skillInp.className = "input";
          skillInp.type = "number";
          skillInp.min = "1";
          skillInp.step = "1";
          skillInp.value = "1";
          skillGrid.appendChild(skillInp);
          skillGrid.appendChild(makeButton("Add skill", () => execAction("Add skill", () => actions.addSkill(ui.actorId, skillInp.value))));
          edit.appendChild(Object.assign(document.createElement("div"), { className: "label", textContent: "Skill ID" }));
          edit.appendChild(skillGrid);

          const stateBtns = document.createElement("div");
          stateBtns.className = "btnRow";
          stateBtns.appendChild(makeButton("Clear actor states", () => execAction("Clear actor states", () => actions.clearActorStates(ui.actorId))));
          stateBtns.appendChild(makeButton("Clear party states", () => execAction("Clear party states", () => actions.clearPartyStates())));
          edit.appendChild(stateBtns);
          bodyEl.appendChild(edit);

          const params = makeSection("Parameters");
          const paramNames = window.$dataSystem?.terms?.params || [];
          const g = document.createElement("div");
          g.className = "grid2";
          for (let pid = 0; pid < 8; pid++) {
            const label = document.createElement("div");
            label.className = "label";
            label.textContent = String(paramNames[pid] || `Param ${pid}`);
            const inp = document.createElement("input");
            inp.className = "input";
            inp.type = "number";
            inp.step = "1";
            try {
              inp.value = String(actor.param?.(pid) ?? 0);
            } catch {
              inp.value = "0";
            }
            inp.addEventListener("change", () => {
              execAction("Set param", () => actions.setActorParam(ui.actorId, pid, inp.value), { successToast: false });
              try {
                inp.value = String(actor.param?.(pid) ?? 0);
              } catch {}
            });
            const wrap = document.createElement("div");
            wrap.className = "stack";
            wrap.appendChild(label);
            wrap.appendChild(inp);
            g.appendChild(wrap);
          }
          params.appendChild(g);
          params.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Edits adjust permanent param bonuses and may interact with equipment/states." }));
          bodyEl.appendChild(params);
        };

        const render = () => {
          renderTabs();
          if (ui.globalSearch) renderSearchPage();
          else if (ui.page === "common") renderCommonPage();
          else if (ui.page === "cheats") renderCheatsPage();
          else if (ui.page === "actions") renderActionsPage();
          else if (ui.page === "inventory") renderInventoryPage();
          else if (ui.page === "teleport") renderTeleportPage();
          else if (ui.page === "data") renderDataPage();
          else if (ui.page === "actors") renderActorsPage();
          else renderCommonPage();
          syncCheatControls();
        };

        handle.addEventListener("click", e => {
          stop(e);
          logRuntime("toolsUiV2 handle click");
          setOpen(true);
        });

        closeBtn.addEventListener("click", e => {
          stop(e);
          logRuntime("toolsUiV2 close click");
          setOpen(false);
        });

        refreshBtn.addEventListener("click", e => {
          stop(e);
          render();
          showToast("Refreshed");
        });

        searchEl.addEventListener("input", e => {
          stop(e);
          ui.globalSearch = searchEl.value;
          render();
        });

        root.addEventListener("mousedown", stop);
        root.addEventListener("mouseup", stop);
        root.addEventListener("click", stop);
        root.addEventListener("wheel", stop, { passive: false });
        root.addEventListener("keydown", stop);
        root.addEventListener("keyup", stop);
        root.addEventListener("keypress", stop);

        window.addEventListener("maclauncher:cheatsUpdated", syncCheatControls);

        render();
        setOpen(Boolean(pendingOpen));
        pendingOpen = false;
        logRuntime("toolsUiV2 run: init complete");
      } catch (e) {
        logRuntime(
          "toolsUiV2 run: failed: " +
            String(e && (e.stack || e.message) ? e.stack || e.message : e)
        );
        console.error("[MacLauncher] Failed to init tools UI:", e);
      }
    };

    const ensureUi = () => {
      try {
        if (!document?.body) return;
        const existing = document.getElementById("maclauncher-tools");
        if (existing && existing.getAttribute("data-mcg-init") === "1") return;
        run();
      } catch (e) {
        logRuntime(
          "toolsUiV2 ensureUi: failed: " +
            String(e && (e.stack || e.message) ? e.stack || e.message : e)
        );
      }
    };

    const setTimeoutSafe = (fn, ms) => {
      try {
        if (typeof window === "object" && window && typeof window.setTimeout === "function") {
          return window.setTimeout(fn, ms);
        }
      } catch {}
      return setTimeout(fn, ms);
    };
    const setIntervalSafe = (fn, ms) => {
      try {
        if (typeof window === "object" && window && typeof window.setInterval === "function") {
          return window.setInterval(fn, ms);
        }
      } catch {}
      return setInterval(fn, ms);
    };

    const ensureTick = () => {
      try {
        window.__maclauncher_toolsUiV2LastEnsure = Date.now();
      } catch {}
      ensureUi();
    };

    try {
      window.__maclauncher_toolsUiV2Ensure = ensureTick;
    } catch {}

    const ensureFromWindow = () => {
      try {
        window.__maclauncher_toolsUiV2Ensure?.();
      } catch {}
    };

    try {
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", ensureFromWindow, { once: true });
      } else {
        ensureFromWindow();
      }
    } catch {
      try {
        ensureFromWindow();
      } catch {}
    }

    try {
      const lastEnsure = Number(window.__maclauncher_toolsUiV2LastEnsure || 0);
      const stale = !(lastEnsure > 0) || Date.now() - lastEnsure > 2500;
      if (!window.__maclauncher_toolsUiV2KeepAlive || stale) {
        window.__maclauncher_toolsUiV2KeepAlive = setIntervalSafe(ensureFromWindow, 750);
        logRuntime("toolsUiV2 keepAlive started");
      }
    } catch {}

    try {
      if (!window.__maclauncher_toolsUiV2RafKeepAlive && typeof window.requestAnimationFrame === "function") {
        window.__maclauncher_toolsUiV2RafKeepAlive = true;
        let lastRaf = 0;
        const rafLoop = () => {
          try {
            const now = Date.now();
            if (now - lastRaf > 500) {
              lastRaf = now;
              ensureFromWindow();
            }
            window.requestAnimationFrame(rafLoop);
          } catch {}
        };
        window.requestAnimationFrame(rafLoop);
        logRuntime("toolsUiV2 rafKeepAlive started");
      }
    } catch {}

    try {
      setTimeoutSafe(ensureTick, 0);
      setTimeoutSafe(ensureTick, 250);
      setTimeoutSafe(ensureTick, 1000);
      setTimeoutSafe(ensureTick, 2500);
    } catch {}

    try {
      setTimeoutSafe(
        () =>
          logRuntime(
            "toolsUiV2 postcheck t+1.2s present=" +
              String(Boolean(document.getElementById("maclauncher-tools")))
          ),
        1200
      );
      setTimeoutSafe(
        () =>
          logRuntime(
            "toolsUiV2 postcheck t+3.5s present=" +
              String(Boolean(document.getElementById("maclauncher-tools")))
          ),
        3500
      );
    } catch {}
  }

  const stateFilePath = (() => {
    if (!cheatsFilePath) return null;
    const base = cheatsFilePath.endsWith(".json")
      ? cheatsFilePath.slice(0, -".json".length)
      : cheatsFilePath;
    return `${base}.state.json`;
  })();

  const normalizeRuntimeState = raw => {
    const src = raw && typeof raw === "object" ? raw : {};
    const locationsRaw = Array.isArray(src.locations) ? src.locations : [];
    const locations = [];
    for (const loc of locationsRaw) {
      if (!loc || typeof loc !== "object") continue;
      const mapId = Number(loc.mapId);
      const x = Number(loc.x);
      const y = Number(loc.y);
      if (!Number.isFinite(mapId) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      locations.push({
        name: typeof loc.name === "string" ? loc.name.slice(0, 80) : "",
        mapId: Math.max(1, Math.floor(mapId)),
        x: Math.max(0, Math.floor(x)),
        y: Math.max(0, Math.floor(y))
      });
    }
    return { locations: locations.slice(0, 50) };
  };

  let runtimeState = normalizeRuntimeState(null);
  let stateWriteTimer = null;
  const readStateFile = () => {
    if (!stateFilePath) return null;
    try {
      if (!fs.existsSync(stateFilePath)) return null;
      return JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    } catch {
      return null;
    }
  };

  const writeStateFileNow = nextState => {
    if (!stateFilePath) return false;
    const normalized = normalizeRuntimeState(nextState);
    try {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    } catch {}
    try {
      fs.writeFileSync(stateFilePath, JSON.stringify(normalized, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  const scheduleStateFileWrite = () => {
    if (!stateFilePath) return;
    if (stateWriteTimer) clearTimeout(stateWriteTimer);
    stateWriteTimer = setTimeout(() => {
      stateWriteTimer = null;
      try {
        writeStateFileNow(runtimeState);
      } catch {}
    }, 200);
  };

  try {
    runtimeState = normalizeRuntimeState(readStateFile());
    writeStateFileNow(runtimeState);
  } catch {}

  const requireCheatsEnabled = () => {
    if (!getCheatsState()?.enabled) throw new Error("Cheats are disabled");
  };

  const actions = {
    gotoTitle: () => {
      requireCheatsEnabled();
      if (!window.SceneManager?.goto || !window.Scene_Title) throw new Error("Scene_Title not available");
      window.SceneManager.goto(window.Scene_Title);
    },

    toggleSaveScene: () => {
      requireCheatsEnabled();
      const sm = window.SceneManager;
      if (!sm?.push || !sm?.pop || !sm?._scene) throw new Error("SceneManager not available");
      if (!window.Scene_Save) throw new Error("Scene_Save not available");
      if (!window.Scene_Load) throw new Error("Scene_Load not available");
      const scene = sm._scene;
      if (scene?.constructor === window.Scene_Save) sm.pop();
      else if (scene?.constructor === window.Scene_Load) sm.goto(window.Scene_Save);
      else sm.push(window.Scene_Save);
    },

    toggleLoadScene: () => {
      requireCheatsEnabled();
      const sm = window.SceneManager;
      if (!sm?.push || !sm?.pop || !sm?._scene) throw new Error("SceneManager not available");
      if (!window.Scene_Save) throw new Error("Scene_Save not available");
      if (!window.Scene_Load) throw new Error("Scene_Load not available");
      const scene = sm._scene;
      if (scene?.constructor === window.Scene_Load) sm.pop();
      else if (scene?.constructor === window.Scene_Save) sm.goto(window.Scene_Load);
      else sm.push(window.Scene_Load);
    },

    quickSave: (slot = 1) => {
      requireCheatsEnabled();
      const saveSlot = Math.max(1, Math.floor(Number(slot) || 1));
      if (!window.DataManager?.saveGame) throw new Error("DataManager.saveGame not available");
      try {
        window.$gameSystem?.onBeforeSave?.();
      } catch {}
      const res = window.DataManager.saveGame(saveSlot);
      return res;
    },

    quickLoad: (slot = 1) => {
      requireCheatsEnabled();
      const loadSlot = Math.max(1, Math.floor(Number(slot) || 1));
      if (!window.DataManager?.loadGame) throw new Error("DataManager.loadGame not available");
      if (!window.SceneManager?.goto || !window.Scene_Map) throw new Error("SceneManager/Scene_Map not available");
      const res = window.DataManager.loadGame(loadSlot);
      try {
        if (res && typeof res.then === "function") {
          return res.then(() => window.SceneManager.goto(window.Scene_Map));
        }
        window.SceneManager.goto(window.Scene_Map);
      } catch {}
      return res;
    },

    setGold: amount => {
      requireCheatsEnabled();
      if (!window.$gameParty?.gainGold || !window.$gameParty?.loseGold) throw new Error("$gameParty not available");
      const desired = Math.max(0, Math.floor(Number(amount) || 0));
      const current = Number(window.$gameParty.gold?.() ?? window.$gameParty._gold ?? 0) || 0;
      const diff = desired - current;
      if (diff > 0) window.$gameParty.gainGold(diff);
      else if (diff < 0) window.$gameParty.loseGold(-diff);
      return desired;
    },

    addGold: delta => {
      requireCheatsEnabled();
      if (!window.$gameParty?.gainGold) throw new Error("$gameParty not available");
      const d = Math.floor(Number(delta) || 0);
      if (!d) return Number(window.$gameParty.gold?.() ?? window.$gameParty._gold ?? 0) || 0;
      window.$gameParty.gainGold(d);
      return Number(window.$gameParty.gold?.() ?? window.$gameParty._gold ?? 0) || 0;
    },

    setItemAmount: (kind, id, amount) => {
      requireCheatsEnabled();
      if (!window.$gameParty?.gainItem || !window.$gameParty?.numItems) throw new Error("$gameParty not available");
      const itemId = Math.max(1, Math.floor(Number(id) || 0));
      const desired = Math.max(0, Math.floor(Number(amount) || 0));
      const db =
        kind === "weapon"
          ? window.$dataWeapons
          : kind === "armor"
            ? window.$dataArmors
            : window.$dataItems;
      const item = db ? db[itemId] : null;
      if (!item) throw new Error(`Unknown ${kind || "item"} id: ${itemId}`);
      const current = window.$gameParty.numItems(item);
      const diff = desired - current;
      if (diff) window.$gameParty.gainItem(item, diff);
      return desired;
    },

    addItem: (kind, id, delta) => {
      requireCheatsEnabled();
      if (!window.$gameParty?.gainItem || !window.$gameParty?.numItems) throw new Error("$gameParty not available");
      const itemId = Math.max(1, Math.floor(Number(id) || 0));
      const d = Math.floor(Number(delta) || 0);
      const db =
        kind === "weapon"
          ? window.$dataWeapons
          : kind === "armor"
            ? window.$dataArmors
            : window.$dataItems;
      const item = db ? db[itemId] : null;
      if (!item) throw new Error(`Unknown ${kind || "item"} id: ${itemId}`);
      if (d) window.$gameParty.gainItem(item, d);
      return window.$gameParty.numItems(item);
    },

    teleport: (mapId, x, y) => {
      requireCheatsEnabled();
      if (!window.$gamePlayer?.reserveTransfer || !window.$gamePlayer?.setPosition) {
        throw new Error("$gamePlayer not available");
      }
      const m = Math.max(1, Math.floor(Number(mapId) || 0));
      const xx = Math.max(0, Math.floor(Number(x) || 0));
      const yy = Math.max(0, Math.floor(Number(y) || 0));
      const dir = typeof window.$gamePlayer.direction === "function" ? window.$gamePlayer.direction() : 2;
      window.$gamePlayer.reserveTransfer(m, xx, yy, dir, 0);
      window.$gamePlayer.setPosition(xx, yy);
      return { mapId: m, x: xx, y: yy };
    },

    listLocations: () => runtimeState.locations.slice(),

    saveLocation: name => {
      requireCheatsEnabled();
      if (!window.$gameMap?.mapId || !window.$gamePlayer) throw new Error("Map/player not available");
      const alias = typeof name === "string" ? name.trim().slice(0, 80) : "";
      runtimeState.locations.push({
        name: alias,
        mapId: Math.max(1, Math.floor(Number(window.$gameMap.mapId()) || 1)),
        x: Math.max(0, Math.floor(Number(window.$gamePlayer.x) || 0)),
        y: Math.max(0, Math.floor(Number(window.$gamePlayer.y) || 0))
      });
      runtimeState = normalizeRuntimeState(runtimeState);
      scheduleStateFileWrite();
      return runtimeState.locations.slice();
    },

    deleteLocation: index => {
      requireCheatsEnabled();
      const idx = Math.floor(Number(index) || 0);
      if (!(idx >= 0 && idx < runtimeState.locations.length)) return runtimeState.locations.slice();
      runtimeState.locations.splice(idx, 1);
      scheduleStateFileWrite();
      return runtimeState.locations.slice();
    },

    recallLocation: index => {
      requireCheatsEnabled();
      const idx = Math.floor(Number(index) || 0);
      const loc = runtimeState.locations[idx];
      if (!loc) throw new Error("Unknown saved location");
      return actions.teleport(loc.mapId, loc.x, loc.y);
    },

    setVariable: (id, value) => {
      requireCheatsEnabled();
      if (!window.$gameVariables?.setValue) throw new Error("$gameVariables not available");
      const varId = Math.max(1, Math.floor(Number(id) || 0));
      window.$gameVariables.setValue(varId, value);
      return window.$gameVariables.value(varId);
    },

    addVariable: (id, delta) => {
      requireCheatsEnabled();
      if (!window.$gameVariables?.setValue) throw new Error("$gameVariables not available");
      const varId = Math.max(1, Math.floor(Number(id) || 0));
      const cur = Number(window.$gameVariables.value(varId) || 0);
      const next = cur + (Number(delta) || 0);
      window.$gameVariables.setValue(varId, next);
      return window.$gameVariables.value(varId);
    },

    setSwitch: (id, value) => {
      requireCheatsEnabled();
      if (!window.$gameSwitches?.setValue) throw new Error("$gameSwitches not available");
      const switchId = Math.max(1, Math.floor(Number(id) || 0));
      window.$gameSwitches.setValue(switchId, Boolean(value));
      return window.$gameSwitches.value(switchId);
    },

    toggleSwitch: id => {
      requireCheatsEnabled();
      if (!window.$gameSwitches?.setValue) throw new Error("$gameSwitches not available");
      const switchId = Math.max(1, Math.floor(Number(id) || 0));
      window.$gameSwitches.setValue(switchId, !window.$gameSwitches.value(switchId));
      return window.$gameSwitches.value(switchId);
    },

    recoverAllParty: () => {
      requireCheatsEnabled();
      const members = window.$gameParty?.members?.() || window.$gameParty?.allMembers?.() || [];
      for (const member of members) {
        try {
          member?.setHp?.(member?.mhp);
          member?.setMp?.(member?.mmp);
          member?.setTp?.(member?.maxTp?.());
        } catch {}
      }
      return true;
    },

    fillTpAllParty: () => {
      requireCheatsEnabled();
      const members = window.$gameParty?.members?.() || window.$gameParty?.allMembers?.() || [];
      for (const member of members) {
        try {
          member?.setTp?.(member?.maxTp?.());
        } catch {}
      }
      return true;
    },

    setAllPartyHp: (hp, aliveOnly = true) => {
      requireCheatsEnabled();
      const members = window.$gameParty?.allMembers?.() || window.$gameParty?.members?.() || [];
      const desired = Math.floor(Number(hp) || 0);
      for (const member of members) {
        try {
          if (aliveOnly && Number(member?._hp) === 0) continue;
          member?.setHp?.(desired);
        } catch {}
      }
      return true;
    },

    setAllPartyMp: (mp, aliveOnly = true) => {
      requireCheatsEnabled();
      const members = window.$gameParty?.allMembers?.() || window.$gameParty?.members?.() || [];
      const desired = Math.floor(Number(mp) || 0);
      for (const member of members) {
        try {
          if (aliveOnly && Number(member?._hp) === 0) continue;
          member?.setMp?.(desired);
        } catch {}
      }
      return true;
    },

    setAllPartyTp: (tp, aliveOnly = true) => {
      requireCheatsEnabled();
      const members = window.$gameParty?.allMembers?.() || window.$gameParty?.members?.() || [];
      const desired = Math.floor(Number(tp) || 0);
      for (const member of members) {
        try {
          if (aliveOnly && Number(member?._hp) === 0) continue;
          member?.setTp?.(desired);
        } catch {}
      }
      return true;
    },

    recoverAllEnemy: () => {
      requireCheatsEnabled();
      const members = window.$gameTroop?.members?.() || [];
      for (const member of members) {
        try {
          member?.setHp?.(member?.mhp);
          member?.setMp?.(member?.mmp);
          member?.setTp?.(member?.maxTp?.());
        } catch {}
      }
      return true;
    },

    fillTpAllEnemy: () => {
      requireCheatsEnabled();
      const members = window.$gameTroop?.members?.() || [];
      for (const member of members) {
        try {
          member?.setTp?.(member?.maxTp?.());
        } catch {}
      }
      return true;
    },

    setAllEnemyHp: (hp, aliveOnly = true) => {
      requireCheatsEnabled();
      const members = window.$gameTroop?.members?.() || [];
      const desired = Math.floor(Number(hp) || 0);
      for (const member of members) {
        try {
          if (!member) continue;
          if (aliveOnly && Number(member?._hp) === 0) continue;
          member?.setHp?.(desired);
        } catch {}
      }
      return true;
    },

    forceEncounter: () => {
      requireCheatsEnabled();
      if (!window.$gamePlayer) throw new Error("$gamePlayer not available");
      window.$gamePlayer._encounterCount = 0;
      return true;
    },

    forceVictory: () => {
      requireCheatsEnabled();
      if (!window.SceneManager?._scene) throw new Error("SceneManager not available");
      if (!window.BattleManager?.processVictory) throw new Error("BattleManager not available");
      if (window.Scene_Battle && window.SceneManager._scene.constructor !== window.Scene_Battle) {
        throw new Error("Not in battle");
      }
      if (window.BattleManager._phase === "battleEnd") return false;
      try {
        window.$gameTroop?.members?.().forEach(enemy => {
          try {
            enemy?.addNewState?.(enemy?.deathStateId?.());
          } catch {}
        });
      } catch {}
      window.BattleManager.processVictory();
      return true;
    },

    forceDefeat: () => {
      requireCheatsEnabled();
      if (!window.SceneManager?._scene) throw new Error("SceneManager not available");
      if (!window.BattleManager?.processDefeat) throw new Error("BattleManager not available");
      if (window.Scene_Battle && window.SceneManager._scene.constructor !== window.Scene_Battle) {
        throw new Error("Not in battle");
      }
      if (window.BattleManager._phase === "battleEnd") return false;
      try {
        (window.$gameParty?.members?.() || []).forEach(actor => {
          try {
            actor?.addNewState?.(actor?.deathStateId?.());
          } catch {}
        });
      } catch {}
      window.BattleManager.processDefeat();
      return true;
    },

    forceEscape: () => {
      requireCheatsEnabled();
      if (!window.SceneManager?._scene) throw new Error("SceneManager not available");
      if (!window.BattleManager?.processEscape) throw new Error("BattleManager not available");
      if (window.Scene_Battle && window.SceneManager._scene.constructor !== window.Scene_Battle) {
        throw new Error("Not in battle");
      }
      if (window.BattleManager._phase === "battleEnd") return false;
      try {
        window.$gameParty?.performEscape?.();
        window.SoundManager?.playEscape?.();
      } catch {}
      try {
        window.BattleManager._escaped = true;
      } catch {}
      window.BattleManager.processEscape();
      return true;
    },

    forceAbort: () => {
      requireCheatsEnabled();
      if (!window.SceneManager?._scene) throw new Error("SceneManager not available");
      if (!window.BattleManager?.processAbort) throw new Error("BattleManager not available");
      if (window.Scene_Battle && window.SceneManager._scene.constructor !== window.Scene_Battle) {
        throw new Error("Not in battle");
      }
      if (window.BattleManager._phase === "battleEnd") return false;
      try {
        window.$gameParty?.performEscape?.();
        window.SoundManager?.playEscape?.();
      } catch {}
      try {
        window.BattleManager._escaped = true;
      } catch {}
      window.BattleManager.processAbort();
      return true;
    },

    startBattle: (troopId, canEscape = true, canLose = false) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(troopId) || 0));
      if (!window.BattleManager?.setup) throw new Error("BattleManager.setup not available");
      if (!window.SceneManager?.push || !window.Scene_Battle) throw new Error("Scene_Battle not available");
      window.BattleManager.setup(id, Boolean(canEscape), Boolean(canLose));
      window.SceneManager.push(window.Scene_Battle);
      return true;
    },

    setActorLevel: (actorId, level) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const lv = Math.max(1, Math.floor(Number(level) || 1));
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      if (typeof actor.changeLevel === "function") actor.changeLevel(lv, false);
      else actor._level = lv;
      return actor.level ?? actor._level;
    },

    setActorExp: (actorId, exp) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const amount = Math.max(0, Math.floor(Number(exp) || 0));
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      if (typeof actor.changeExp === "function") actor.changeExp(amount, false);
      else if (typeof actor.gainExp === "function") actor.gainExp(amount);
      return actor.currentExp?.() ?? actor._exp;
    },

    addActorExp: (actorId, delta) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const d = Math.floor(Number(delta) || 0);
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);

      const cur = Number(actor.currentExp?.() ?? 0);
      const next = Math.max(0, Math.floor(cur + d));
      if (typeof actor.changeExp === "function") actor.changeExp(next, false);
      else if (typeof actor.gainExp === "function") actor.gainExp(d);
      return actor.currentExp?.() ?? actor._exp;
    },

    setActorParam: (actorId, paramId, value) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const pid = Math.max(0, Math.floor(Number(paramId) || 0));
      const desired = Math.floor(Number(value) || 0);
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      if (typeof actor.param !== "function" || typeof actor.addParam !== "function") {
        throw new Error("Actor param editing not available");
      }
      const diff = desired - Number(actor.param(pid) || 0);
      if (diff) actor.addParam(pid, diff);
      return actor.param(pid);
    },

    clearActorStates: actorId => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      actor.clearStates?.();
      return true;
    },

    clearPartyStates: () => {
      requireCheatsEnabled();
      const members = window.$gameParty?.allMembers?.() || window.$gameParty?.members?.() || [];
      for (const member of members) {
        try {
          member?.clearStates?.();
        } catch {}
      }
      return true;
    },

    addSkill: (actorId, skillId) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const sid = Math.max(1, Math.floor(Number(skillId) || 0));
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      actor.learnSkill?.(sid);
      return true;
    },

    renameActor: (actorId, name) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      const n = typeof name === "string" ? name.trim().slice(0, 48) : "";
      if (typeof actor.setName === "function") actor.setName(n);
      else actor._name = n;
      return true;
    },

    changeClass: (actorId, classId, keepExp = false) => {
      requireCheatsEnabled();
      const id = Math.max(1, Math.floor(Number(actorId) || 0));
      const cid = Math.max(1, Math.floor(Number(classId) || 0));
      const actor = window.$gameActors?.actor?.(id);
      if (!actor) throw new Error(`Actor not found: ${id}`);
      if (typeof actor.changeClass !== "function") throw new Error("Actor.changeClass not available");
      actor.changeClass(cid, Boolean(keepExp));
      return true;
    }
  };

  if (enablePatcher) {
    try {
      logRuntime("startCheatPatcher begin");
      startCheatPatcher();
      logRuntime("startCheatPatcher ok");
    } catch (e) {
      logRuntime(
        "startCheatPatcher failed: " +
          String(e && (e.stack || e.message) ? e.stack || e.message : e)
      );
      // eslint-disable-next-line no-console
      console.error("[MacLauncher] Cheat patcher failed:", e);
    }
  } else {
    logRuntime("cheatPatcher disabled");
  }

  if (enableToolsUi) {
    try {
      logRuntime("startInGameToolsUiV2 begin");
      startInGameToolsUiV2();
      logRuntime("startInGameToolsUiV2 ok");
    } catch (e) {
      logRuntime(
        "startInGameToolsUiV2 failed: " +
          String(e && (e.stack || e.message) ? e.stack || e.message : e)
      );
      // eslint-disable-next-line no-console
      console.error("[MacLauncher] Tools UI failed:", e);
    }
  } else {
    logRuntime("toolsUi disabled");
  }

  if (enableToolsUi) {
    try {
      installNwjsToolsMenu();
    } catch (e) {
      logRuntime(
        "toolsMenu failed: " +
          String(e && (e.stack || e.message) ? e.stack || e.message : e)
      );
    }
  }

	  const api = {
	    cheatsFilePath,
	    stateFilePath,
	    getCheatsState,
	    mergeCheatsState,
	    getRuntimeState: () => runtimeState,
	    setRuntimeState: next => {
	      runtimeState = normalizeRuntimeState(next);
	      scheduleStateFileWrite();
	      return runtimeState;
	    },
	    ensurePatcher: () => {
	      try {
	        startCheatPatcher();
	        return true;
	      } catch (e) {
	        logRuntime(
	          "ensurePatcher failed: " +
	            String(e && (e.stack || e.message) ? e.stack || e.message : e)
	        );
	        return false;
	      }
	    },
	    ensureToolsUi: () => {
	      try {
	        startInGameToolsUiV2();
	        return true;
	      } catch (e) {
	        logRuntime(
	          "ensureToolsUi failed: " +
	            String(e && (e.stack || e.message) ? e.stack || e.message : e)
	        );
	        return false;
	      }
	    },
	    scheduleCheatsFileWrite,
	    writeCheatsFileNow,
	    actions
	  };

  try {
    window.__maclauncher_cheatsRuntimeInstalled = api;
  } catch {}

  return api;
}

module.exports = { installCheatsRuntime };
