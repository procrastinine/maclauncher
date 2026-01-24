const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./manifest.json");
const GameData = require("../shared/game-data");
const { detectGame } = require("./detect");
const {
  extractPackagedExe,
  resolveExtractionRoot,
  resolveExtractionStatus
} = require("./extract");
const OnsyuriManager = require("../shared/onsyuri/runtime/onsyuri-manager");
const OnsyuriRuntime = require("../shared/onsyuri/runtime/onsyuri-runtime");
const NwjsPatchedLauncher = require("../shared/web/runtime/nwjs-patched-launcher");

const ONSYURI_SCRIPT_NAMES = new Set([
  "0.txt",
  "00.txt",
  "nscript.dat",
  "nscript.___",
  "nscr_sec.dat",
  "onscript.nt2",
  "onscript.nt3"
]);
const UTF_SCRIPT_NAME = "0.utf";
const FONT_ALIAS_NAME = "default.ttf";
const FALLBACK_FONT_NAME = "umeplus-gothic.ttf";
const JSZIP_FILE_NAME = "jszip.min.js";
const DYLIB_HINTS = {
  "liblua.dylib": "lua",
  "libSDL2-2.0.0.dylib": "sdl2",
  "libSDL2_ttf-2.0.0.dylib": "sdl2_ttf",
  "libSDL2_image-2.0.0.dylib": "sdl2_image",
  "libSDL2_mixer-2.0.0.dylib": "sdl2_mixer"
};
const SYSTEM_DYLIB_PREFIXES = ["/usr/lib/", "/System/Library/"];
const ONSYURI_HTML_PATCH_MARKER = "<!-- maclauncher:onsyuri-env -->";
const ONSYURI_DEVTOOLS_PATCH_MARKER = "<!-- maclauncher:onsyuri-devtools -->";
const ONSYURI_HTML_PATCH = `${ONSYURI_HTML_PATCH_MARKER}\n    <script>\n      try {\n        if (window.process && typeof window.process === \"object\") {\n          if (window.process.type !== \"renderer\") {\n            try {\n              Object.defineProperty(window.process, \"type\", {\n                value: \"renderer\",\n                writable: true,\n                configurable: true\n              });\n            } catch {\n              window.process.type = \"renderer\";\n            }\n          }\n        }\n      } catch {}\n    </script>`;
const ONSYURI_DEVTOOLS_PATCH = `${ONSYURI_DEVTOOLS_PATCH_MARKER}
    <script>
      (function() {
        try {
          if (window.__maclauncherDevToolsInstalled) return;
          window.__maclauncherDevToolsInstalled = true;
        } catch {}

        var getWindow = function() {
          try {
            if (typeof nw !== "undefined" && nw.Window && typeof nw.Window.get === "function") {
              return nw.Window.get();
            }
          } catch {}
          return null;
        };

        var toggleDevTools = function() {
          try {
            var win = getWindow();
            if (!win) return;
            if (typeof win.isDevToolsOpen === "function" && win.isDevToolsOpen()) {
              if (typeof win.closeDevTools === "function") {
                win.closeDevTools();
                return;
              }
            }
            if (typeof win.showDevTools === "function") {
              win.showDevTools();
            }
          } catch {}
        };

        try {
          window.__maclauncherOpenDevTools = toggleDevTools;
          window.__maclauncherToggleDevTools = toggleDevTools;
        } catch {}

        var ensureMenuItem = function() {
          try {
            var win = getWindow();
            if (!win || !win.menu || !Array.isArray(win.menu.items)) return false;
            var viewMenu = null;
            for (var i = 0; i < win.menu.items.length; i++) {
              var item = win.menu.items[i];
              var label = String((item && item.label) || "").toLowerCase();
              if (label === "view") {
                viewMenu = item;
                break;
              }
            }
            if (!viewMenu || !viewMenu.submenu || !Array.isArray(viewMenu.submenu.items)) return false;
            var hasItem = false;
            for (var j = 0; j < viewMenu.submenu.items.length; j++) {
              var entry = viewMenu.submenu.items[j];
              var entryLabel = String((entry && entry.label) || "").toLowerCase();
              if (entryLabel.indexOf("developer tools") !== -1) {
                hasItem = true;
                break;
              }
            }
            if (hasItem) return true;
            if (typeof nw !== "undefined" && typeof nw.MenuItem === "function") {
              viewMenu.submenu.append(
                new nw.MenuItem({
                  label: "Toggle Developer Tools",
                  click: function() { toggleDevTools(); }
                })
              );
              return true;
            }
          } catch {}
          return false;
        };

        var scheduleMenuCheck = function() {
          var tries = 0;
          var tick = function() {
            if (ensureMenuItem()) return;
            tries += 1;
            if (tries < 6) setTimeout(tick, 500);
          };
          tick();
        };

        var isMac = false;
        try {
          isMac = /mac/i.test(String(navigator.platform || ""));
        } catch {}
        scheduleMenuCheck();

        window.addEventListener(
          "keydown",
          function(event) {
            var key = String(event.key || "").toLowerCase();
            var code = String(event.code || "").toLowerCase();
            var isKeyI = key === "i" || code === "keyi";
            var wantsDevTools =
              key === "f12" ||
              code === "f12" ||
              (isMac && event.metaKey && (event.altKey || event.shiftKey) && isKeyI) ||
              (!isMac && event.ctrlKey && event.shiftKey && isKeyI);
            if (!wantsDevTools) return;
            try {
              event.preventDefault();
              if (typeof event.stopImmediatePropagation === "function") {
                event.stopImmediatePropagation();
              }
              event.stopPropagation();
            } catch {}
            toggleDevTools();
          },
          true
        );
      })();
    </script>`;

