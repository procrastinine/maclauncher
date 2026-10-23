const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const SevenZip = require("../shared/runtime/sevenzip");
const { buildEvbunpackCommand } = require("../shared/runtime/python");
const GameData = require("../shared/game-data");

function versionFromEntries(entries) {
  for (const name of entries || []) {
    const normalized = String(name).replace(/\\/g, "/").toLowerCase();
    if (/(^|\/)data\/scripts\.rvdata2$|\.rgss3a$/.test(normalized)) return "RGSS3";
    if (/(^|\/)data\/scripts\.rvdata$|\.rgss2a$/.test(normalized)) return "RGSS2";
    if (/(^|\/)data\/scripts\.rxdata$|\.rgssad$/.test(normalized)) return "RGSS1";
  }
  return null;
}

function resolveEvbHelper() {
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "src", "modules", "rgss", "evb-files.py");
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(__dirname, "evb-files.py");
}

function evbCommand(source, destination, legacy, userDataDir) {
  const tool = buildEvbunpackCommand({ userDataDir });
  const args = [resolveEvbHelper(), source];
  if (destination || legacy) args.push(destination || "");
  if (legacy) args.push("--legacy");
  return { command: tool.command, args, env: tool.env };
}

function inspectExe(source, helpers = {}) {
  // The section table is near the PE header. Avoid starting Python for ordinary
  // executables; the game itself is never executed by this probe.
  const fd = fs.openSync(source, "r");
  let enigma = false;
  try {
    const header = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, header, 0, header.length, 0);
    enigma = header.subarray(0, length).includes(Buffer.from(".enigma"));
  } finally {
    fs.closeSync(fd);
  }
  if (enigma) {
    for (const legacy of [false, true]) {
      const tool = evbCommand(source, null, legacy);
      const result = spawnSync(tool.command, tool.args, {
        env: tool.env, encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024
      });
      if (result.status !== 0) continue;
      try {
        const version = versionFromEntries(JSON.parse(result.stdout));
        if (version) return { packagedType: "enigma", packagedLegacy: legacy, rgssVersion: version };
      } catch {}
    }
    return null;
  }
  const entries = (helpers.readArchiveEntries || SevenZip.listArchiveEntriesSync)(source);
  const version = versionFromEntries(entries?.filter(e => !e.isDirectory).map(e => e.path));
  return version ? { packagedType: "sfx", rgssVersion: version } : null;
}

function validateArchiveEntries(entries) {
  for (const entry of entries || []) {
    const name = String(entry.path).replace(/\\/g, "/");
    if (entry.isLink || name.startsWith("/") || name.includes(":") || name.includes("\0") || name.split("/").includes("..")) {
      throw new Error("Unsafe path in RGSS executable archive.");
    }
  }
}

function findGameRoot(root) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    const detected = require("./detect").detectGame({ rootDir: dir });
    if (detected) return detected;
    if (depth >= 5) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

async function extract(entry, userDataDir) {
  const data = entry.moduleData || {};
  if (!data.packagedPath) return entry;
  const root = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "rgss"), "packaged");
  // Keep an existing extracted game: portable saves may have been written there.
  const marker = path.join(root, ".maclauncher-package.json");
  if (fs.existsSync(marker)) {
    const meta = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (meta.sourcePath !== data.packagedPath) throw new Error("RGSS extracted source mismatch.");
    const detected = findGameRoot(root);
    if (detected) return { ...entry, contentRootDir: detected.contentRootDir, defaultSaveDir: detected.contentRootDir, moduleData: { ...data, ...detected.moduleData } };
    throw new Error("Previously extracted RGSS game data is missing.");
  }
  const temp = `${root}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  try {
    if (data.packagedType === "enigma") {
      const tool = evbCommand(data.packagedPath, temp, data.packagedLegacy, userDataDir);
      await new Promise((resolve, reject) => {
        const child = spawn(tool.command, tool.args, { env: tool.env, stdio: "ignore" });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error("RGSS Enigma extraction failed.")));
      });
    } else if (data.packagedType === "sfx") {
      const entries = SevenZip.listArchiveEntriesSync(data.packagedPath);
      if (!entries) throw new Error("Cannot read RGSS executable archive.");
      validateArchiveEntries(entries);
      await SevenZip.extractArchive(data.packagedPath, temp);
    } else {
      throw new Error("Unsupported RGSS executable container.");
    }
    const detected = findGameRoot(temp);
    if (!detected) throw new Error("No RGSS game found inside executable.");
    fs.writeFileSync(path.join(temp, path.basename(marker)), JSON.stringify({ sourcePath: data.packagedPath }));
    // Never replace an existing extraction or its saves automatically.
    if (fs.existsSync(root)) throw new Error("RGSS extraction folder already exists without metadata.");
    fs.renameSync(temp, root);
    const contentRootDir = path.join(root, path.relative(temp, detected.contentRootDir));
    return { ...entry, contentRootDir, defaultSaveDir: contentRootDir, moduleData: { ...data, ...detected.moduleData } };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const pendingExtractions = new Map();
function ensureExtracted(entry, userDataDir) {
  if (!entry.moduleData?.packagedPath) return Promise.resolve(entry);
  const key = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "rgss");
  if (pendingExtractions.has(key)) return pendingExtractions.get(key);
  const pending = extract(entry, userDataDir).finally(() => pendingExtractions.delete(key));
  pendingExtractions.set(key, pending);
  return pending;
}

module.exports = { inspectExe, ensureExtracted, versionFromEntries, validateArchiveEntries, resolveEvbHelper };
