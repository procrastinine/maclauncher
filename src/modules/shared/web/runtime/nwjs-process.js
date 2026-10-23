const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { launchHostedProcess } = require("../../../../core/hosted-process");
const { spawnDetachedChecked } = require("../../../../core/processes");

const REPORTER_SOURCE = require.resolve("../../../../core/hosted-startup-reporter");
const STARTUP_FILE = "__maclauncher/nwjs-startup-inject.js";
const BROWSER_INJECTION_LOADER = `const safeInject = request => {
    try {
      const path = require("path");
      const fs = require("fs");
      const filename = path.resolve(nw.App.startPath, request);
      (0, eval)(fs.readFileSync(filename, "utf8"));
      return true;
    } catch (error) {
      console.error("[MacLauncher] Browser injection failed:", request, String(error && error.message || error));
      return false;
    }
  };`;

// The reporter lives in launcher-owned storage. Game assets remain linked to
// their originals, and the existing injection order is retained after setup.
function installStartupReporter(wrapperDir, { readinessFrame } = {}) {
  const manifestPath = path.join(wrapperDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let requiredFrame = null;
  if (readinessFrame) {
    const framePath = readinessFrame.path;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(readinessFrame.id || "") || typeof framePath !== "string" ||
        !framePath || /[\\\0]/.test(framePath) || path.isAbsolute(framePath) || framePath.split("/").includes("..") ||
        !fs.statSync(path.resolve(wrapperDir, framePath)).isFile()) throw new Error("Invalid startup document frame.");
    requiredFrame = { id: readinessFrame.id, relativePath: path.posix.relative(path.posix.dirname(manifest.main), framePath).split("/").map(encodeURIComponent).join("/") };
  }
  const previous = manifest.inject_js_start === STARTUP_FILE ? (manifest.maclauncher?.startupInject || []) :
    (Array.isArray(manifest.inject_js_start) ? manifest.inject_js_start : [manifest.inject_js_start])
      .filter(value => typeof value === "string" && value);
  const ownedRoot = path.join(wrapperDir, "__maclauncher");
  try { if (fs.lstatSync(ownedRoot).isSymbolicLink()) fs.unlinkSync(ownedRoot); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(ownedRoot, { recursive: true });
  for (const filename of ["hosted-startup-reporter.js", "nwjs-startup-inject.js"]) {
    const destination = path.join(ownedRoot, filename);
    try { if (fs.lstatSync(destination).isSymbolicLink()) fs.unlinkSync(destination); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fs.copyFileSync(REPORTER_SOURCE, path.join(ownedRoot, "hosted-startup-reporter.js"));
  fs.writeFileSync(path.join(ownedRoot, "nwjs-startup-inject.js"), `// maclauncher:nwjs-startup
(() => {
  const path = require("path");
  const { createHostedStartupReporter, guardHostedOutput } = require(path.join(nw.App.startPath, "__maclauncher", "hosted-startup-reporter.js"));
  const reporter = createHostedStartupReporter();
  if (reporter.enabled) guardHostedOutput();
  try {
    if (window.top !== window) return;
    const nativeWindow = nw.Window.get();
    if (!nativeWindow || typeof nativeWindow.on !== "function") {
      throw new Error("NW.js did not create a native game window.");
    }
    const requiredFrame = ${JSON.stringify(requiredFrame)};
    let nativeLoaded = false, contentUrl = null;
    const ready = () => {
      if (!nativeLoaded || requiredFrame && !contentUrl) return;
      reporter.ready({ host: "nwjs", nativeWindowLoaded: true, url: String(window.location.href),
        appRoot: String(nw.App.startPath), appId: typeof chrome !== "undefined" ? chrome.runtime && chrome.runtime.id : null,
        ...(requiredFrame ? {contentLoaded: true, contentUrl} : {}) });
    };
    const readFrame = frame => {
      if (!requiredFrame || !frame || frame !== document.getElementById(requiredFrame.id)) return;
      const expected = new URL(requiredFrame.relativePath, window.location.href).href;
      try {
        if (frame.contentWindow.location.href !== expected || frame.contentWindow.document.readyState !== "complete") return;
        contentUrl = expected; ready();
      } catch (error) { reporter.error(error); }
    };
    if (requiredFrame) nativeWindow.on("document-start", frame => {
      if (!frame || frame.id !== requiredFrame.id || frame !== document.getElementById(requiredFrame.id)) return;
      const failed = event => reporter.error(new Error(String(event && (event.message || event.reason && event.reason.message || event.reason) || "The game document could not be loaded.")));
      frame.addEventListener("load", () => readFrame(frame), {once: true});
      frame.addEventListener("error", failed, {once: true});
      try {
        frame.contentWindow.addEventListener("error", failed, {once: true});
        frame.contentWindow.addEventListener("unhandledrejection", failed, {once: true});
      } catch (error) { reporter.error(error); }
    });
    const nativeReady = () => {
      nativeLoaded = true;
      if (requiredFrame) readFrame(document.getElementById(requiredFrame.id));
      ready();
    };
    nativeWindow.on("loaded", nativeReady);
    window.addEventListener("load", nativeReady, { once: true });
    if (document.readyState === "complete") nativeReady();
    const fs = require("fs");
    for (const filename of ${JSON.stringify(previous)}) {
      // NW inject_js_start runs in the DOM context. CommonJS require would move
      // prior injections into the Node context and lose their browser globals.
      (0, eval)(fs.readFileSync(path.resolve(nw.App.startPath, filename), "utf8"));
    }
  } catch (error) {
    reporter.error(error);
  }
})();
`, "utf8");
  manifest.inject_js_start = STARTUP_FILE;
  manifest.maclauncher = { ...manifest.maclauncher, startupInject: previous };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return pathToFileURL(path.resolve(wrapperDir, manifest.main)).href;
}

async function launchNwjsProcess({ executable, args, wrapperDir, needsRosetta = false,
  logger, timeoutMs, spawn = spawnDetachedChecked, onDiagnostics, env = process.env, context, readinessFrame } = {}) {
  const expectedUrl = installStartupReporter(wrapperDir, { readinessFrame });
  const roots = new Set([path.resolve(wrapperDir), fs.realpathSync(wrapperDir)]);
  const relativeMain = path.relative(path.resolve(wrapperDir), fileURLToPath(expectedUrl));
  const expectedAppPath = "/" + relativeMain.split(path.sep).map(encodeURIComponent).join("/");
  const expectedContentUrl = readinessFrame ? pathToFileURL(path.resolve(wrapperDir, readinessFrame.path)).href : null;
  const expectedContentPath = readinessFrame ? "/" + readinessFrame.path.split("/").map(encodeURIComponent).join("/") : null;
  const matchesDocument = (value, fileUrl, appPath, report) => {
    if (value === fileUrl) return true;
    if (typeof report.appRoot !== "string" || !roots.has(path.resolve(report.appRoot)) ||
        typeof report.appId !== "string" || !/^[a-p]{32}$/.test(report.appId)) return false;
    try {
      const url = new URL(value);
      return url.protocol === "chrome-extension:" && url.hostname === report.appId &&
        url.pathname === appPath && !url.search && !url.hash;
    } catch { return false; }
  };
  env = await require("./browser-graphics").prepareBrowserGraphicsEnvironment(context, env, {needsRosetta});
  return launchHostedProcess({ executable, args, logger, timeoutMs, onDiagnostics, env,
    spawn: (command, parameters, options) => spawn(command, parameters,
      { ...options, cwd: wrapperDir }, needsRosetta),
    validateReady: report => {
      if (report.host !== "nwjs" || report.nativeWindowLoaded !== true || typeof report.url !== "string") return false;
      return matchesDocument(report.url, expectedUrl, expectedAppPath, report) &&
        (!readinessFrame || report.contentLoaded === true && typeof report.contentUrl === "string" &&
          matchesDocument(report.contentUrl, expectedContentUrl, expectedContentPath, report));
    } });
}

module.exports = { STARTUP_FILE, BROWSER_INJECTION_LOADER, installStartupReporter, launchNwjsProcess };
