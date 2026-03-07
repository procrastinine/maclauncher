const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function plistPath(appPath) {
  return path.join(String(appPath || ""), "Contents", "Info.plist");
}

function readInfoPlist(appPath) {
  const infoPath = plistPath(appPath);
  if (!existsFile(infoPath)) return null;

  try {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], {
      encoding: "utf8"
    });
    if (result.status === 0 && result.stdout) {
      const parsed = JSON.parse(result.stdout);
      return parsed && typeof parsed === "object" ? parsed : null;
    }
  } catch {}

  try {
    const raw = fs.readFileSync(infoPath);
    if (!raw || raw.length < 16) return null;
    const header = raw.subarray(0, 6).toString("utf8");
    if (header === "bplist") return null;
    const text = raw.toString("utf8");
    return {
      CFBundleExecutable:
        text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim() ||
        null,
      CFBundleShortVersionString:
        text
          .match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
          ?.trim() || null
    };
  } catch {
    return null;
  }
}

function readAppBundleExecutableName(appPath) {
  const plist = readInfoPlist(appPath);
  return typeof plist?.CFBundleExecutable === "string" && plist.CFBundleExecutable.trim()
    ? plist.CFBundleExecutable.trim()
    : null;
}

function readAppBundleVersion(appPath) {
  const plist = readInfoPlist(appPath);
  return typeof plist?.CFBundleShortVersionString === "string" &&
    plist.CFBundleShortVersionString.trim()
    ? plist.CFBundleShortVersionString.trim()
    : null;
}

function resolveAppBundleExecutablePath(appPath, preferredName) {
  if (!appPath) return null;

  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (!existsDir(macosDir)) return null;

  if (preferredName) {
    const preferred = path.join(macosDir, preferredName);
    if (existsFile(preferred)) return preferred;
  }

  const fromPlist = readAppBundleExecutableName(appPath);
  if (fromPlist) {
    const direct = path.join(macosDir, fromPlist);
    if (existsFile(direct)) return direct;
  }

  const bundleName = path.basename(appPath, ".app");
  if (bundleName) {
    const direct = path.join(macosDir, bundleName);
    if (existsFile(direct)) return direct;
  }

  try {
    const entries = fs.readdirSync(macosDir, { withFileTypes: true });
    const file = entries.find(entry => entry.isFile());
    return file ? path.join(macosDir, file.name) : null;
  } catch {
    return null;
  }
}

module.exports = {
  readInfoPlist,
  readAppBundleExecutableName,
  readAppBundleVersion,
  resolveAppBundleExecutablePath,
  __test: {
    plistPath,
    existsDir,
    existsFile
  }
};
