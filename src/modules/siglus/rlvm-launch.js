const fs = require("node:fs");
const path = require("node:path");
const Launch = require("./launch");

function supports(info) { return info?.engineKind === "reallive" && info.format === "RealLive SEEN"; }
function inspectEntry(entry) {
  const info = Launch.inspectEntry({ ...entry, contentRootDir: fs.realpathSync(entry.contentRootDir || entry.gamePath) });
  if (!supports(info)) throw new Error("RLVM requires RealLive data with a SEEN.TXT archive. Choose siglus_rs for other formats.");
  // RLVM replaces backslashes in REGNAME and uses it below its save directory.
  // Reject path components that the upstream parser could treat as an escape.
  const ini = fs.readFileSync(info.iniPath).toString("latin1");
  const names = [...ini.matchAll(/^\s*#REGNAME\s*=\s*"([^"\r\n]*)"/gmi)].map(match => match[1]);
  if (names.length !== 1 || !names[0] || /[\/\x00-\x1f]/.test(names[0]) || [".", ".."].includes(names[0]))
    throw new Error("RLVM requires a valid REGNAME in Gameexe.ini.");
  return info;
}
function directory(entry, context) { return path.join(Launch.moduleRoot(entry, context), "rlvm"); }
function saveDirectory(entry, context) { return entry.saveDirOverride || path.join(directory(entry, context), "saves"); }
function link(source, target) {
  const prior = fs.lstatSync(target, { throwIfNoEntry: false });
  if (prior && !prior.isSymbolicLink()) throw new Error("An RLVM asset or save link conflicts with an existing file.");
  if (prior && fs.readlinkSync(target) === source) return;
  if (prior) fs.unlinkSync(target);
  fs.symlinkSync(source, target);
}
function prepareLaunch(entry, context, install) {
  const info = inspectEntry(entry), original = fs.realpathSync(entry.contentRootDir || entry.gamePath);
  const work = directory(entry, context), root = path.join(work, "project"), home = path.join(work, "home"), saves = saveDirectory(entry, context);
  if (!path.isAbsolute(saves)) throw new Error("Save directory must be absolute.");
  for (const file of [work, root, home]) {
    fs.mkdirSync(file, { recursive: true });
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("The RLVM data directory must not be a symbolic link.");
  }
  fs.mkdirSync(saves, { recursive: true });
  const names = new Set();
  for (const item of fs.readdirSync(original, { withFileTypes: true })) {
    // RLVM rejects some executable names even when the script data is RealLive.
    if (/\.exe$/i.test(item.name) || /^\.ds_store$/i.test(item.name)) continue;
    const source = path.join(original, item.name), resolved = fs.realpathSync(source);
    if (!resolved.startsWith(original + path.sep)) throw new Error("A RealLive resource points outside the game directory.");
    names.add(item.name); link(source, path.join(root, item.name));
  }
  if (!names.has(path.basename(info.scenarioPath)) || path.dirname(info.scenarioPath) !== original) {
    const existing = [...names].find(name => name.toLowerCase() === "seen.txt");
    if (existing) throw new Error("The RealLive scenario archive conflicts with SEEN.TXT in the game directory.");
    names.add("Seen.txt"); link(info.scenarioPath, path.join(root, "Seen.txt"));
  }
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink() && !names.has(item.name)) fs.unlinkSync(path.join(root, item.name));
  }
  const font = ["/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"]
    .find(file => fs.existsSync(file));
  if (font) link(font, path.join(home, "msgothic.ttc"));
  else if (!fs.readdirSync(original).some(name => name.toLowerCase() === "msgothic.ttc"))
    throw new Error("A Japanese font is required. Add msgothic.ttc to the game directory.");
  link(saves, path.join(home, ".rlvm"));
  entry.defaultSaveDir = saves; entry.moduleData = { ...entry.moduleData, ...info };
  const env = { ...process.env, HOME: home, MACLAUNCHER_RLVM_GAME: root, DYLD_INSERT_LIBRARIES: install.adapterPath };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  return { root, original, directory: work, saves, info, args: context.gameArguments || [], env };
}
function resolveSaveLocations(entry, context) {
  const saves = saveDirectory(entry, context);
  let exists = false; try { exists = fs.statSync(saves).isDirectory(); } catch {}
  return { primaryDirectory: saves, directories: [{ directory: saves, exists, source: "RLVM saves", confidence: "exact", label: "RLVM saves" }] };
}
module.exports = { supports, inspectEntry, prepareLaunch, resolveSaveLocations };