const ONSYURI_JS_ENV_REGEX = /var ENVIRONMENT_IS_NODE=[^;]+;/;
const ONSYURI_JSZIP_SCRIPT_RE =
  /<script[^>]+src=["']https:\/\/unpkg.com\/jszip[^"']+["'][^>]*>\s*<\/script>/i;
const ONSYURI_JSZIP_STUB = `<script>\n      (function() {\n        if (window.JSZip) return;\n        function missing() {\n          throw new Error(\"JSZip is not bundled in this runtime. Add a local JSZip file or enable network.\");\n        }\n        function JSZip() {\n          missing();\n        }\n        JSZip.loadAsync = function() {\n          return Promise.reject(new Error(\"JSZip is not bundled in this runtime.\"));\n        };\n        window.JSZip = JSZip;\n      })();\n    </script>`;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function resolveGameRoot(entry, context) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedPath = moduleData.packagedPath || null;
  const baseRoot =
    typeof entry?.contentRootDir === "string" && entry.contentRootDir
      ? entry.contentRootDir
      : entry?.gamePath;

  if (!packagedPath) return { gameRootDir: baseRoot, extractedRoot: null };
  if (!context?.userDataDir) return { gameRootDir: baseRoot, extractedRoot: null };

  const status = resolveExtractionStatus({
    entry,
    userDataDir: context.userDataDir,
    moduleId: manifest.id
  });
  if (status?.extractedReady && status.contentRootDir) {
    return { gameRootDir: status.contentRootDir, extractedRoot: status.extractedRoot || null };
  }

  let extracted = null;
  try {
    extracted = await extractPackagedExe({
      entry,
      userDataDir: context.userDataDir,
      moduleId: manifest.id,
      logger: context.logger
    });
  } catch (err) {
    context.logger?.warn?.("[nscripter] exe extraction failed", String(err?.message || err));
    extracted = null;
  }
  if (!extracted?.contentRootDir) {
    throw new Error(
      "NScripter exe extraction failed. Extract the game with 7-Zip and add the extracted folder."
    );
  }

  return { gameRootDir: extracted.contentRootDir, extractedRoot: extracted.extractedRoot || null };
}

function parseMissingDylibs(output, existsFn = fs.existsSync) {
  const missing = [];
  const brewHints = new Set();
  const lines = String(output || "").split("\n").slice(1);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const dep = trimmed.split(/\s+/)[0];
    if (!dep || dep.startsWith("@") || !path.isAbsolute(dep)) continue;
    if (SYSTEM_DYLIB_PREFIXES.some(prefix => dep.startsWith(prefix))) continue;
    if (existsFn(dep)) continue;
    missing.push(dep);
    const hint = DYLIB_HINTS[path.basename(dep)];
    if (hint) brewHints.add(hint);
  }
  if (missing.length === 0) return null;
  return { missing, brewHints: Array.from(brewHints) };
}

