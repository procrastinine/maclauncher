const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { inside, inspectDosProgram } = require("./detect");

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) throw new Error("DOSBox requires a game in the library.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "dosbox");
}
function driveDirectory(entry, context) {
  const directory = entry.saveDirOverride || path.join(gameDirectory(entry, context), "drive-c");
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("DOS game data requires an absolute local folder.");
  return directory;
}
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function prepareGame(entry, context) {
  const directory = gameDirectory(entry, context), drive = driveDirectory(entry, context);
  const source = fs.realpathSync(entry.contentRootDir || entry.gamePath), selected = entry.moduleData?.executablePath;
  if (!path.isAbsolute(selected || "") || !inside(source, fs.realpathSync(selected)) || !inspectDosProgram(selected)) throw new Error("The DOS program is missing or invalid.");
  const executable = fs.realpathSync(selected);
  let parent = drive;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (inside(source, path.join(fs.realpathSync(parent), path.relative(parent, drive)))) throw new Error("DOS game data must be stored outside the original game folder.");
  fs.mkdirSync(directory, { recursive: true });
  Writable.assertOwnDirectory(drive, drive);
  const record = path.join(directory, "files.json");
  let previous = {};
  try { const value = JSON.parse(fs.readFileSync(record, "utf8")); if (value.source === source && value.drive === drive) previous = value.files || {}; } catch {}
  const files = Object.create(null), parents = new Set(); let completed = 0;
  async function visit(from, relative = "") {
    context.signal?.throwIfAborted();
    const real = fs.realpathSync(from);
    if (!inside(source, real) || parents.has(real)) throw new Error("DOS game files must stay inside the imported folder without circular aliases.");
    parents.add(real);
    try {
      for (const item of fs.readdirSync(from, { withFileTypes: true })) {
        context.signal?.throwIfAborted();
        if ([".DS_Store", ".git"].includes(item.name)) continue;
        const name = relative ? path.join(relative, item.name) : item.name, input = path.join(from, item.name), output = path.join(drive, name);
        if (!inside(source, fs.realpathSync(input))) throw new Error("DOS game files must stay inside the imported folder.");
        const stat = fs.statSync(input);
        if (stat.isDirectory()) { Writable.assertOwnDirectory(drive, output); await visit(input, name); }
        else if (stat.isFile()) {
          const old = previous[name], stamp = `${stat.size}:${stat.mtimeMs}`;
          let destination;
          try { destination = fs.lstatSync(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw new Error("DOS game data contains an invalid file alias.");
          let hash = old?.sha256;
          if (!destination || !old || old.stamp !== stamp) {
            hash = digest(input);
            if (!destination || old && digest(output) === old.sha256) {
              Writable.atomicCopy(input, output, { root: drive });
              fs.chmodSync(output, stat.mode | 0o600);
            }
          }
          files[name] = { stamp, sha256: hash };
        } else throw new Error("DOS game inputs must be ordinary files and folders.");
        if (++completed % 128 === 0) { context.onProgress?.({ phase: "prepare", completed, label: "Starting game…" }); await new Promise(resolve => setImmediate(resolve)); }
      }
    } finally { parents.delete(real); }
  }
  await visit(source);
  Writable.atomicWrite(record, JSON.stringify({ source, drive, files }) + "\n", { root: directory });
  entry.defaultSaveDir = drive;
  return { directory, drive, executable: path.join(drive, path.relative(source, executable)) };
}
module.exports = { gameDirectory, driveDirectory, prepareGame };
