const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Inspect = require("../inspect");
const Archive = require("../archive");
const NativeBuild = require("../../shared/runtime/pinned-native-build");
const overlay = require("./impacto-overlay.json");
const SourcePatches = require("./source-patches");

const SOURCES = Object.freeze({
  impacto: { repository: "https://github.com/CommitteeOfZero/impacto", revision: Inspect.IMPACTO.revision },
  avcpp: { repository: "https://github.com/h4tr3d/avcpp", revision: "6bf8c76b120cf2cc448d706ea22f112017803605" },
  atrac9: { repository: "https://github.com/Thealexbarney/LibAtrac9", revision: "efca2e3af35562a09a9bb6deed90e45b4b824dc4" },
  magicEnum: { repository: "https://github.com/Neargye/magic_enum", revision: "591b64351ea8442f8b8fa044ff335d6943e8e6e0" },
  ffmpeg: { archive: "https://ffmpeg.org/releases/ffmpeg-7.1.2.tar.xz", version: "7.1.2", sha256: "089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304" },
  bink2: { repository: "https://github.com/sharpemu/ffmpeg-core", revision: "3b502d4ed79ec2c14066ca09f514db1e2ebb5265",
    patchPath: "bink2.patch", upstreamPatchSha256: "2c1b70354bb32471a5b1bb46ca3479e641fdd9d971c3eb4317c935040dd28fdc",
    patchSha256: "0405b8f018baa818a3392d70637a0246c6cf4eb9f37f738cd223784b41f477a8",
    adaptations: ["Normalize the alpha flag to a Boolean before plane iteration"], license: "LGPL-2.1-or-later" }
});

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function futureRealPath(file) {
  if (!path.isAbsolute(file || "")) throw new Error("An absolute owned storage path is required.");
  let current = file;
  const parts = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Native adapter storage is unavailable.");
    parts.unshift(path.basename(current)); current = parent;
  }
  return path.join(fs.realpathSync(current), ...parts);
}

function separateStorage(storage, sources) {
  const target = futureRealPath(storage);
  for (const source of sources) {
    const original = fs.realpathSync(source);
    if (target === original || target.startsWith(original + path.sep) || original.startsWith(target + path.sep)) {
      throw new Error("Native adapter storage must be separate from original games and source checkouts.");
    }
  }
  return target;
}

function luaString(value) {
  return '"' + String(value).replace(/[\\"\x00-\x1f\x7f]/g, character =>
    character === '"' ? '\\"' : character === "\\" ? "\\\\" : "\\" + character.charCodeAt(0).toString().padStart(3, "0")) + '"';
}

function requireOwnedFile(file) {
  if (!fs.existsSync(file)) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Native adapter state cannot use symbolic links."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Native adapter state must use owned regular files without links.");
}

function writeOwnedFile(file, data) {
  requireOwnedFile(file);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}

async function applyImpactoOverlay(stagedSource, { logPath, signal } = {}) {
  const patch = path.join(__dirname, "impacto.patch");
  if (hash(patch) !== overlay.overlaySha256) throw new Error("Impacto overlay hash differs from its pinned record.");
  // This hook accepts a copy owned by the build, never a Git checkout.
  if (fs.existsSync(path.join(stagedSource, ".git"))) throw new Error("Apply native overlays only to an owned staged source copy.");
  for (const file of overlay.files) {
    const target = path.join(stagedSource, file.path);
    if (file.originalSha256 === null ? fs.existsSync(target) : hash(target) !== file.originalSha256) {
      throw new Error(`Pinned Impacto source file differs: ${file.path}.`);
    }
  }
  const command = NativeBuild.findBuildTool("git");
  const options = { cwd: stagedSource, logPath, signal, env: SourcePatches.patchEnvironment(stagedSource) };
  await NativeBuild.runBuildCommand(command, ["apply", "--check", patch], options);
  await NativeBuild.runBuildCommand(command, ["apply", patch], options);
  for (const file of overlay.files) {
    if (hash(path.join(stagedSource, file.path)) !== file.adaptedSha256) throw new Error(`Impacto overlay result differs: ${file.path}.`);
  }
  return { upstreamRevision: overlay.upstreamRevision, overlaySha256: overlay.overlaySha256, files: overlay.files };
}