function listMissingDylibs(binaryPath) {
  if (process.platform !== "darwin") return null;
  const res = spawnSync("/usr/bin/otool", ["-L", binaryPath], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return parseMissingDylibs(res.stdout, fs.existsSync);
}

function findOnsyuriBinary(root) {
  const direct = path.join(root, "onsyuri");
  if (existsFile(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().startsWith("onsyuri")) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = path.join(full, "onsyuri");
      if (existsFile(nested)) return nested;
    }
  }
  return null;
}

function resolveOnsyuriMacInstall(userDataDir, settings, runtimeData) {
  const cfg = OnsyuriManager.normalizeSettings(settings?.runtimes?.onsyuri);
  const installed = OnsyuriRuntime.listInstalledMac(userDataDir);
  const requestedVersion =
    typeof runtimeData?.version === "string" && runtimeData.version.trim()
      ? runtimeData.version.trim()
      : cfg.mac.defaultVersion || null;
  const requestedVariant =
    typeof runtimeData?.variant === "string" && runtimeData.variant.trim()
      ? runtimeData.variant.trim()
      : cfg.mac.defaultVariant || null;

  let match = null;
  if (requestedVersion && requestedVariant) {
    match = installed.find(
      entry => entry.version === requestedVersion && entry.variant === requestedVariant
    );
  }
  if (!match && requestedVersion) {
    match = installed.find(entry => entry.version === requestedVersion);
  }
  if (!match && installed.length > 0) {
    match = installed[0];
  }

  if (!match) {
    const suffix = requestedVersion ? ` v${requestedVersion}` : "";
    throw new Error(`Onsyuri runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  return match;
}

function resolveOnsyuriWebInstall(userDataDir, settings, runtimeData) {
  const cfg = OnsyuriManager.normalizeSettings(settings?.runtimes?.onsyuri);
  const installed = OnsyuriRuntime.listInstalledWeb(userDataDir);
  const requestedVersion =
    typeof runtimeData?.version === "string" && runtimeData.version.trim()
      ? runtimeData.version.trim()
      : cfg.web.defaultVersion || null;

  let match = null;
  if (requestedVersion) {
    match = installed.find(entry => entry.version === requestedVersion);
  }
  if (!match && installed.length > 0) {
    match = installed[0];
  }

  if (!match) {
    const suffix = requestedVersion ? ` v${requestedVersion}` : "";
    throw new Error(`Onsyuri web runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  return match;
}

function findWebRuntimeEntry(rootDir) {
  const indexPath = path.join(rootDir, "index.html");
  if (existsFile(indexPath)) return indexPath;
  const onsyuriPath = path.join(rootDir, "onsyuri.html");
  if (existsFile(onsyuriPath)) return onsyuriPath;
  return null;
}

function findWebRuntimeRoot(installDir) {
  const directEntry = findWebRuntimeEntry(installDir);
  if (directEntry) return { rootDir: installDir, entryHtml: directEntry };
  let entries = [];
  try {
    entries = fs.readdirSync(installDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childDir = path.join(installDir, entry.name);
    const childEntry = findWebRuntimeEntry(childDir);
    if (childEntry) return { rootDir: childDir, entryHtml: childEntry };
  }
  return null;
}

function symlinkDirContents(srcDir, destDir, skipNames = new Set()) {
  let entries = [];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name) continue;
    if (skipNames.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.symlinkSync(src, dest);
    } catch {}
  }
}

function listFilesRecursive(rootDir, baseDir = rootDir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.name) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, baseDir, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(baseDir, full).split(path.sep).join("/");
    if (!rel) continue;
    out.push(rel);
  }
  return out;
}

function getScriptInfo(rootDir) {
  const utfScriptPath = path.join(rootDir, UTF_SCRIPT_NAME);
  const hasUtfScript = existsFile(utfScriptPath);
  const hasKnownScript = Array.from(ONSYURI_SCRIPT_NAMES).some(name =>
    existsFile(path.join(rootDir, name))
  );
  return {
    hasUtfScript,
    hasKnownScript,
    utfScriptPath,
    needsAlias: hasUtfScript && !hasKnownScript
  };
}

function resolveFallbackFont(userDataDir) {
  if (!userDataDir) return null;
  const sourcePath = path.join(__dirname, "resources", FALLBACK_FONT_NAME);
  if (!existsFile(sourcePath)) return null;
  const destDir = path.join(userDataDir, "modules", manifest.id, "assets");
  const destPath = path.join(destDir, FALLBACK_FONT_NAME);
  if (existsFile(destPath)) return destPath;
  try {
    ensureDir(destDir);
    fs.copyFileSync(sourcePath, destPath);
  } catch {}
  return existsFile(destPath) ? destPath : null;
}

