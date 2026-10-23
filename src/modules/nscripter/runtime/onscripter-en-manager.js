const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

const RELEASE = "2025-06-08";
const PROFILE = `${RELEASE}-mac-v2`;
const LEGACY_PROFILE = `${RELEASE}-mac-v1`;
const REVISION = "0a725088e01919e0c206533c793a84f69f06b833";
const RELEASES = [
  [RELEASE, REVISION], ["2024-07-21", "5e3a90cd0614808b17ea6bfdf6669b4b04a4c1ed"],
  ["2023-06-28", "f9da6eb9729153c920a61599a89695771591afb9"], ["2023-06-05", "a2233b6ff357cb29b695d63f045d5f9c704897a3"],
  ["2023-04-17", "03ee75feac872ddcd10d7f66f5e19d27cd2914af"], ["2023-04-11", "597299282ca59678720d8a84915bb4daf09fbd46"],
  ["2023-04-09", "6b167b84c6d28e16aae661329acc322648579d5f"], ["2023-02-25", "feb8de7f480f3c4ccb0a37f1a0c1751f88c92a4b"],
  ["2023-02-20", "df25bac6cbba7fee35cb808aa07fe56e51f4287f"]
];
function catalogEntry(release, upstreamRevision, sourceUrl) {
  return { version: `${release}-mac-v${release === RELEASE ? 2 : 1}`, upstreamRevision, upstreamTag: release, sourceUrl,
    label: `ONScripter-EN ${release}${release === RELEASE ? " · Mac v2" : ""}`, buildProfile: release === RELEASE ? "mac-sdl12-v2" : "mac-sdl12-v1", localBuild: release === RELEASE,
    hostArchitectures: ["arm64", "x64"], architecture: "native",
    installReason: release === RELEASE ? null : "No Mac runtime is available for this source release. The 2025-06-08 Mac version is included.",
    ...(release === RELEASE && upstreamRevision === REVISION ? { sourceArtifact: {
      directoryRelative: "onscripter-en/2025-06-08-mac-v2-source.tar.gz",
      sha256: "e22968f117627605cf2d7346d3da2d028b7a5321c3f5ea628da4d6607eeb2313", bytes: 51345295 } } : {}) };
}
function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({
    id: "onscripter-en", label: "ONScripter-EN", recommendedVersion: PROFILE,
    projectBuilds: { projectId: "onscripter-en", repository: "procrastinine/maclauncher-builds" },
    bundledExecution: "direct",
    sourceUrl: "https://github.com/Galladite27/ONScripter-EN/releases",
    catalog: [...RELEASES.map(([release, revision]) => catalogEntry(release, revision,
      `https://github.com/Galladite27/ONScripter-EN/releases/tag/${release}`)),
      { ...catalogEntry(RELEASE, REVISION, `https://github.com/Galladite27/ONScripter-EN/releases/tag/${RELEASE}`),
        version: LEGACY_PROFILE, sourceArtifact: undefined, label: `ONScripter-EN ${RELEASE} · Mac v1`, buildProfile: "mac-sdl12-v1", localBuild: false, deprecated: true,
        installReason: "ONScripter-EN Mac v1 remains available. Select Mac v2 for new installations." }],
    discoverCatalog: createGithubReleaseDiscovery({ owner: "Galladite27", repo: "ONScripter-EN",
      mapRelease: async (release, { resolveRevision, sourceUrl }) => /^\d{4}-\d{2}-\d{2}$/.test(release.tag_name || "")
        ? catalogEntry(release.tag_name, await resolveRevision(release), sourceUrl) : null,
      dependencies: dependencies.discovery || {} }),
    bundledRuntime: createBundledNativeRuntime({ managerId: "onscripter-en", ...(dependencies.bundle || {}) }),
    resolveExecutable: root => path.join(root, "bin", "onscripter-en"),
    buildSourcePath: path.resolve(__dirname, "../../../external/onscripter-en"),
    buildRuntime: options => require("./onscripter-en-build").buildRuntime({ ...options, dependencies: dependencies.build || {} }),
    buildRequirements: "Packaged releases include the complete native runtime. Development source builds require Apple's Command Line Tools; missing CMake/Ninja tools and pinned source dependencies download automatically during explicit Install.",
    dependencies: dependencies.manager || {}
  });
  const resolveSelection = manager.resolveSelection;
  manager.resolveSelection = (entry, settings, userDataDir) => {
    const version = entry?.runtimeData?.onscripter_en?.version;
    if (typeof version !== "string" || !version.trim()) return resolveSelection(entry, settings, userDataDir);
    return resolveSelection({ ...entry, runtimeData: { ...entry.runtimeData,
      "onscripter-en": { ...entry.runtimeData?.["onscripter-en"], version } } }, settings, userDataDir);
  };
  manager.distributionRequired = true;
  manager.distributionVersions = [PROFILE];
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
module.exports.PROFILE = PROFILE;
module.exports.LEGACY_PROFILE = LEGACY_PROFILE;
module.exports.RELEASE = RELEASE;
module.exports.REVISION = REVISION;
