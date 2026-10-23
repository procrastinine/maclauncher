const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { BUTTERSCOTCH_BUILDS, BUTTERSCOTCH_REVISION, BUTTERSCOTCH_ARGUMENTS_VERSION } = require("./catalog");
const { findBuildTool } = require("../../shared/runtime/pinned-native-build");
const { createBundledNativeRuntime, systemVersionSync } = require("../../shared/runtime/bundled-native");
const { createGithubCommitDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Downloads = require("./butterscotch-downloads");

function mapCommit(commit, { sourceUrl }) {
  const date = commit.commit?.committer?.date?.slice(0, 10);
  if (!/^[a-f0-9]{40}$/.test(commit.sha || "") || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Butterscotch source discovery requires exact commit and date metadata.");
  const reviewed = BUTTERSCOTCH_BUILDS.find(pin => pin.upstreamRevision === commit.sha);
  return reviewed ? { ...reviewed, sourceUrl, sourceKind: "commit", versionLabel: `${date} · ${commit.sha.slice(0, 12)} (AppKit)` } : {
    version: `${date}-${commit.sha}-appkit`, versionLabel: `${date} · ${commit.sha.slice(0, 12)} (AppKit source)`,
    upstreamRevision: commit.sha, sourceUrl, sourceKind: "commit", publishedAt: commit.commit.committer.date,
    backend: "appkit", renderer: "legacy-opengl", videoBackend: "none", license: "AGPL-3.0-only",
    minimumMacOS: "13.0", evidence: "upstream-commit-source-only", localBuild: true,
    gameplayQualified: false, wadVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17] };
}
const discoverSourceCatalog = createGithubCommitDiscovery({ owner: "ButterscotchRunner", repo: "Butterscotch", mapCommit, limit: 20 });
const discoverCatalog = Downloads.createDownloadDiscovery();

function createManager(dependencies = {}) {
  const runtime = createPinnedNativeManager({ id: "butterscotch", label: "Butterscotch", catalog: [...Downloads.PUBLIC_BUILDS, ...BUTTERSCOTCH_BUILDS],
  projectBuilds: { projectId: "butterscotch", repository: "procrastinine/maclauncher-builds" },
  bundledExecution: "direct", distributionRequired: true, importLocal: true,
  recommendedVersion: BUTTERSCOTCH_BUILDS[0].version, discoverCatalog: Downloads.createDownloadDiscovery({ dependencies }),
  buildRuntime: options => buildRuntime({ ...options, runtimeManager: runtime }),
  buildSourcePath: path.resolve(__dirname, "../../../external/Butterscotch"),
  bundledRuntime: createBundledNativeRuntime({ managerId: "butterscotch" }),
  buildHelpUrl: `https://github.com/ButterscotchRunner/Butterscotch/tree/${BUTTERSCOTCH_REVISION}#building-butterscotch`,
  sourceUrl: "https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml",
  resolveExecutable: Downloads.resolveExecutable, prepareInstall: options => Downloads.prepareInstall(options, dependencies), dependencies });
  const automaticDefault = userDataDir => Downloads.automaticVersion(runtime.core.listCatalog({ userDataDir }), {
    hostVersion: process.platform === "darwin" || dependencies.systemVersionSync ? (dependencies.systemVersionSync || systemVersionSync)() : null,
    now: (dependencies.now || Date.now)() }) || BUTTERSCOTCH_BUILDS[0].version;
  const resolveSelection = runtime.resolveSelection, getState = runtime.getState, installRuntime = runtime.installRuntime,
    refreshCatalog = runtime.refreshCatalog;
  runtime.refreshCatalog = options => refreshCatalog({ latestOnly: true, ...options });
  runtime.resolveSelection = (entry, settings, userDataDir, options = {}) => {
    const gameVersion = entry?.runtimeData?.butterscotch?.version;
    const explicit = options.version && options.version !== "auto" || typeof gameVersion === "string" && gameVersion.trim() && gameVersion.trim() !== "auto";
    const automatic = typeof entry?.launchArguments === "string" && entry.launchArguments.trim()
      ? BUTTERSCOTCH_ARGUMENTS_VERSION : automaticDefault(userDataDir);
    if (explicit) return resolveSelection(entry, settings, userDataDir, options);
    if (automatic !== BUTTERSCOTCH_ARGUMENTS_VERSION) {
      const installed = resolveSelection(entry, settings, userDataDir, options);
      if (installed.ready) return installed;
    }
    return resolveSelection(entry, settings, userDataDir, { ...options, version: automatic });
  };
  runtime.getState = options => {
    const state = getState(options);
    const catalog = { ...state.catalog, recommendedVersion: automaticDefault(options?.userDataDir), supportsLatestOnly: true };
    return { ...state, catalog, sections: state.sections.map(section => ({ ...section, catalog })) };
  };
  runtime.installRuntime = options => installRuntime({ ...options, version: options?.version || automaticDefault(options?.userDataDir) });
  runtime.distributionVersions = [BUTTERSCOTCH_BUILDS[0].version, BUTTERSCOTCH_ARGUMENTS_VERSION];
  return runtime;
}
const manager = createManager();

function resolveSourceRoot() {
  const candidates = [path.resolve(__dirname, "../../../external/Butterscotch"),
    process.resourcesPath && path.join(process.resourcesPath, "external", "Butterscotch")].filter(Boolean);
  const source = candidates.find(candidate => fs.existsSync(path.join(candidate, "CMakeLists.txt")));
  if (!source) throw new Error("Butterscotch source is missing. Initialize src/external/Butterscotch or import a compatible runtime.");
  return source;
}

async function buildRuntime({ userDataDir, version = BUTTERSCOTCH_BUILDS[0].version, sourceDir, logger, signal, runtimeManager = manager } = {}) {
  if (process.platform !== "darwin") throw new Error("Butterscotch AppKit builds require macOS.");
  const installed = runtimeManager.core.resolveRegistered({ userDataDir, version });
  if (installed) return installed;
  runtimeManager.core.normalizeVersion(version);
  const pin = runtimeManager.core.catalog.find(entry => entry.version === version);
  if (pin?.asset) throw new Error("Choose a source build version for compilation. Public nightlies install from their matching download.");
  if (!pin || !/^[a-f0-9]{40}$/.test(pin.upstreamRevision || "")) throw new Error("Selected Butterscotch build has no immutable source revision.");
  if (sourceDir && !path.isAbsolute(sourceDir)) throw new Error("Butterscotch source checkout must be an absolute local path.");
  const source = sourceDir || resolveSourceRoot();
  const abortOptions = signal ? { signal } : {};
  // Source pin verification is required: this builder never fetches or edits the submodule.
  try { await run("/usr/bin/git", ["-C", source, "cat-file", "-e", `${pin.upstreamRevision}^{commit}`], { ...abortOptions, timeout: 10000 }); }
  catch { throw new Error("Selected Butterscotch commit is absent from the local checkout. Fetch that exact revision into a separate clean checkout and choose it as the build source."); }
  const dirty = await run("/usr/bin/git", ["-C", source, "status", "--porcelain", "--untracked-files=normal"], { ...abortOptions, timeout: 10000 });
  if (dirty.stdout.trim()) throw new Error("Butterscotch source has local modifications; the pinned builder requires unchanged source.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-butterscotch-build-"));
  try {
    logger?.info?.(`[butterscotch] building ${version} from ${pin.upstreamRevision}`);
    const snapshot = path.join(temporary, "source"), archive = path.join(temporary, "source.tar");
    fs.mkdirSync(snapshot);
    await run("/usr/bin/git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, pin.upstreamRevision], { ...abortOptions, timeout: 60000 });
    await run("/usr/bin/tar", ["-xf", archive, "-C", snapshot], { ...abortOptions, timeout: 60000 });
    fs.rmSync(archive);
    const overlay = pin.gameArguments === "repeat-game-arg-v1"
      ? require("../overlays/butterscotch-game-arguments").apply(snapshot) : null;
    const options = { ...abortOptions, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 };
    const cmake = findBuildTool("cmake");
    const maps = ["-ffile-prefix-map", "-fmacro-prefix-map", "-fdebug-prefix-map"].flatMap(option =>
      [`${option}=${temporary}=butterscotch-build`, `${option}=${snapshot}=butterscotch-source`]).join(" ");
    const configureOptions = ["-DBACKEND=appkit", "-DVIDEO_BACKEND=none", "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", `-DBUTTERSCOTCH_COMMIT_HASH=${pin.upstreamRevision}`,
      `-DCMAKE_C_FLAGS=${maps}`, `-DCMAKE_OBJC_FLAGS=${maps}`];
    await run(cmake, ["-S", snapshot, "-B", path.join(temporary, "build"), ...configureOptions], options);
    await run(cmake, ["--build", path.join(temporary, "build"), "--parallel", "2"], options);
    const destination = runtimeManager.core.getInstallDir({ userDataDir, version });
    fs.mkdirSync(destination, { recursive: true });
    const executablePath = path.join(destination, "butterscotch");
    fs.copyFileSync(path.join(temporary, "build", "butterscotch"), executablePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(executablePath, 0o755);
    try {
      const result = runtimeManager.core.registerLocal({ userDataDir, version, runtimePath: executablePath });
      // Registration records the hash; retain the stronger source-build evidence as well.
      const recordPath = path.join(destination, "runtime.json");
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      const metadataTemp = path.join(destination, `.runtime-build-${randomUUID()}.json`);
      try {
        fs.writeFileSync(metadataTemp, JSON.stringify({ ...record, sourceBuildVerified: true, provenanceVerified: true, backend: "appkit",
          renderer: "legacy-opengl", videoBackend: "none", deploymentTarget: "13.0",
          ...(overlay ? { gameArguments: pin.gameArguments, argumentOverlay: overlay } : {}),
          configureOptions: configureOptions.map(option => option.replaceAll(snapshot, "${SOURCE_ROOT}").replaceAll(temporary, "${BUILD_ROOT}")) }, null, 2) + "\n", { flag: "wx" });
        fs.renameSync(metadataTemp, recordPath);
      } finally { fs.rmSync(metadataTemp, { force: true }); }
      return { ...result, sourceBuildVerified: true, provenanceVerified: true, backend: "appkit" };
    } catch (error) {
      fs.rmSync(executablePath, { force: true });
      throw error;
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { manager, createManager, buildRuntime, resolveSourceRoot, mapCommit, discoverCatalog, discoverSourceCatalog };
