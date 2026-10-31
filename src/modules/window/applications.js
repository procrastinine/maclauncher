const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const Requirements = require("../shared/runtime/feature-requirements");

const HELPER = "maclauncher-graphics-window";

// Window graphics need the macOS release whose content picker reports the
// picked window, and a graphics package that reports the window source.
// Everything here is local: no network request and no capture.
function availability({ root, platform = process.platform, macOSVersion, readRecord, publication } = {}) {
  const support = Requirements.requirementSupport(Requirements.WINDOW_GRAPHICS, { platform,
    macOSVersion: macOSVersion || (platform === "darwin" ? require("../shared/runtime/bundled-native").systemVersionSync() : null) });
  if (support.supported === false) return { available: false, reason: support.reason };
  try {
    root ||= require("../shared/reshade").runtimeRoot();
    const record = (readRecord || require("../shared/reshade/runtime-record").read)(root);
    if (record?.features?.graphics?.windowSourceAPI !== 1)
      return { available: false, reason: "The installed graphics runtime does not include window graphics." };
    const row = (publication || require("../shared/reshade/publication")).forRoot(root)?.files?.find(file => file.path === HELPER);
    const executable = path.join(root, HELPER);
    if (!row || !fs.statSync(executable).isFile()) return { available: false, reason: "The window graphics helper is missing." };
    return { available: true, root, row, executable, library: path.join(root, "libreshade-macos.dylib") };
  } catch {
    return { available: false, reason: "The graphics runtime is unavailable." };
  }
}

function run(executable, args, { execute = execFile, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_)/.test(key)) delete env[key];
    execute(executable, args, { env, timeout, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(String(stdout).trim().split("\n").pop())); } catch (cause) { reject(cause); }
    });
  });
}

const validName = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
const validPath = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");

// Running regular apps, most recently active first, without the launcher.
async function listApplications({ executable, excludePid = process.pid, execute } = {}) {
  const result = await run(executable, ["--list-applications", "--exclude-pid", String(excludePid)], { execute });
  if (result?.schema !== 1 || !Array.isArray(result.applications)) return [];
  return result.applications.filter(app => Number.isSafeInteger(app?.pid) && app.pid > 0 && validName(app.name)).slice(0, 64).map(app => ({
    pid: app.pid, name: app.name,
    ...(validName(app.bundleIdentifier) ? { bundleIdentifier: app.bundleIdentifier } : {}),
    ...(validPath(app.path) ? { path: app.path } : {}),
    ...(validPath(app.executable) ? { executable: app.executable } : {})
  }));
}

// Which of these bundle identifiers still name an installed app.
async function installedApplications(identifiers, { executable, execute } = {}) {
  const ids = [...new Set(identifiers)].filter(validName).slice(0, 64);
  if (!ids.length) return {};
  const result = await run(executable, ["--installed", ...ids], { execute });
  return result?.schema === 1 && result.installed && typeof result.installed === "object" ? result.installed : {};
}

module.exports = { HELPER, availability, listApplications, installedApplications };
