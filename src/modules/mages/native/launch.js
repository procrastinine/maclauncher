const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const Adapter = require("./adapter");
const Managers = require("./manager");
const WindowsInput = require("./windows-ui-data");
const InputSession = require("./windows-ui-session");
const AudioSession = require("./windows-audio-session");
const CheckpointSession = require("./windows-checkpoint-session");
const CheckpointOverlay = require("./windows-checkpoint-overlay");
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

function verifyNativeProfile(install) {
  const pin = Managers.reviewedVersion(install?.version);
  const downloaded = install?.source === "download";
  if (!pin || install.upstreamRevision !== pin.upstreamRevision ||
      !["bundled", "download"].includes(install.source) || !path.isAbsolute(install.installDir || ""))
    throw new Error("Choose the Impacto Mac Windows HD runtime.");
  let manifestPath = Bundle.bundledManifestPath(install), expectedManifestSha256 = install.bundledManifestSha256;
  const runtimeRoot = path.join(install.installDir, downloaded ? "project-payload/files" : "files");
  if (downloaded) {
    const record = ProjectCatalog.validateProjectCatalog({ schemaVersion: 2, projectId: "impacto", updatePolicy: "manual",
      packages: [install.catalogEntry?.projectPackage] }, { projectId: "impacto", repository: "procrastinine/maclauncher-builds",
      architecture: process.arch }).packages[0];
    if (!record || record.version !== pin.version || record.asset.sha256 !== install.archiveSha256 ||
        install.installationMetadata?.manifestSha256 !== record.manifestSha256)
      throw new Error("The Impacto runtime differs from its selected download.");
    manifestPath = path.join(install.installDir, "project-payload", record.manifestRelative);
    expectedManifestSha256 = record.manifestSha256;
  }
  const stored = Bundle.readRegular(manifestPath, Bundle.LIMITS.manifestBytes);
  stored.manifest = Bundle.validateManifest(JSON.parse(stored.bytes), {
    managerId: "impacto", version: pin.version, upstreamRevision: pin.upstreamRevision
  });
  if (stored.sha256 !== expectedManifestSha256 ||
      stored.manifest.provenance?.sourceOverlay?.overlaySha256 !== pin.overlaySha256 ||
      stored.manifest.provenance?.profileSha256 !== pin.profileSha256 || Adapter.hash(Managers.profilePath(pin.version)) !== pin.profileSha256)
    throw new Error("The Impacto runtime source or game profile checksum changed. Reinstall the selected version.");
  if (pin.dependencyOverlaySha256 && (stored.manifest.provenance?.dependencyOverlaySha256 !== pin.dependencyOverlaySha256 ||
      stored.manifest.provenance?.codecProbe?.sourceSha256 !== pin.codecProbeSourceSha256 ||
      stored.manifest.provenance?.codecProbe?.bink2Decoder !== true ||
      stored.manifest.provenance?.codecProbe?.headerLibraryVersionsMatch !== true))
    throw new Error("The Impacto Bink 2 dependencies do not match the selected version. Reinstall this runtime.");
  if (pin.portableDependenciesVersion && (stored.manifest.minimumMacOS !== pin.minimumMacOS ||
      stored.manifest.provenance?.sourceTreeSha256 !== pin.sourceTreeSha256 ||
      stored.manifest.provenance?.portableDependencies?.version !== pin.portableDependenciesVersion ||
      stored.manifest.provenance?.portableDependencies?.recipeSha256 !== pin.portableDependenciesRecipeSha256))
    throw new Error("The selected Impacto dependency version or checksum changed.");
  if (pin.version === Managers.CURRENT_VERSION &&
      (pin.profile !== Managers.V9_PROFILE || pin.profileSha256 !== SoundEffectSession.PROFILE_SHA256 ||
       !isDeepStrictEqual(pin.currentWindowsAbiProfile, { input: WindowsInput.ABI, audio: AudioSession.ABI,
         checkpoint: CheckpointSession.ABI, backlog: BacklogOverlay.ABI, soundEffect: SoundEffectOverlay.ABI }) ||
       !isDeepStrictEqual(stored.manifest.provenance?.currentWindowsAbiProfile, pin.currentWindowsAbiProfile) ||
       stored.manifest.provenance?.sourceOverlay?.upstreamRevision !== pin.upstreamRevision))
    throw new Error("The selected Impacto Windows adaptation differs from its source profile.");
  if ([Managers.V5_VERSION, Managers.V6_VERSION, Managers.V7_VERSION, Managers.V8_VERSION, Managers.V9_VERSION].includes(pin.version)) {
    const input = stored.manifest.provenance?.windowsUiOverlay;
    const profile = pin.version === Managers.V9_VERSION ? Managers.V9_PROFILE :
      pin.version === Managers.V8_VERSION ? Managers.V8_PROFILE :
      pin.version === Managers.V7_VERSION ? Managers.V7_PROFILE :
      pin.version === Managers.V6_VERSION ? Managers.V6_PROFILE : Managers.V5_PROFILE;
    const profileSha256 = pin.version === Managers.V9_VERSION ? SoundEffectSession.PROFILE_SHA256 :
      [Managers.V7_VERSION, Managers.V8_VERSION].includes(pin.version) ? CheckpointSession.PROFILE_SHA256 :
      pin.version === Managers.V6_VERSION ? AudioSession.PROFILE_SHA256 : InputSession.PROFILE_SHA256;
    if (pin.profile !== profile || pin.profileSha256 !== profileSha256 ||
        pin.windowsInputAbi !== WindowsInput.ABI || stored.manifest.provenance?.windowsInputAbi !== pin.windowsInputAbi ||
        input?.abi !== pin.windowsInputAbi || !isDeepStrictEqual(input.modes, [13, 14]) ||
        !isDeepStrictEqual(input, stored.manifest.provenance?.sourceOverlay?.windowsUiOverlay))
      throw new Error("The selected Impacto Windows input version or checksum changed.");
  }
  if ([Managers.V6_VERSION, Managers.V7_VERSION, Managers.V8_VERSION, Managers.V9_VERSION].includes(pin.version)) {
    const audio = stored.manifest.provenance?.windowsAudioOverlay;
    if (pin.windowsAudioAbi !== AudioSession.ABI ||
        stored.manifest.provenance?.windowsAudioAbi !== pin.windowsAudioAbi ||
        audio?.abi !== pin.windowsAudioAbi || !isDeepStrictEqual(audio.opcodes, [0x37, 0x38, 0x39]) ||
        !isDeepStrictEqual(audio, stored.manifest.provenance?.sourceOverlay?.windowsAudioOverlay))
      throw new Error("The selected Impacto Windows audio version or checksum changed.");
  }
  if ([Managers.V7_VERSION, Managers.V8_VERSION, Managers.V9_VERSION].includes(pin.version)) {
    const checkpoint = stored.manifest.provenance?.windowsCheckpointOverlay;
    const originals = { ...CheckpointOverlay.ORIGINALS,
      ...Object.fromEntries(Object.keys(CheckpointOverlay.COPIES).map(file => [file, null])) };
    if (pin.windowsCheckpointAbi !== CheckpointSession.ABI ||
        stored.manifest.provenance?.windowsCheckpointAbi !== pin.windowsCheckpointAbi ||
        checkpoint?.abi !== pin.windowsCheckpointAbi || checkpoint.opcodeGroup !== 0x10 ||
        checkpoint.opcode !== 0x22 || checkpoint.checkpointType !== 10 || checkpoint.checkpointBytes !== 2 ||
        !Array.isArray(checkpoint.files) || checkpoint.files.length !== Object.keys(originals).length ||
        new Set(checkpoint.files.map(file => file?.path)).size !== checkpoint.files.length ||
        checkpoint.files.some(file => !file || !Object.hasOwn(originals, file.path) ||
          file.originalSha256 !== originals[file.path] || !/^[a-f0-9]{64}$/.test(file.adaptedSha256 || "")) ||
        !isDeepStrictEqual(checkpoint, stored.manifest.provenance?.sourceOverlay?.windowsCheckpointOverlay))
      throw new Error("The selected Impacto Windows checkpoint version or checksum changed.");
  }
  if ([Managers.V8_VERSION, Managers.V9_VERSION].includes(pin.version)) {
    const backlog = stored.manifest.provenance?.windowsBacklogOverlay;
    if (pin.windowsBacklogAbi !== BacklogOverlay.ABI ||
        stored.manifest.provenance?.windowsBacklogAbi !== pin.windowsBacklogAbi ||
        backlog?.abi !== pin.windowsBacklogAbi || backlog.disabledCapacity !== 0 ||
        !Array.isArray(backlog.files) || backlog.files.length !== 1 ||
        backlog.files[0]?.path !== BacklogOverlay.FILE ||
        backlog.files[0].originalSha256 !== BacklogOverlay.ORIGINAL_SHA256 ||
        !/^[a-f0-9]{64}$/.test(backlog.files[0].adaptedSha256 || "") ||
        !isDeepStrictEqual(backlog, stored.manifest.provenance?.sourceOverlay?.windowsBacklogOverlay))
      throw new Error("The selected Impacto Windows backlog version or checksum changed.");
  }
  if (pin.version === Managers.V9_VERSION) {
    const sound = stored.manifest.provenance?.windowsSoundEffectOverlay;
    const originals = { ...SoundEffectOverlay.ORIGINALS,
      ...Object.fromEntries(Object.keys(SoundEffectOverlay.COPIES).map(file => [file, null])) };
    if (pin.windowsSoundEffectAbi !== SoundEffectOverlay.ABI ||
        stored.manifest.provenance?.windowsSoundEffectAbi !== pin.windowsSoundEffectAbi ||
        sound?.abi !== pin.windowsSoundEffectAbi || !isDeepStrictEqual(sound.opcodes, [0x23]) ||
        !isDeepStrictEqual(sound.channels, [0, 1, 2]) || !isDeepStrictEqual(sound.types, [0, 1, 2]) ||
        !Array.isArray(sound.files) || sound.files.length !== Object.keys(originals).length ||
        new Set(sound.files.map(file => file?.path)).size !== sound.files.length ||
        sound.files.some(file => !file || !Object.hasOwn(originals, file.path) ||
          file.originalSha256 !== originals[file.path] || !/^[a-f0-9]{64}$/.test(file.adaptedSha256 || "")) ||
        !isDeepStrictEqual(sound, stored.manifest.provenance?.sourceOverlay?.windowsSoundEffectOverlay))
      throw new Error("The selected Impacto Windows sound-effect version or checksum changed.");
  }
  if (downloaded) Bundle.verifyPayload(runtimeRoot, stored.manifest);
  const executable = path.join(runtimeRoot, stored.manifest.executableRelative);
  if (executable !== install.executablePath || stored.manifest.executableRelative !== "Impacto.app/Contents/MacOS/Impacto")
    throw new Error("The Impacto runtime files differ from the selected package.");
  return { runtimeRoot, manifest: stored.manifest, pin };
}

