const fs = require("node:fs");
const path = require("node:path");

const PATCH_MARKER = "maclauncher:cheats-patch";
const PATCH_START = `// ${PATCH_MARKER}:start`;
const PATCH_END = `// ${PATCH_MARKER}:end`;
const PATCH_LINE = `// ${PATCH_MARKER}`;

const BOOTSTRAP_MARKER = "maclauncher:tools-bootstrap";

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function existsDir(p) {
  const st = safeStat(p);
  return Boolean(st && st.isDirectory());
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function detectNewline(text) {
  return String(text || "").includes("\r\n") ? "\r\n" : "\n";
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function writeText(p, text) {
  fs.writeFileSync(p, text, "utf8");
}

function safeParseJson(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function layoutForGame(detected) {
  const indexDir = detected?.indexDir;
  if (typeof indexDir !== "string" || !indexDir) throw new Error("Missing indexDir");

  const mainJsPath = path.join(indexDir, "js", "main.js");
  const pluginsDir = path.join(indexDir, "js", "plugins");

  const bootstrapPath = path.join(pluginsDir, "MacLauncher_Tools.js");
  const maclauncherDir = path.join(pluginsDir, "maclauncher");
  const patchMetaPath = path.join(maclauncherDir, "patch.json");
  const runtimePath = path.join(maclauncherDir, "runtime.js");
  const cheatsPath = path.join(maclauncherDir, "cheats.js");
  const schemaPath = path.join(maclauncherDir, "schema.json");

  return {
    mainJsPath,
    pluginsDir,
    bootstrapPath,
    maclauncherDir,
    patchMetaPath,
    runtimePath,
    cheatsPath,
    schemaPath
  };
}

function buildBootstrapSource(options = {}) {
  const override =
    typeof options.toolsButtonVisible === "boolean" ? options.toolsButtonVisible : null;
  const overrideLiteral =
    override === null ? "null" : override ? "true" : "false";
  return `// ${BOOTSTRAP_MARKER}
(function () {
  var BOOTSTRAP_ID = "maclauncher-tools-bootstrap-badge";
  var TOOLS_BUTTON_OVERRIDE = ${overrideLiteral};
  try {
    var isElectron =
      typeof process === "object" &&
      process &&
      process.versions &&
      typeof process.versions.electron === "string" &&
      process.versions.electron;
    if (isElectron) return;

    var nwApp = typeof nw === "object" && nw && nw.App ? nw.App : null;
    var cheatsFilePath =
      nwApp &&
      nwApp.manifest &&
      nwApp.manifest.maclauncher &&
      typeof nwApp.manifest.maclauncher.cheatsFilePath === "string" &&
      nwApp.manifest.maclauncher.cheatsFilePath
        ? nwApp.manifest.maclauncher.cheatsFilePath
        : null;
    var toolsButtonVisible = true;
    try {
      if (TOOLS_BUTTON_OVERRIDE === true || TOOLS_BUTTON_OVERRIDE === false) {
        toolsButtonVisible = TOOLS_BUTTON_OVERRIDE;
      } else {
        toolsButtonVisible =
          nwApp &&
          nwApp.manifest &&
          nwApp.manifest.maclauncher &&
          nwApp.manifest.maclauncher.toolsButtonVisible === false
            ? false
            : true;
      }
    } catch (e) {
      toolsButtonVisible = TOOLS_BUTTON_OVERRIDE === null ? true : TOOLS_BUTTON_OVERRIDE;
    }

    var hasRequire = typeof require === "function";
    var fs = null;
    var path = null;
    if (hasRequire) {
      try {
        fs = require("fs");
        path = require("path");
      } catch (e) {
        fs = null;
        path = null;
      }
    }

    var logPath = null;
    try {
      if (fs && cheatsFilePath) logPath = String(cheatsFilePath) + ".tools-bootstrap.log";
      else if (fs && path && typeof process === "object" && process && typeof process.cwd === "function") {
        logPath = path.join(process.cwd(), "maclauncher-tools-bootstrap.log");
      }
    } catch (e) {
      logPath = null;
    }

    function logLine(msg) {
      try {
        if (!fs || !logPath) return;
        fs.appendFileSync(logPath, "[" + new Date().toISOString() + "] " + String(msg || "") + "\\n", "utf8");
      } catch (e) {}
    }

    function showBadge(text) {
      try {
        if (!document) return;
        if (document.getElementById(BOOTSTRAP_ID)) return;

        var mount = function () {
          try {
            if (!document.body) return;
            if (document.getElementById(BOOTSTRAP_ID)) return;
            var el = document.createElement("div");
            el.id = BOOTSTRAP_ID;
            el.textContent = String(text || "MacLauncher Tools failed to load");
            el.style.cssText = [
              "position:fixed",
              "top:10px",
              "right:10px",
              "z-index:2147483647",
              "pointer-events:none",
              "padding:8px 10px",
              "border-radius:10px",
              "border:1px solid rgba(255,93,93,.55)",
              "background:rgba(15,23,36,.92)",
              "color:#e6e9ef",
              "font:12px/1.25 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial",
              "box-shadow:0 12px 32px rgba(0,0,0,.35)"
            ].join(";");
            document.body.appendChild(el);
          } catch (e) {}
        };

        if (document.body) mount();
        else {
          try {
            window.addEventListener("DOMContentLoaded", mount, { once: true });
          } catch (e) {}
        }
      } catch (e) {}
    }

    function fileUrlToPath(url) {
      try {
        var s = String(url || "");
        if (s.indexOf("file://") !== 0) return null;
        s = s.replace(/^file:\\/\\//, "");
        try {
          s = decodeURIComponent(s);
        } catch (e) {}
        return s;
      } catch (e) {
        return null;
      }
    }

    logLine("bootstrap start");
    try { logLine("href=" + String(location && location.href ? location.href : "")); } catch (e) {}
    try { logLine("hasRequire=" + String(hasRequire)); } catch (e) {}
    try { logLine("startPath=" + String(nwApp && nwApp.startPath ? nwApp.startPath : "")); } catch (e) {}
    try { logLine("cwd=" + String(typeof process === "object" && process && typeof process.cwd === "function" ? process.cwd() : "")); } catch (e) {}
    try { logLine("cheatsFilePath=" + String(cheatsFilePath || "")); } catch (e) {}

    if (!hasRequire || !fs || !path) {
      showBadge("MacLauncher Tools: require() not available");
      logLine("fatal: require() not available");
      return;
    }

    var scriptSrc = null;
    try {
      scriptSrc = document && document.currentScript && document.currentScript.src ? document.currentScript.src : null;
    } catch (e) {
      scriptSrc = null;
    }
    logLine("currentScript=" + String(scriptSrc || ""));

    var scriptFile = fileUrlToPath(scriptSrc);
    logLine("scriptFile=" + String(scriptFile || ""));

    var pluginsDir = null;
    if (scriptFile) {
      try {
        pluginsDir = path.dirname(scriptFile);
      } catch (e) {
        pluginsDir = null;
      }
    }

    if (!pluginsDir) {
      var startPath =
        nwApp && typeof nwApp.startPath === "string" && nwApp.startPath ? nwApp.startPath : null;
      var roots = [];
      if (startPath) roots.push(startPath);
      try {
        if (typeof process === "object" && process && typeof process.cwd === "function") roots.push(process.cwd());
      } catch (e) {}

      for (var r = 0; r < roots.length && !pluginsDir; r++) {
        var root = roots[r];
        var pluginDirCandidates = [
          path.join(root, "js", "plugins"),
          path.join(root, "www", "js", "plugins")
        ];
        for (var i = 0; i < pluginDirCandidates.length; i++) {
          var candidate = pluginDirCandidates[i];
          try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
              pluginsDir = candidate;
              break;
            }
          } catch (e) {}
        }
      }
    }

    logLine("pluginsDir=" + String(pluginsDir || ""));
    if (!pluginsDir) {
      showBadge("MacLauncher Tools: could not locate js/plugins");
      logLine("fatal: pluginsDir not found");
      return;
    }

    var maclauncherDir = path.join(pluginsDir, "maclauncher");
    logLine("maclauncherDir=" + String(maclauncherDir));

    var Cheats = null;
    var CheatsRuntime = null;
    try {
      Cheats = require(path.join(maclauncherDir, "cheats.js"));
      CheatsRuntime = require(path.join(maclauncherDir, "runtime.js"));
    } catch (e) {
      logLine("fatal: require runtime failed: " + String(e && (e.stack || e.message) ? (e.stack || e.message) : e));
      showBadge("MacLauncher Tools: failed to load runtime");
      return;
    }

    if (!CheatsRuntime || typeof CheatsRuntime.installCheatsRuntime !== "function") {
      logLine("fatal: invalid runtime module");
      showBadge("MacLauncher Tools: invalid runtime module");
      return;
    }

    var enableFileSync = Boolean(cheatsFilePath);
    if (!enableFileSync) logLine("warn: cheatsFilePath missing; file sync disabled");

    try {
      CheatsRuntime.installCheatsRuntime({
        window: window,
        document: document,
        DEFAULT_CHEATS: Cheats.DEFAULT_CHEATS,
        normalizeCheats: Cheats.normalizeCheats,
        cheatsFilePath: cheatsFilePath || null,
        toolsButtonVisible: toolsButtonVisible,
        enableFileSync: enableFileSync,
        enablePatcher: true,
        enableToolsUi: true
      });
      logLine("installCheatsRuntime ok");
      try {
        var checkUi = function (label) {
          try {
            var win = typeof window === "object" && window ? window : null;
            var doc = typeof document === "object" && document ? document : null;
            var eqDoc = null;
            try {
              eqDoc = Boolean(win && win.document && doc && win.document === doc);
            } catch (e) {
              eqDoc = null;
            }

            var href = "";
            try {
              href = String(win && win.location && win.location.href ? win.location.href : "");
            } catch (e) {
              href = "";
            }
            var url = "";
            try {
              url = String(doc && doc.URL ? doc.URL : "");
            } catch (e) {
              url = "";
            }
            var ready = "";
            try {
              ready = String(doc && doc.readyState ? doc.readyState : "");
            } catch (e) {
              ready = "";
            }

            var el =
              doc && typeof doc.getElementById === "function" ? doc.getElementById("maclauncher-tools") : null;
            var elViaWinDoc = null;
            try {
              elViaWinDoc =
                win && win.document && typeof win.document.getElementById === "function"
                  ? win.document.getElementById("maclauncher-tools")
                  : null;
            } catch (e) {
              elViaWinDoc = null;
            }

            var inBody = false;
            try {
              inBody = Boolean(el && doc && doc.body && typeof doc.body.contains === "function" && doc.body.contains(el));
            } catch (e) {
              inBody = false;
            }

            var installed = false;
            var runtime = null;
            var runtimeEnsureToolsUi = false;
            var runtimeEnsurePatcher = false;
            var runtimeCheatsFilePath = "";
            try {
              runtime = win && win.__maclauncher_cheatsRuntimeInstalled ? win.__maclauncher_cheatsRuntimeInstalled : null;
              installed = Boolean(runtime);
              runtimeEnsureToolsUi = Boolean(runtime && typeof runtime.ensureToolsUi === "function");
              runtimeEnsurePatcher = Boolean(runtime && typeof runtime.ensurePatcher === "function");
              runtimeCheatsFilePath = runtime && typeof runtime.cheatsFilePath === "string" ? runtime.cheatsFilePath : "";
            } catch (e) {
              installed = false;
              runtime = null;
              runtimeEnsureToolsUi = false;
              runtimeEnsurePatcher = false;
              runtimeCheatsFilePath = "";
            }

            var ensured = false;
            var ensureFnExists = false;
            try {
              var ensureFn =
                win && typeof win.__maclauncher_toolsUiV2Ensure === "function" ? win.__maclauncher_toolsUiV2Ensure : null;
              ensureFnExists = Boolean(ensureFn);
              if (ensureFn) {
                ensureFn();
                ensured = true;
              }
            } catch (e) {
              ensured = false;
              ensureFnExists = false;
            }

            var elAfter = null;
            try {
              elAfter =
                doc && typeof doc.getElementById === "function" ? doc.getElementById("maclauncher-tools") : null;
            } catch (e) {
              elAfter = null;
            }
            var initAttr = "";
            try {
              initAttr = elAfter && typeof elAfter.getAttribute === "function" ? String(elAfter.getAttribute("data-mcg-init") || "") : "";
            } catch (e) {
              initAttr = "";
            }

            logLine(
              "postcheck:" +
                String(label || "") +
                " present=" +
                String(Boolean(elAfter)) +
                " init=" +
                String(initAttr || "") +
                " inBody=" +
                String(Boolean(inBody)) +
                " viaWinDoc=" +
                String(Boolean(elViaWinDoc)) +
                " docEqWinDoc=" +
                String(eqDoc) +
                " ensured=" +
                String(ensured) +
                " ensureFn=" +
                String(ensureFnExists) +
                " installed=" +
                String(installed) +
                " rtEnsureToolsUi=" +
                String(Boolean(runtimeEnsureToolsUi)) +
                " rtEnsurePatcher=" +
                String(Boolean(runtimeEnsurePatcher)) +
                " rtCheatsFilePath=" +
                String(runtimeCheatsFilePath || "") +
                " readyState=" +
                String(ready) +
                " href=" +
                String(href) +
                " url=" +
                String(url)
            );
          } catch (e) {
            logLine(
              "postcheck:" +
                String(label || "") +
                " failed: " +
                String(e && (e.stack || e.message) ? (e.stack || e.message) : e)
            );
          }
        };
        setTimeout(function () { checkUi("t+1.2s"); }, 1200);
        setTimeout(function () { checkUi("t+3.5s"); }, 3500);
      } catch (e) {}
      try {
        window.__maclauncher_toolsBootstrapInstalled = true;
      } catch (e) {}
    } catch (e) {
      logLine("fatal: installCheatsRuntime failed: " + String(e && (e.stack || e.message) ? (e.stack || e.message) : e));
      showBadge("MacLauncher Tools: install failed");
      return;
    }
  } catch (e) {
    try {
      console.error("[MacLauncher] Tools bootstrap failed:", e);
    } catch (_) {}
  }
})();
`;
}

function readBundledCheatsAsset(relPath) {
  const p = path.resolve(__dirname, "..", "..", "mvmz", "cheats", relPath);
  return readText(p);
}

function isMainJsPatched(text) {
  const t = String(text || "");
  return t.includes(PATCH_START) || t.includes(PATCH_LINE);
}

function patchMainJsMV(text) {
  const t = String(text || "");
  if (t.includes(PATCH_START)) return { changed: false, text: t };

  const newline = detectNewline(t);
  const block =
    `${PATCH_START}${newline}` +
    `try { if (!PluginManager._path) PluginManager._path = "js/plugins/"; } catch (e) {}` +
    `${newline}` +
    `try { PluginManager.loadScript("MacLauncher_Tools.js"); } catch (e) {}` +
    `${newline}` +
    `${PATCH_END}${newline}`;

  const re = /(PluginManager\.setup\(\$plugins\);\s*\r?\n)/;
  const m = t.match(re);
  if (!m) throw new Error("MV main.js missing PluginManager.setup($plugins);");

  const out = t.replace(re, `$1${block}`);
  return { changed: out !== t, text: out };
}

function unpatchMainJsMV(text) {
  const t = String(text || "");
  if (!t.includes(PATCH_START)) return { changed: false, text: t };
  const re = /^[ \t]*\/\/ maclauncher:cheats-patch:start[\s\S]*?^[ \t]*\/\/ maclauncher:cheats-patch:end\s*(\r?\n)?/m;
  const out = t.replace(re, "");
  return { changed: out !== t, text: out };
}

function patchMainJsMZ(text) {
  const t = String(text || "");
  if (t.includes(PATCH_LINE)) return { changed: false, text: t };

  const re = /(^[ \t]*["']js\/plugins\.js["']\s*,?\s*(\r?\n))/m;
  const m = t.match(re);
  if (!m) throw new Error("MZ main.js missing js/plugins.js entry in scriptUrls");

  const indent = m[0].match(/^[ \t]*/)?.[0] ?? "";
  const newline = m[0].includes("\r\n") ? "\r\n" : "\n";
  const insert = `${indent}"js/plugins/MacLauncher_Tools.js", ${PATCH_LINE}${newline}`;
  const out = t.replace(re, `${insert}$1`);
  return { changed: out !== t, text: out };
}

function unpatchMainJsMZ(text) {
  const t = String(text || "");
  if (!t.includes(PATCH_LINE)) return { changed: false, text: t };
  const re = /^[ \t]*["']js\/plugins\/MacLauncher_Tools\.js["']\s*,?\s*\/\/ maclauncher:cheats-patch\s*(\r?\n)?/m;
  const out = t.replace(re, "");
  return { changed: out !== t, text: out };
}

function getPatchStatus(detected) {
  const layout = layoutForGame(detected);

  const engine = detected?.engine === "mv" || detected?.engine === "mz" ? detected.engine : "unknown";
  const mainJsExists = existsFile(layout.mainJsPath);
  const pluginsDirExists = existsDir(layout.pluginsDir);
  const bootstrapExists = existsFile(layout.bootstrapPath);
  const maclauncherDirExists = existsDir(layout.maclauncherDir);
  const maclauncherRuntimeExists = existsFile(layout.runtimePath);
  const maclauncherCheatsExists = existsFile(layout.cheatsPath);
  const maclauncherSchemaExists = existsFile(layout.schemaPath);

  let mainPatched = false;
  if (mainJsExists) {
    try {
      mainPatched = isMainJsPatched(readText(layout.mainJsPath));
    } catch {
      mainPatched = false;
    }
  }

  const filesOk =
    pluginsDirExists &&
    bootstrapExists &&
    maclauncherDirExists &&
    maclauncherRuntimeExists &&
    maclauncherCheatsExists &&
    maclauncherSchemaExists;

  const patched = Boolean(mainPatched && filesOk);
  const partial = Boolean((mainPatched && !filesOk) || (!mainPatched && filesOk));

  return {
    engine,
    mainJsPath: layout.mainJsPath,
    pluginsDir: layout.pluginsDir,
    patched,
    partial,
    details: {
      mainJsExists,
      mainPatched,
      pluginsDirExists,
      bootstrapExists,
      maclauncherDirExists,
      maclauncherRuntimeExists,
      maclauncherCheatsExists,
      maclauncherSchemaExists
    }
  };
}

function patchGame(detected, { appVersion = null, toolsButtonVisible = null } = {}) {
  const engine = detected?.engine;
  if (engine !== "mv" && engine !== "mz") throw new Error(`Unsupported engine: ${String(engine || "unknown")}`);

  const layout = layoutForGame(detected);
  if (!existsFile(layout.mainJsPath)) throw new Error(`main.js not found: ${layout.mainJsPath}`);

  const mainRaw = readText(layout.mainJsPath);
  const patchedMain =
    engine === "mv" ? patchMainJsMV(mainRaw) : patchMainJsMZ(mainRaw);
  if (patchedMain.changed) writeText(layout.mainJsPath, patchedMain.text);

  ensureDir(layout.pluginsDir);
  ensureDir(layout.maclauncherDir);

  writeText(layout.bootstrapPath, buildBootstrapSource({ toolsButtonVisible }));
  writeText(layout.runtimePath, readBundledCheatsAsset("runtime.js"));
  writeText(layout.cheatsPath, readBundledCheatsAsset("cheats.js"));
  writeText(layout.schemaPath, readBundledCheatsAsset("schema.json"));
  writeText(
    layout.patchMetaPath,
    JSON.stringify(
      {
        patchedBy: "maclauncher",
        patchedAt: Date.now(),
        appVersion: typeof appVersion === "string" && appVersion ? appVersion : null
      },
      null,
      2
    )
  );

  return getPatchStatus(detected);
}

function unpatchGame(detected) {
  const engine = detected?.engine;
  if (engine !== "mv" && engine !== "mz") throw new Error(`Unsupported engine: ${String(engine || "unknown")}`);

  const layout = layoutForGame(detected);
  if (existsFile(layout.mainJsPath)) {
    const mainRaw = readText(layout.mainJsPath);
    const unpatchedMain =
      engine === "mv" ? unpatchMainJsMV(mainRaw) : unpatchMainJsMZ(mainRaw);
    if (unpatchedMain.changed) writeText(layout.mainJsPath, unpatchedMain.text);
  }

  if (existsFile(layout.bootstrapPath)) {
    try {
      const bootstrapRaw = readText(layout.bootstrapPath);
      if (bootstrapRaw.includes(BOOTSTRAP_MARKER)) fs.rmSync(layout.bootstrapPath, { force: true });
    } catch {}
  }

  let canRemoveMaclauncherDir = false;
  if (existsFile(layout.patchMetaPath)) {
    try {
      const meta = safeParseJson(readText(layout.patchMetaPath));
      canRemoveMaclauncherDir = meta?.patchedBy === "maclauncher";
    } catch {}
  }

  if (canRemoveMaclauncherDir && existsDir(layout.maclauncherDir)) {
    try {
      fs.rmSync(layout.maclauncherDir, { recursive: true, force: true });
    } catch {}
  } else {
    for (const p of [layout.runtimePath, layout.cheatsPath, layout.schemaPath, layout.patchMetaPath]) {
      try {
        if (existsFile(p)) fs.rmSync(p, { force: true });
      } catch {}
    }
    try {
      if (existsDir(layout.maclauncherDir) && fs.readdirSync(layout.maclauncherDir).length === 0) {
        fs.rmdirSync(layout.maclauncherDir);
      }
    } catch {}
  }

  return getPatchStatus(detected);
}

module.exports = {
  getPatchStatus,
  patchGame,
  unpatchGame
};
