// Compatibility with app v0.5.1: games/<id>/modules/alicesoft/saves.
// The shared original-game-mirrors-v1 migration calls this once for existing
// library entries. Ordinary Play never imports this module. Remove it when
// upgrades from v0.5.1 are no longer supported and retained saves are resolved.
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const LaunchArguments = require("../../shared/runtime/launch-arguments");

const { system3SaveRoot, system35SaveLocation, system4SaveRoot } = require("../save-paths");

// Conservative presence facts only. Native path parsing remains in save-paths;
// uncertainty here must never authorize replacing an authored save choice.
function authoredSaveSetting(file, pattern) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return true;
    const bytes = Buffer.alloc(64 * 1024 + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return length > 64 * 1024 || bytes.subarray(0, length).includes(0) || pattern.test(bytes.subarray(0, length).toString("latin1"));
  } catch (error) { return error.code !== "ENOENT"; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function sourceCreationAnchor(destination) {
  try { fs.lstatSync(destination); return; }
  catch (error) { if (error.code !== "ENOENT") return; }
  let parent = path.dirname(destination);
  while (parent !== path.dirname(parent)) {
    try { return fs.lstatSync(parent).isDirectory() ? parent : undefined; }
    catch (error) { if (error.code !== "ENOENT") return; }
    parent = path.dirname(parent);
  }
}

function legacyGameMirrors(entry, { userDataDir, environment = process.env } = {}) {
  if (!["system3", "system35", "system4"].includes(entry.moduleData?.generation) || !entry.gameId ||
      !path.isAbsolute(userDataDir || "") || !path.isAbsolute(entry.contentRootDir || "")) return [];
  const mirrorRoot = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "alicesoft"), "saves");
  if (typeof entry.saveDirOverride === "string" && entry.saveDirOverride.trim() &&
      path.resolve(entry.saveDirOverride.trim()) === mirrorRoot) return [];
  // A null destination retains existing private bytes and reports unresolved
  // policy through the one-time runner. Never substitute an unrelated root.
  let sourceRoot = null;
  let unresolvedReason;
  const generation = entry.moduleData.generation;
  const proven = path.isAbsolute(entry.defaultSaveDir || "") && path.resolve(entry.defaultSaveDir) === mirrorRoot;
  let explicit = Boolean(entry.saveDirOverride || generation === "system4" && (environment.XSYSTEM4_HOME || environment.XDG_DATA_HOME));
  if (proven) {
    if (generation === "system3") explicit ||= authoredSaveSetting(path.join(entry.contentRootDir, "system3.ini"), /^\s*savedir\s*=/im);
    else if (generation === "system35") explicit ||= [environment.HOME && path.join(environment.HOME, ".xsys35rc"), path.join(entry.contentRootDir, ".xsys35rc")]
      .filter(Boolean).some(file => authoredSaveSetting(file, /^\s*s\s*a\s*v\s*e\s*d\s*i\s*r\s*:/m));
    else explicit ||= [path.join(entry.contentRootDir, "System40.ini"), path.join(entry.contentRootDir, ".xsys4rc"),
      environment.HOME && path.join(environment.HOME, ".xsystem4/.xsys4rc")]
      .filter(Boolean).some(file => authoredSaveSetting(file, /\b(?:SaveFolder|save-folder)\s*=/));
  }
  try {
    const override = typeof entry.saveDirOverride === "string" ? entry.saveDirOverride.trim() : "";
    let nativeArguments;
    try { nativeArguments = LaunchArguments.parse(entry.launchArguments || ""); }
    catch (error) { explicit = true; throw error; }
    const pathOption = nativeArguments.find(arg => ["-savedir", "-gamedir", "-gamefile"].includes(arg) || /^--save-fol/.test(arg));
    explicit ||= Boolean(pathOption);
    if (pathOption) throw Error("Native launch arguments select " + pathOption + "; effective save/configuration options require review.");
    if (override && path.isAbsolute(override)) sourceRoot = override;
    else if (entry.moduleData.generation === "system3") sourceRoot = system3SaveRoot(entry.contentRootDir);
    else if (entry.moduleData.generation === "system4") sourceRoot = system4SaveRoot(entry.contentRootDir, environment);
    else {
      // Released -savedir used scenario-prefix slots. Current no-flag slot-name
      // changes need a separate recovery mapping, not different current facts.
      const names = fs.readdirSync(entry.contentRootDir);
      if (names.length > 20000) throw Error("System35 original directory exceeds its compatibility limit.");
      const prefixes = new Set(names.filter(name => /S[A-Z]\.ALD$/i.test(name)).map(name => name.slice(0, -5)));
      if (prefixes.size !== 1) throw Error("System35 save basename requires one unambiguous scenario prefix.");
      const location = system35SaveLocation(entry.contentRootDir, environment);
      if (!location.configured && names.some(name => /^.sleep\.asd$/i.test(name)))
        throw Error("System35 existing asleep-style saves select different slot names from released -savedir saves.");
      sourceRoot = location.directory;
    }
  } catch (error) { unresolvedReason = error.message; }
  const retainMirror = entry.moduleData.generation === "system35" && sourceRoot && !(typeof entry.saveDirOverride === "string" && entry.saveDirOverride.trim());
  const createSourceWithin = sourceRoot && sourceCreationAnchor(sourceRoot);
  return [{ mirrorRoot, sourceRoot, generated: [], ...(retainMirror ? { retainMirror: true } : {}),
    ...(proven ? { releasedSaveRoute: { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven, explicit } } : {}),
    ...(createSourceWithin ? { createSourceWithin } : {}), ...(unresolvedReason ? { unresolvedReason } : {}) }];
}

module.exports = { legacyGameMirrors };