function resolveFontPath({ rootDir, userDataDir, moduleSettings }) {
  const custom =
    typeof moduleSettings?.defaultFontPath === "string"
      ? moduleSettings.defaultFontPath.trim()
      : "";
  if (custom && existsFile(custom)) return custom;
  const defaultFont = path.join(rootDir, FONT_ALIAS_NAME);
  if (existsFile(defaultFont)) return defaultFont;
  return resolveFallbackFont(userDataDir);
}

function resolveJsZipSource() {
  const sourcePath = path.join(__dirname, "resources", JSZIP_FILE_NAME);
  return existsFile(sourcePath) ? sourcePath : null;
}

function ensureJsZip(wrapperDir) {
  if (!wrapperDir) return null;
  const sourcePath = resolveJsZipSource();
  if (!sourcePath) return null;
  const destPath = path.join(wrapperDir, JSZIP_FILE_NAME);
  if (existsFile(destPath)) return destPath;
  try {
    fs.copyFileSync(sourcePath, destPath);
  } catch {}
  return existsFile(destPath) ? destPath : null;
}

function ensureFontAlias(wrapperDir, fontPath) {
  if (!fontPath) return null;
  const aliasPath = path.join(wrapperDir, FONT_ALIAS_NAME);
  if (existsFile(aliasPath)) return aliasPath;
  try {
    fs.symlinkSync(fontPath, aliasPath);
  } catch {}
  return existsFile(aliasPath) ? aliasPath : null;
}

function ensureScriptAlias(wrapperDir, scriptInfo) {
  if (!scriptInfo?.needsAlias) return null;
  const aliasPath = path.join(wrapperDir, "0.txt");
  if (existsFile(aliasPath)) return aliasPath;
  try {
    fs.symlinkSync(scriptInfo.utfScriptPath, aliasPath);
  } catch {}
  return existsFile(aliasPath) ? aliasPath : null;
}

function buildMacWrapper({ userDataDir, gameId, gameRootDir, scriptInfo }) {
  if (!userDataDir || !gameId) {
    throw new Error("Missing gameId for Onscripter Yuri wrapper.");
  }
  const wrappersRoot = path.join(
    GameData.resolveGameRuntimeDir(userDataDir, gameId, "onsyuri_mac"),
    "wrappers"
  );
  ensureDir(wrappersRoot);

  const wrapperDir = path.join(wrappersRoot, "wrapper");
  safeRm(wrapperDir);
  ensureDir(wrapperDir);

  symlinkDirContents(gameRootDir, wrapperDir);
  ensureScriptAlias(wrapperDir, scriptInfo);

  return wrapperDir;
}

function buildWebWrapper({
  userDataDir,
  gameId,
  gameRootDir,
  runtimeRootDir,
  scriptInfo,
  fontPath
}) {
  if (!userDataDir || !gameId) {
    throw new Error("Missing gameId for Onscripter Yuri wrapper.");
  }
  const wrappersRoot = path.join(
    GameData.resolveGameRuntimeDir(userDataDir, gameId, "onsyuri_web"),
    "wrappers"
  );
  ensureDir(wrappersRoot);

  const wrapperDir = path.join(wrappersRoot, "wrapper");
  safeRm(wrapperDir);
  ensureDir(wrapperDir);

  symlinkDirContents(runtimeRootDir, wrapperDir);
  patchOnsyuriJs(wrapperDir, runtimeRootDir);
  ensureJsZip(wrapperDir);
  const skipGame = new Set(["index.html", "onsyuri.html"]);
  symlinkDirContents(gameRootDir, wrapperDir, skipGame);
  ensureScriptAlias(wrapperDir, scriptInfo);
  if (!existsFile(path.join(gameRootDir, FONT_ALIAS_NAME))) {
    ensureFontAlias(wrapperDir, fontPath);
  }

  return wrapperDir;
}