function inspectEntry(entry) {
  return Adapter.validateWindowsData(entry.contentRootDir || entry.gamePath).game;
}

function prepareLaunch(entry, context, install) {
  const { runtimeRoot, manifest, pin } = verifyNativeProfile(install);
  if (pin.version === Managers.V2_VERSION)
    throw new Error("Impacto Windows Mac v2 lacks the Bink 2 decoder. Choose the default version for Bink 2 playback.");
  const prepareSession = pin.windowsSoundEffectAbi ? SoundEffectSession.prepareWindowsSoundEffectSession :
    [Managers.V7_VERSION, Managers.V8_VERSION].includes(pin.version) ? CheckpointSession.prepareWindowsCheckpointSession :
    pin.version === Managers.V6_VERSION ? AudioSession.prepareWindowsAudioSession :
    pin.version === Managers.V5_VERSION ? InputSession.prepareWindowsInputSession : Adapter.prepareWindowsSession;
  const session = prepareSession({ gamePath: entry.contentRootDir || entry.gamePath,
    runtimeRoot, sessionDir: sessionDirectory(entry, context), profileSource: Managers.profilePath(pin.version), logLevel: "Info" });
  if (pin.windowsBacklogAbi) session.backlogAbi = BacklogOverlay.ABI;
  const gameProfile = path.join(session.sessionDir, "windows-game.lua");
  const windowTitle = typeof entry.title === "string" && entry.title.trim()
    ? entry.title.trim() : path.basename(entry.contentRootDir || entry.gamePath);
  Adapter.writeOwnedFile(gameProfile, fs.readFileSync(gameProfile, "utf8") +
    `\nroot.WindowName = ${Adapter.luaString(windowTitle)};\n`);
  session.generatedProfileSha256 = Adapter.hash(gameProfile);
  const preparation = { profile: pin.profile, runtimeVersion: install.version,
    upstreamRevision: install.upstreamRevision, overlaySha256: pin.overlaySha256,
    profileSha256: session.profileSha256, generatedProfileSha256: session.generatedProfileSha256,
    minimumMacOS: manifest.minimumMacOS,
    originalDataRoot: fs.realpathSync(entry.contentRootDir || entry.gamePath),
    sessionDir: session.sessionDir, logPath: session.logPath,
    originalDataCopied: false, originalDataModified: false,
    qualification: pin.version === Managers.LEGACY_VERSION
      ? "Windows HD v1 beta with title/menu input. Story, auxiliary menus, saves and audio compatibility varies."
      : "Windows HD beta with Bink 2. Story, auxiliary menus, saves and audio compatibility varies." };
  Adapter.writeOwnedFile(path.join(session.sessionDir, "preparation.json"), JSON.stringify(preparation, null, 2) + "\n");
  entry.moduleData = { ...entry.moduleData, nativeProfile: pin.profile,
    nativeRuntimeVersion: install.version, nativeUpstreamRevision: install.upstreamRevision,
    nativeOverlaySha256: pin.overlaySha256, nativeMinimumMacOS: manifest.minimumMacOS };
  return { ...session, preparation };
}

module.exports = { sessionDirectory, verifyNativeProfile, inspectEntry, prepareLaunch };
