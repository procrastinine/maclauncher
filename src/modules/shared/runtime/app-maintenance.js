const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function resolveEntryApp(entry) {
  for (const candidate of [entry?.nativeAppPath, entry?.gamePath, entry?.importPath]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || !candidate.toLowerCase().endsWith(".app")) continue;
    try {
      if (fs.statSync(candidate).isDirectory() && fs.statSync(path.join(candidate, "Contents")).isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

async function removeQuarantine(entry, { platform = process.platform, execute = execFile } = {}) {
  if (platform !== "darwin") throw new Error("App quarantine removal requires macOS.");
  const appPath = resolveEntryApp(entry);
  if (!appPath) throw new Error("A macOS app bundle was not found for this game.");
  await new Promise((resolve, reject) => {
    execute("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath], { timeout: 30000, maxBuffer: 1024 * 1024, shell: false },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`Could not remove app quarantine: ${String(stderr || error.message).trim()}`));
        else resolve();
      });
  });
  return { appPath, quarantineRemoved: true, status: "Quarantine removed. Try launching the app again." };
}

module.exports = { resolveEntryApp, removeQuarantine };