function buildOnsyuriIndex({
  wrapperDir,
  gameRootDir,
  gameId,
  name,
  scriptInfo,
  includeFontAlias
}) {
  const id = String(gameId || "");
  if (!id) {
    throw new Error("Missing gameId for Onscripter Yuri index.");
  }
  const title = name || path.basename(gameRootDir);
  const gamedir = `/onsyuri/${id}`;
  const savedir = `/onsyuri_save/${id}`;
  const files = listFilesRecursive(gameRootDir);
  const extras = new Set();
  if (scriptInfo?.needsAlias && existsFile(path.join(wrapperDir, "0.txt"))) {
    extras.add("0.txt");
  }
  if (includeFontAlias && existsFile(path.join(wrapperDir, FONT_ALIAS_NAME))) {
    extras.add(FONT_ALIAS_NAME);
  }
  const merged = Array.from(new Set([...files, ...extras]));
  const args = [];
  if (scriptInfo?.needsAlias) args.push("--enc:utf8");
  const payload = {
    title,
    gamedir,
    savedir,
    args,
    lazyload: true,
    files: merged.map(p => ({ path: p }))
  };
  fs.writeFileSync(path.join(wrapperDir, "onsyuri_index.json"), JSON.stringify(payload, null, 2));
}

function patchOnsyuriJs(wrapperDir, runtimeRootDir) {
  if (!wrapperDir || !runtimeRootDir) return null;
  const sourcePath = path.join(runtimeRootDir, "onsyuri.js");
  if (!existsFile(sourcePath)) return null;
  let raw = "";
  try {
    raw = fs.readFileSync(sourcePath, "utf8");
  } catch {
    return null;
  }
  if (!raw) return null;
  const patched = raw.replace(ONSYURI_JS_ENV_REGEX, "var ENVIRONMENT_IS_NODE=false;");
  if (patched === raw) return null;
  const target = path.join(wrapperDir, "onsyuri.js");
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  } catch {}
  fs.writeFileSync(target, patched, "utf8");
  return target;
}

function ensureOnsyuriHtml(wrapperDir, runtimeEntryHtml) {
  if (!runtimeEntryHtml || !existsFile(runtimeEntryHtml)) return null;
  let raw = "";
  try {
    raw = fs.readFileSync(runtimeEntryHtml, "utf8");
  } catch {
    return null;
  }
  if (!raw) return null;
  if (!raw.includes("onsyuri_index") && !raw.includes("onsyuri.js")) return null;
  if (!raw.includes("<head")) return null;
  if (!raw.includes(ONSYURI_HTML_PATCH_MARKER)) {
    raw = raw.replace(/<head[^>]*>/i, match => `${match}\n    ${ONSYURI_HTML_PATCH}`);
  }
  if (!raw.includes(ONSYURI_DEVTOOLS_PATCH_MARKER)) {
    raw = raw.replace(/<head[^>]*>/i, match => `${match}\n    ${ONSYURI_DEVTOOLS_PATCH}`);
  }
  const localJsZip = existsFile(path.join(wrapperDir, JSZIP_FILE_NAME));
  if (ONSYURI_JSZIP_SCRIPT_RE.test(raw)) {
    raw = raw.replace(
      ONSYURI_JSZIP_SCRIPT_RE,
      localJsZip
        ? `<script type="text/javascript" src="${JSZIP_FILE_NAME}"></script>`
        : ONSYURI_JSZIP_STUB
    );
  } else if (localJsZip && !raw.includes(JSZIP_FILE_NAME)) {
    raw = raw.replace(
      /<head[^>]*>/i,
      match => `${match}\n    <script type="text/javascript" src="${JSZIP_FILE_NAME}"></script>`
    );
  }
  const target = path.join(wrapperDir, "maclauncher-onsyuri.html");
  fs.writeFileSync(target, raw, "utf8");
  return target;
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = entry?.gameId;
  if (!userDataDir || !gameId) return false;
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  safeRm(GameData.resolveGameRuntimeDir(userDataDir, gameId, "onsyuri_web"));
  safeRm(GameData.resolveGameRuntimeDir(userDataDir, gameId, "onsyuri_mac"));
  const roots = new Set();
  if (typeof moduleData.extractedRoot === "string" && moduleData.extractedRoot.trim()) {
    roots.add(moduleData.extractedRoot.trim());
  }
  const computed = resolveExtractionRoot({ entry, userDataDir, moduleId: manifest.id });
  if (computed) roots.add(computed);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  return true;
}

