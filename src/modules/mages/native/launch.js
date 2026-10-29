const fs = require("node:fs");
const path = require("node:path");
const Adapter = require("./adapter");
const Managers = require("./manager");
const WindowsInput = require("./windows-ui-data");
const InputSession = require("./windows-ui-session");
const AudioSession = require("./windows-audio-session");
const CheckpointSession = require("./windows-checkpoint-session");
const BacklogOverlay = require("./windows-backlog-overlay");
const SoundEffectSession = require("./windows-sfx-session");
const SoundEffectOverlay = require("./windows-sfx-overlay");
const Bundle = require("../../shared/runtime/bundled-native");
const ProjectCatalog = require("../../shared/runtime/maclauncher-builds");
const GameData = require("../../shared/game-data");

function sessionDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context?.userDataDir || ""))
    throw new Error("Import this game before starting its native runtime.");
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "mages"), "session");
}

// The Windows adaptation contracts this launcher implements, by the names a
// runtime manifest declares them with.
const ABIS = Object.freeze({ input: WindowsInput.ABI, audio: AudioSession.ABI, checkpoint: CheckpointSession.ABI,
  backlog: BacklogOverlay.ABI, soundEffect: SoundEffectOverlay.ABI });
const ABI_FIELDS = Object.freeze({ input: "windowsInputAbi", audio: "windowsAudioAbi", checkpoint: "windowsCheckpointAbi",
  backlog: "windowsBacklogAbi", soundEffect: "windowsSoundEffectAbi" });
function declaredAbis(provenance = {}) {
  const declared = provenance.currentWindowsAbiProfile ||
    Object.fromEntries(Object.entries(ABI_FIELDS).flatMap(([name, field]) => provenance[field] ? [[name, provenance[field]]] : []));
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) throw new Error("The Impacto runtime manifest is invalid.");
  for (const [name, abi] of Object.entries(declared))
    if (ABIS[name] !== abi) throw new Error("This Impacto runtime requires a newer MacLauncher. Choose another version.");
  return declared;
}

// The installed manifest describes the runtime: its sealed identity, the Windows
// contracts it implements and the game profile it was built for.
function verifyNativeProfile(install) {
  const downloaded = install?.source === "download";
  if (!install || !/^[a-f0-9]{40}$/.test(install.upstreamRevision || "") ||
      !["bundled", "download"].includes(install.source) || !path.isAbsolute(install.installDir || ""))
    throw new Error("Choose the Impacto Mac Windows HD runtime.");
  let manifestPath = Bundle.bundledManifestPath(install), expectedManifestSha256 = install.bundledManifestSha256;
  const runtimeRoot = path.join(install.installDir, downloaded ? "project-payload/files" : "files");
  if (downloaded) {
    const record = ProjectCatalog.validateProjectCatalog({ schemaVersion: 2, projectId: "impacto", updatePolicy: "manual",
      packages: [install.catalogEntry?.projectPackage] }, { projectId: "impacto", repository: "procrastinine/maclauncher-builds",
      architecture: process.arch }).packages[0];
    if (!record || record.version !== install.version || record.asset.sha256 !== install.archiveSha256 ||
        install.installationMetadata?.manifestSha256 !== record.manifestSha256)
      throw new Error("The Impacto runtime differs from its selected download.");
    manifestPath = path.join(install.installDir, "project-payload", record.manifestRelative);
    expectedManifestSha256 = record.manifestSha256;
  }
  const stored = Bundle.readRegular(manifestPath, Bundle.LIMITS.manifestBytes);
  stored.manifest = Bundle.validateManifest(JSON.parse(stored.bytes), {
    managerId: "impacto", version: install.version, upstreamRevision: install.upstreamRevision
  });
  if (stored.sha256 !== expectedManifestSha256)
    throw new Error("The Impacto runtime manifest changed. Reinstall the selected version.");
  const abis = declaredAbis(stored.manifest.provenance);
  const profileSource = Managers.profileFor(stored.manifest.provenance?.profileSha256);
  if (!profileSource) throw new Error("This Impacto runtime requires a newer MacLauncher game profile. Choose another version.");
  if (downloaded) Bundle.verifyPayload(runtimeRoot, stored.manifest);
  const executable = path.join(runtimeRoot, stored.manifest.executableRelative);
  if (executable !== install.executablePath || stored.manifest.executableRelative !== "Impacto.app/Contents/MacOS/Impacto")
    throw new Error("The Impacto runtime files differ from the selected package.");
  return { runtimeRoot, manifest: stored.manifest, abis, profileSource };
}

function inspectEntry(entry) {
  return Adapter.validateWindowsData(entry.contentRootDir || entry.gamePath).game;
}

function prepareLaunch(entry, context, install) {
  const { runtimeRoot, manifest, abis, profileSource } = verifyNativeProfile(install);
  if (manifest.provenance?.codecProbe?.bink2Decoder !== true)
    throw new Error("This Impacto runtime lacks the Bink 2 decoder. Choose a version with Bink 2 playback.");
  const prepareSession = abis.soundEffect ? SoundEffectSession.prepareWindowsSoundEffectSession :
    abis.checkpoint ? CheckpointSession.prepareWindowsCheckpointSession :
    abis.audio ? AudioSession.prepareWindowsAudioSession :
    abis.input ? InputSession.prepareWindowsInputSession : Adapter.prepareWindowsSession;
  const session = prepareSession({ gamePath: entry.contentRootDir || entry.gamePath,
    runtimeRoot, sessionDir: sessionDirectory(entry, context), profileSource, logLevel: "Info" });
  if (abis.backlog) session.backlogAbi = BacklogOverlay.ABI;
  const gameProfile = path.join(session.sessionDir, "windows-game.lua");
  const windowTitle = typeof entry.title === "string" && entry.title.trim()
    ? entry.title.trim() : path.basename(entry.contentRootDir || entry.gamePath);
  Adapter.writeOwnedFile(gameProfile, fs.readFileSync(gameProfile, "utf8") +
    `\nroot.WindowName = ${Adapter.luaString(windowTitle)};\n`);
  session.generatedProfileSha256 = Adapter.hash(gameProfile);
  const profile = path.basename(profileSource, ".lua"), overlaySha256 = manifest.provenance?.sourceOverlay?.overlaySha256 || null;
  const preparation = { profile, runtimeVersion: install.version,
    upstreamRevision: install.upstreamRevision, overlaySha256,
    profileSha256: session.profileSha256, generatedProfileSha256: session.generatedProfileSha256,
    minimumMacOS: manifest.minimumMacOS,
    originalDataRoot: fs.realpathSync(entry.contentRootDir || entry.gamePath),
    sessionDir: session.sessionDir, logPath: session.logPath,
    originalDataCopied: false, originalDataModified: false,
    qualification: "Windows HD beta with Bink 2. Story, auxiliary menus, saves and audio compatibility varies." };
  Adapter.writeOwnedFile(path.join(session.sessionDir, "preparation.json"), JSON.stringify(preparation, null, 2) + "\n");
  entry.moduleData = { ...entry.moduleData, nativeProfile: profile,
    nativeRuntimeVersion: install.version, nativeUpstreamRevision: install.upstreamRevision,
    nativeOverlaySha256: overlaySha256, nativeMinimumMacOS: manifest.minimumMacOS };
  return { ...session, preparation };
}

module.exports = { sessionDirectory, verifyNativeProfile, inspectEntry, prepareLaunch };