function validateWindowsData(gamePath) {
  const game = Inspect.inspectGame(gamePath);
  if (game?.editionId !== "steins-gate-windows-hd") throw new Error("The native adapter requires validated STEINS;GATE Windows HD MPK/SC3 data.");
  if (game.boot.filename.toLowerCase() !== "_startup_win.scx" || game.boot.id !== 2 || !game.boot.returnCount) throw new Error("The Windows startup program and return-id table do not match this adapter profile.");
  const system = Archive.inspectArchive(game.systemArchivePath);
  for (const [name, id] of [["data01.dds", 6], ["font.png", 9], ["backlog.dds", 2], ["title_chip.dds", 30], ["wavtable.dat", 31]]) {
    if (system.members.get(name)?.id !== id) throw new Error(`The Windows system resource mapping differs: ${name}.`);
  }
  for (const mount of ["script", "system", "bgm", "se", "voice", "bg", "chara", "mask"]) {
    Archive.inspectArchive(path.join(game.assetDir, mount + ".mpk"));
  }
  const movieDir = path.join(game.assetDir, "movie", "1920x1080");
  const stat = fs.lstatSync(movieDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The Windows 1920×1080 movie folder must be an original directory.");
  const titleMovie = path.join(movieDir, "title.bk2"), titleStat = fs.lstatSync(titleMovie);
  if (!titleStat.isFile() || titleStat.isSymbolicLink() || titleStat.size < 40) throw new Error("The original Windows title movie must be a regular Bink 2 file.");
  const fd = fs.openSync(titleMovie, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), header = Buffer.alloc(40);
  try { if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) throw new Error("The Windows title movie header is incomplete."); }
  finally { fs.closeSync(fd); }
  if (!/^KB2[abdhijk]$/.test(header.subarray(0, 4).toString("ascii")) || header.readUInt32LE(20) !== 1920 || header.readUInt32LE(24) !== 1080)
    throw new Error("The Windows title movie requires the 1920×1080 Bink 2 format.");
  return { game, movieDir };
}

function prepareWindowsSession({ gamePath, runtimeRoot, sessionDir, diagnosticFrames, diagnosticConfirmFrame, profileSource = path.join(__dirname, "windows-game.lua"), logLevel = "Info" }) {
  if (diagnosticFrames !== undefined && (!Number.isInteger(diagnosticFrames) || diagnosticFrames < 1 || diagnosticFrames > 3600))
    throw new Error("Diagnostic frames must be an integer from 1 to 3600.");
  if (diagnosticConfirmFrame !== undefined && (!Number.isInteger(diagnosticConfirmFrame) || diagnosticConfirmFrame < 1 ||
    diagnosticFrames === undefined || diagnosticConfirmFrame >= diagnosticFrames))
    throw new Error("A diagnostic confirm frame must be a positive integer before its diagnostic frame limit.");
  if (!["Trace", "Debug", "Info", "Warning", "Error", "Fatal"].includes(logLevel)) throw new Error("Choose a supported native log level.");
  const { game } = validateWindowsData(gamePath);
  const runtime = fs.realpathSync(runtimeRoot);
  const root = separateStorage(sessionDir, [game.contentRootDir, runtime]);
  const executable = path.join(runtime, "Impacto.app", "Contents", "MacOS", "Impacto");
  const resources = path.join(runtime, "Impacto.app", "Contents", "Resources");
  const profiles = path.join(runtime, "profiles");
  if (!fs.statSync(executable).isFile() || !fs.statSync(profiles).isDirectory()) throw new Error("The installed native adapter executable/profiles are unavailable.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const directory of ["saves", "patches"]) {
    const target = path.join(root, directory);
    if (fs.existsSync(target) && (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())) throw new Error("Native adapter state directories cannot use symbolic links.");
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  const gameProfile = path.join(root, "windows-game.lua");
  writeOwnedFile(gameProfile, fs.readFileSync(profileSource));
  const basePaths = { RootInstallDir: resources, RootGamedataDir: game.assetDir, RootProfilesDir: profiles,
    RootPatchesDir: path.join(root, "patches"), RootSavesDir: path.join(root, "saves") };
  writeOwnedFile(path.join(root, "basepaths.lua"), "root.BasePaths = { " + Object.entries(basePaths)
    .map(([key, value]) => `${key} = ${luaString(value)}`).join(", ") + " };\n");
  writeOwnedFile(path.join(root, "gamedefinitions.lua"), `root.GameDefinitions = { sgwin = { Name = "STEINS;GATE Windows", Hidden = true, GameProfile = ${luaString(gameProfile)} } };\n`);
  const logPath = path.join(root, "native.log");
  requireOwnedFile(logPath);
  requireOwnedFile(path.join(root, "userconfig.toml"));
  return { executable, cwd: resources, sessionDir: root, logPath,
    args: ["-g", "sgwin", "-bp", path.join(root, "basepaths.lua"), "-gc", path.join(root, "gamedefinitions.lua"),
      "-uc", path.join(root, "userconfig.toml"), "-ll", logLevel, "-lc", "All", "-lf", logPath,
      ...(diagnosticFrames === undefined ? [] : ["--diagnostic-frames", String(diagnosticFrames)]),
      ...(diagnosticConfirmFrame === undefined ? [] : ["--diagnostic-confirm-frame", String(diagnosticConfirmFrame)])],
    env: diagnosticFrames === undefined ? {} : { SDL_MAC_BACKGROUND_APP: "1", SDL_WINDOW_ACTIVATE_WHEN_SHOWN: "0",
      SDL_WINDOW_ACTIVATE_WHEN_RAISED: "0", ALSOFT_DRIVERS: "null" },
    profileSha256: hash(gameProfile), upstreamRevision: Inspect.IMPACTO.revision,
    qualification: "Windows HD beta; story and save compatibility varies." };
}

module.exports = { SOURCES, hash, futureRealPath, separateStorage, luaString, requireOwnedFile, writeOwnedFile, applyImpactoOverlay, validateWindowsData, prepareWindowsSession };