async function launchRuntime(runtimeId, entry, context) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.onsyuri : null;
  const resolvedRoot = await resolveGameRoot(entry, context);
  const gameRootDir = resolvedRoot?.gameRootDir;
  if (!gameRootDir || !existsDir(gameRootDir)) {
    throw new Error("NScripter game root was not found.");
  }

  if (runtimeId === "onsyuri_mac") {
    const install = resolveOnsyuriMacInstall(context.userDataDir, context.settings, runtimeData);
    const binaryPath = findOnsyuriBinary(install.installDir);
    if (!binaryPath) throw new Error("Onsyuri binary not found in the install folder.");
    const dylibs = listMissingDylibs(binaryPath);
    if (dylibs?.missing?.length) {
      const hint = dylibs.brewHints.length
        ? ` Install with: brew install ${dylibs.brewHints.join(" ")}.`
        : "";
      throw new Error(
        `Onsyuri runtime is missing dynamic libraries: ${dylibs.missing.join(", ")}.${hint}`
      );
    }

    const scriptInfo = getScriptInfo(gameRootDir);
    const resolvedRootDir =
      scriptInfo.needsAlias && context.userDataDir
        ? buildMacWrapper({
            userDataDir: context.userDataDir,
            gameId: entry.gameId,
            gameRootDir,
            scriptInfo
          })
        : gameRootDir;
    const args = ["--root", resolvedRootDir];
    if (scriptInfo.needsAlias) args.push("--enc:utf8");
    const fontPath = resolveFontPath({
      rootDir: resolvedRootDir,
      userDataDir: context.userDataDir,
      moduleSettings: context.moduleSettings
    });
    if (fontPath) {
      args.push("--font", fontPath);
    }

    const needsRosetta = process.arch === "arm64" && install.variant === "x64";
    context.logger?.info?.(`[runtime] launch onsyuri ${binaryPath} ${args.join(" ")}`);
    return context.spawnDetachedChecked(binaryPath, args, { cwd: resolvedRootDir }, needsRosetta);
  }

  if (runtimeId === "onsyuri_web") {
    const install = resolveOnsyuriWebInstall(context.userDataDir, context.settings, runtimeData);
    const runtimeRoot = findWebRuntimeRoot(install.installDir);
    if (!runtimeRoot) {
      throw new Error(
        "Onsyuri web runtime is installed but no entry HTML was found (index.html or onsyuri.html). Extract the web build into the install folder."
      );
    }

    const scriptInfo = getScriptInfo(gameRootDir);
    const fontPath = resolveFontPath({
      rootDir: gameRootDir,
      userDataDir: context.userDataDir,
      moduleSettings: context.moduleSettings
    });
    const wrapperDir = buildWebWrapper({
      userDataDir: context.userDataDir,
      gameId: entry.gameId,
      gameRootDir,
      runtimeRootDir: runtimeRoot.rootDir,
      scriptInfo,
      fontPath
    });
    buildOnsyuriIndex({
      wrapperDir,
      gameRootDir,
      gameId: entry.gameId,
      name: entry.name,
      scriptInfo,
      includeFontAlias: !existsFile(path.join(gameRootDir, FONT_ALIAS_NAME))
    });
    const entryName = path.basename(runtimeRoot.entryHtml);
    const entryPath = path.join(wrapperDir, entryName);
    const indexHtml = ensureOnsyuriHtml(wrapperDir, runtimeRoot.entryHtml) || entryPath;
    if (!existsFile(indexHtml)) {
      throw new Error("Onsyuri web runtime is missing its entry HTML after staging.");
    }

    const webEntry = {
      ...entry,
      gameType: "web",
      contentRootDir: wrapperDir,
      indexHtml
    };

    return NwjsPatchedLauncher.launchRuntime({
      entry: webEntry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings: null,
      chromiumArgs: ["--allow-file-access-from-files", "--no-proxy-server"],
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: false,
      patchConfig: null,
      contentRootOverride: wrapperDir,
      indexHtmlOverride: indexHtml,
      logger: context.logger,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  }

  if (runtimeId === "external") {
    const externalPath =
      typeof context?.moduleSettings?.externalRuntimePath === "string"
        ? context.moduleSettings.externalRuntimePath.trim()
        : "";
    if (!externalPath) throw new Error("External runtime path is not configured.");

    const args = ["--root", gameRootDir];
    if (externalPath.toLowerCase().endsWith(".app")) {
      return context.spawnDetachedChecked("open", ["-a", externalPath, "--args", ...args]);
    }
    return context.spawnDetachedChecked(externalPath, args, { cwd: gameRootDir });
  }

  return null;
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  launchRuntime,
  cleanupGameData,
  __test: {
    parseMissingDylibs,
    buildOnsyuriIndex,
    ensureOnsyuriHtml,
    patchOnsyuriJs
  }
};
