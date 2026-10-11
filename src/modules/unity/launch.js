const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const GameData = require("../shared/game-data");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { inspectData } = require("./detect");
const Steam = require("./steam");
const exec = promisify(execFile);
const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

function moduleRoot(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Unity requires a persisted library game and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "unity");
}

function inspectEntry(entry) {
  const root = entry.moduleData?.dataRoot;
  if (!path.isAbsolute(root || "") || root.includes("\0")) throw new Error("Unity game data was not found.");
  const info = inspectData(root);
  if (!info) throw new Error("Unity game data does not contain a supported exact player version.");
  return info;
}

function preflight(entry) {
  const info = inspectEntry(entry);
  if (info.scriptingBackend !== "mono") throw new Error("Windows IL2CPP code needs a native port; replacing its Unity player cannot run it.");
  if (info.graphics.status === "requires-shader-conversion") throw new Error("This Unity build contains Direct3D shaders. A Mac Mono player needs Metal or OpenGL shaders.");
  if (info.windowsApis.length) throw new Error("This game's Mono code uses Windows desktop APIs that the Mac player does not provide.");
  return info;
}

function validateSelection(info, selection) {
  if (!selection?.ready || !selection.profile?.templatePath) throw new Error(selection?.reason || "Install the exact Unity Mono player first.");
  if (selection.version !== info.detectedVersion) throw new Error(`The original game needs Unity ${info.detectedVersion}; its selected native player has a different version.`);
  return selection;
}

function linkFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.symlinkSync(from, to);
}

