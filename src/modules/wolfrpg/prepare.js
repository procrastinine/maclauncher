const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { openArchive, writeModernArchive } = require("./archive");
const { inspectRoot } = require("./detect");
const Core = require("./runtime/core");
const { assertOwnDirectory, atomicCopy, atomicWrite } = require("../shared/writable-input");

function moduleDir(entry, context) {
  if (!/^[\w-]+$/.test(entry.gameId || "")) throw new Error("WOLF RPG game storage is unavailable.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "wolfrpg");
}
function sourceFiles(root, relative = "", out = [], seen = { count: 0 }) {
  if (relative.split("/").length > 32 || ++seen.count > 100000) throw new Error("WOLF RPG asset folder exceeds the storage limit.");
  const identities = new Set();
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.name.toLowerCase() === "save") continue;
    const identity = item.name.toLowerCase();
    if (identities.has(identity)) throw new Error("Ambiguous WOLF RPG asset name.");
    identities.add(identity);
    const name = relative ? relative + "/" + item.name : item.name;
    if (item.isDirectory()) sourceFiles(root, name, out, seen);
    else if (item.isFile()) { const stat = fs.statSync(path.join(root, name)); out.push({ name, size: stat.size, mtimeMs: stat.mtimeMs }); }
    else if (item.isSymbolicLink()) {
      const target = fs.realpathSync(path.join(root, name)), realRoot = fs.realpathSync(root), rel = path.relative(realRoot, target);
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("WOLF RPG assets must stay inside the game folder.");
      if (!fs.statSync(target).isFile()) throw new Error("WOLF RPG asset folders must not be aliases.");
      const stat = fs.statSync(target); out.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    if (out.length > 100000) throw new Error("WOLF RPG game contains too many files.");
  }
  return out;
}
function link(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination);
}
function settingsScript(entry, runtimeSettings = {}) {
  return "const WoditorGameSettings = " + JSON.stringify({ projectId: entry.gameId,
    projectName: String(entry.name || "WOLF RPG"), noSystemTouch: true, requestFullScreen: false,
    hideHeaderFooter: true, hideSideButtons: runtimeSettings.hideSideButtons !== false,
    switchUILeftRight: false, limitFPS: Number(runtimeSettings.limitFPS) === 30 ? 30 : 60, useNewPad: true }) + ";\n";
}
function patchIndex(source) {
  const matcher = /<script\b[^>]*\bsrc\s*=\s*["']woditor\.js["'][^>]*>/i;
  if (!matcher.test(source)) throw new Error("This Browser Woditor version has an unsupported startup page.");
  return source.replace(matcher, '<script>globalThis.MacLauncherWolf?.configure(Module);</script>\n$&');
}
function saveLocations(entry, context) {
  const primaryDirectory = path.join(moduleDir(entry, context), "saves");
  return { primaryDirectory, directories: [{ id: "browser-woditor", label: "Browser Woditor saves", directory: primaryDirectory }] };
}
function buildStage(entry, context, install) {
  const root = path.resolve(entry.gamePath), data = inspectRoot(root);
  if (!data) throw new Error("WOLF RPG game data was not found.");
  const owned = moduleDir(entry, context), marker = fs.readFileSync(path.join(install.installDir, "BrowserWoditor.dat"));
  const looseFiles = data.dataDir ? sourceFiles(data.dataDir) : [];
  const archiveStat = data.archivePath ? fs.statSync(data.archivePath) : null;
  const rootFiles = fs.readdirSync(root).filter(name => /\.(?:ini|ttf|otf|ttc|sf2|ogg|mp3|wav|ogv)$/i.test(name) && fs.statSync(path.join(root, name)).isFile());
  const key = crypto.createHash("sha256").update(JSON.stringify({ schema: 3, root,
    runtime: install.version, archive: archiveStat && [archiveStat.size, archiveStat.mtimeMs], looseFiles,
    rootFiles: rootFiles.map(name => { const stat = fs.statSync(path.join(root, name)); return [name, stat.size, stat.mtimeMs]; }),
    settings: settingsScript(entry, context.runtimeSettings) })).digest("hex");
  assertOwnDirectory(context.userDataDir, owned);
  const prepared = path.join(owned, "prepared", key), contentRoot = path.join(prepared, "public");
  const completed = path.join(prepared, "ready.json");
  assertOwnDirectory(owned, path.join(owned, "prepared"));
  if (fs.existsSync(prepared)) assertOwnDirectory(owned, contentRoot, { create: false });
  if (fs.existsSync(completed) && fs.existsSync(path.join(contentRoot, "index.html"))) return { prepared, contentRoot, key };
  const staging = path.join(owned, ".prepare-" + crypto.randomUUID()), stageRoot = path.join(staging, "public");
  assertOwnDirectory(owned, stageRoot);
  const initial = ["Game.ini", "DefaultSoundFont.sf2"];
  try {
    throwIfAborted(context.signal);
    for (const name of fs.readdirSync(install.contentRoot)) {
      if (["index.html", "settings.js", "Game.ini", "Data.wolf", "InitialDownloadList.ini", "readme.html"].includes(name)) continue;
      link(path.join(install.contentRoot, name), path.join(stageRoot, name));
    }
    for (const name of rootFiles) {
      const canonical = name.toLowerCase() === "game.ini" ? "Game.ini" : name;
      if (fs.existsSync(path.join(stageRoot, canonical))) fs.unlinkSync(path.join(stageRoot, canonical));
      link(path.join(root, name), path.join(stageRoot, canonical));
      if (canonical !== "Game.ini") initial.push(canonical);
    }
    if (!fs.existsSync(path.join(stageRoot, "Game.ini"))) fs.writeFileSync(path.join(stageRoot, "Game.ini"), "WindowModeFlag=1\r\nSEandBGM=3\r\n");
    let normalized = false;
    if (data.archivePath) {
      const archive = openArchive(data.archivePath);
      if (archive) {
        try {
          const markerEntry = { name: "BasicData/BrowserWoditor.dat", size: marker.length };
          const entries = archive.entries.filter(item => item.name.toLowerCase() !== markerEntry.name.toLowerCase());
          // Loose assets override the archive, as they do in the Windows game.
          const byName = new Map(entries.map(item => [item.name.toLowerCase(), item]));
          for (const item of looseFiles) byName.set(item.name.toLowerCase(), { ...item, source: path.join(data.dataDir, item.name) });
          byName.set(markerEntry.name.toLowerCase(), markerEntry);
          writeModernArchive([...byName.values()], item => item === markerEntry ? marker : item.source ? fs.readFileSync(item.source) : archive.readEntry(item), path.join(stageRoot, "Data.wolf"), { signal: context.signal });
          normalized = true;
        } finally { archive.close(); }
      } else throw new Error("This WOLF archive format is unsupported. Unpacked game data can be opened instead.");
      initial.push("Data.wolf");
    } else if (!looseFiles.some(item => /\.wolf$/i.test(item.name))) {
      const markerEntry = { name: "BasicData/BrowserWoditor.dat", size: marker.length };
      writeModernArchive([...looseFiles.filter(item => item.name.toLowerCase() !== markerEntry.name.toLowerCase()), markerEntry], item => item === markerEntry ? marker : fs.readFileSync(path.join(data.dataDir, item.name)), path.join(stageRoot, "Data.wolf"), { signal: context.signal });
      initial.push("Data.wolf"); normalized = true;
    }
    if (!normalized && data.dataDir) {
      for (const item of looseFiles) {
        throwIfAborted(context.signal);
        const dest = path.join(stageRoot, "Data", item.name);
        if (/\.wolf$/i.test(item.name)) {
          const archive = openArchive(path.join(data.dataDir, item.name));
          if (archive) {
            try {
              const entries = archive.entries;
              const isBasic = path.basename(item.name).toLowerCase() === "basicdata.wolf";
              const markerEntry = { name: "BrowserWoditor.dat", size: marker.length };
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              writeModernArchive(isBasic ? [...entries.filter(value => value.name.toLowerCase() !== "browserwoditor.dat"), markerEntry] : entries, value => value === markerEntry ? marker : archive.readEntry(value), dest, { signal: context.signal });
            } finally { archive.close(); }
          } else throw new Error("This WOLF archive format is unsupported. Unpacked game data can be opened instead.");
        } else link(path.join(data.dataDir, item.name), dest);
        initial.push("Data/" + item.name);
      }
    }
    // Partial layouts without a BasicData archive need the marker loose.
    if (!normalized) {
      const markerPath = path.join(stageRoot, "Data", "BasicData", "BrowserWoditor.dat");
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
      fs.writeFileSync(markerPath, marker); initial.push("Data/BasicData/BrowserWoditor.dat");
    }
    fs.writeFileSync(path.join(stageRoot, "settings.js"), settingsScript(entry, context.runtimeSettings));
    fs.writeFileSync(path.join(stageRoot, "InitialDownloadList.ini"), [...new Set(initial)].join("\r\n") + "\r\n");
    fs.writeFileSync(path.join(stageRoot, "index.html"), patchIndex(fs.readFileSync(path.join(install.contentRoot, "index.html"), "utf8")));
    fs.writeFileSync(path.join(stageRoot, "readme.html"), "<!doctype html><meta charset=utf-8><title>Browser Woditor</title><p>Keyboard: arrows to move, Enter to confirm, Escape to cancel, Shift for the alternate action.</p>");
    fs.writeFileSync(path.join(stageRoot, "package.json"), JSON.stringify({ window: { width: 960, height: 720, title: entry.name || "WOLF RPG" } }) + "\n");
    fs.writeFileSync(path.join(staging, "ready.json"), JSON.stringify({ key, runtimeVersion: install.version }) + "\n");
    throwIfAborted(context.signal); fs.mkdirSync(path.dirname(prepared), { recursive: true });
    fs.renameSync(staging, prepared);
    return { prepared, contentRoot, key };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
function seedSaves(entry, context) {
  const owned = moduleDir(entry, context), receipt = path.join(owned, "save-seeded.json");
  const destination = entry.saveDirOverride || saveLocations(entry, context).primaryDirectory;
  const source = require("./detect").findName(entry.gamePath, "Save");
  assertOwnDirectory(context.userDataDir, owned);
  if (fs.existsSync(receipt)) return;
  const relative = path.relative(owned, destination);
  assertOwnDirectory(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) ? destination : owned, destination);
  if (source && fs.statSync(source).isDirectory() && fs.readdirSync(destination).length === 0) {
    for (const file of sourceFiles(source)) {
      throwIfAborted(context.signal);
      atomicCopy(path.join(source, file.name), path.join(destination, "Save", file.name), { root: destination });
    }
  }
  atomicWrite(receipt, JSON.stringify({ schemaVersion: 1 }) + "\n", { root: owned });
}
function prepareLaunch(entry, context) {
  const override = entry.runtimeData?.["browser-woditor"]?.version;
  const install = Core.resolveInstalled({ userDataDir: context.userDataDir, version: override });
  if (!install) throw new Error("Browser Woditor is not installed.");
  const stage = buildStage(entry, context, install);
  seedSaves(entry, context);
  entry.contentRootDir = stage.contentRoot; entry.indexDir = stage.contentRoot; entry.indexHtml = path.join(stage.contentRoot, "index.html");
  entry.defaultSaveDir = saveLocations(entry, context).primaryDirectory;
  entry.moduleData = { ...entry.moduleData, preparedRoot: stage.contentRoot, runtimeVersion: install.version, preparationKey: stage.key };
  return stage;
}
function contentReadRoots(entry, context) {
  const version = entry.moduleData?.runtimeVersion;
  const install = version && Core.resolveInstalled({ userDataDir: context.userDataDir, version });
  return [entry.gamePath, install?.contentRoot].filter(Boolean).map(value => fs.realpathSync(value));
}
module.exports = { prepareLaunch, buildStage, patchIndex, settingsScript, saveLocations, contentReadRoots, sourceFiles, moduleDir };