function bundlePlist(entry, selection) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>UnityPlayer</string><key>CFBundleIdentifier</key><string>com.maclauncher.unity.${escapeXml(entry.gameId)}</string><key>CFBundleName</key><string>${escapeXml(entry.name || "Unity game")}</string><key>CFBundleDisplayName</key><string>${escapeXml(entry.name || "Unity game")}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${escapeXml(selection.version)}</string><key>CFBundleVersion</key><string>${escapeXml(selection.install.upstreamRevision)}</string><key>NSMainNibFile</key><string>MainMenu</string><key>NSPrincipalClass</key><string>PlayerApplication</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>`;
}

async function prepareLaunch(entry, context, selection, { run = exec, steam = null } = {}) {
  const info = preflight(entry);
  validateSelection(info, selection);
  const root = moduleRoot(entry, context), final = path.join(root, "Game.app");
  fs.mkdirSync(root, { recursive: true });
  const recordPath = path.join(root, "prepared-player.json");
  let previous;
  try { previous = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch {}
  const basis = { layoutVersion: 2, dataRoot: info.dataRoot, version: selection.version, revision: selection.install.upstreamRevision,
    runtimeArchiveSha256: selection.install.archiveSha256, bundleName: entry.name || "Unity game", gameId: entry.gameId,
    ...(steam ? { steam: Steam.profileIdentity(steam) } : {}) };
  if (previous && JSON.stringify(previous.basis) === JSON.stringify(basis) && fs.existsSync(path.join(final, "Contents", "MacOS", "UnityPlayer"))) {
    Steam.verifyPlugins(path.join(final, "Contents"), path.join(final, "Contents", selection.profile.dataDirectory || "Resources/Data"),
      path.join(selection.profile.templatePath, "Contents"), steam);
    return { appPath: final, executablePath: path.join(final, "Contents", "MacOS", "UnityPlayer"), info, selection, preparation: "linked-original-assets" };
  }
  const temporary = fs.mkdtempSync(path.join(root, ".player-")), app = path.join(temporary, "Game.app"), contents = path.join(app, "Contents"), sourceContents = path.join(selection.profile.templatePath, "Contents");
  try {
    fs.mkdirSync(contents, { recursive: true });
    for (const item of fs.readdirSync(sourceContents, { withFileTypes: true })) {
      if (item.name === "Info.plist" || item.name === "_CodeSignature" || item.name === "Data" || (steam && item.name === "Plugins")) continue;
      const from = path.join(sourceContents, item.name), to = path.join(contents, item.name);
      if (item.name === "MacOS" && item.isDirectory()) {
        fs.mkdirSync(to);
        for (const native of fs.readdirSync(from, { withFileTypes: true })) {
          if (native.name === "UnityPlayer") fs.copyFileSync(path.join(from, native.name), path.join(to, native.name), fs.constants.COPYFILE_FICLONE);
          else linkFile(path.join(from, native.name), path.join(to, native.name));
        }
      } else if (item.name === "Resources" && item.isDirectory()) {
        fs.mkdirSync(to);
        for (const resource of fs.readdirSync(from, { withFileTypes: true })) {
          if (resource.name === "Data") continue;
          linkFile(path.join(from, resource.name), path.join(to, resource.name));
        }
      } else linkFile(from, to);
    }
    const data = path.join(contents, selection.profile.dataDirectory || "Resources/Data"); fs.mkdirSync(data, { recursive: true });
    for (const item of fs.readdirSync(info.dataRoot, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const from = path.join(info.dataRoot, item.name), to = path.join(data, item.name);
      // Platform libraries come from the native player; game code/assets remain
      // in place. Configuration is private because a game may update it.
      if (["Mono", "MonoBleedingEdge", "il2cpp_data", "Plugins"].includes(item.name)) continue;
      if (item.name === "Managed" && item.isDirectory() && selection.profile.playerLayout === "fused-mono") {
        fs.mkdirSync(to);
        for (const assembly of fs.readdirSync(from, { withFileTypes: true })) {
          if (assembly.name !== "etc" && (assembly.isFile() || assembly.isDirectory())) linkFile(path.join(from, assembly.name), path.join(to, assembly.name));
        }
        linkFile(path.join(sourceContents, "Data", "Managed", "etc"), path.join(to, "etc"));
      } else if (item.isFile() && /^(?:boot\.config|app\.info)$/i.test(item.name)) fs.copyFileSync(from, to);
      else if (item.isFile() || item.isDirectory()) linkFile(from, to);
    }
    Steam.stagePlugins(contents, data, sourceContents, steam);
    fs.writeFileSync(path.join(contents, "Info.plist"), bundlePlist(entry, selection));
    throwIfAborted(context.signal);
    // No --deep: referenced global libraries and original data must never be
    // signed or modified while signing this game's small owned entry bundle.
    await run("/usr/bin/codesign", ["--force", "--sign", "-", app], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 60000, ...(context.signal ? { signal: context.signal } : {}) });
    // Game assets and globally verified frameworks are intentionally external
    // links. Verify strict native code without treating those links as a sealed
    // distributable application's resource tree.
    await run("/usr/bin/codesign", ["--verify", "--strict", "--ignore-resources", app], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 30000, ...(context.signal ? { signal: context.signal } : {}) });
    throwIfAborted(context.signal);
    fs.rmSync(final, { recursive: true, force: true }); fs.renameSync(app, final);
    fs.writeFileSync(recordPath, JSON.stringify({ basis, appPath: final, preparation: "linked-original-assets", originalAssetsCopied: false }, null, 2));
    return { appPath: final, executablePath: path.join(final, "Contents", "MacOS", "UnityPlayer"), info, selection, preparation: "linked-original-assets" };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function rendererArguments(info, runtimeSettings = {}) {
  const renderer = runtimeSettings.renderer || "auto", available = info.graphics.nativeGraphicsAPIs;
  if (renderer === "metal") { if (available.length && !available.includes(16)) throw new Error("This build does not include Metal shaders."); return ["-force-metal"]; }
  if (renderer === "opengl") { if (available.length && !available.some(api => api === 0 || api === 17)) throw new Error("This build does not include OpenGL shaders."); return [available.includes(17) ? "-force-glcore" : "-force-opengl"]; }
  if (renderer !== "auto") throw new Error("Choose a supported Unity renderer.");
  return available.includes(16) ? ["-force-metal"] : available.includes(17) ? ["-force-glcore"] : available.includes(0) ? ["-force-opengl"] : [];
}

module.exports = { moduleRoot, inspectEntry, preflight, validateSelection, bundlePlist, prepareLaunch, rendererArguments };
