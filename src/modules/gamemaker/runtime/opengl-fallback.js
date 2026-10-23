const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("../../shared/runtime/local-native");

const execFileAsync = promisify(execFile);
const HELPER_BUILDS = Object.freeze(require("./opengl-helper-versions.json"));
const HELPER_VERSION = HELPER_BUILDS[0].version;
const SOURCE_SHA256 = HELPER_BUILDS[0].sourceSha256;
const TESTED_VENDOR_SHA256 = "d63b5d5152d427b333b64883c26edc6701214d0a5ad027fa6f09e579fa31c1b0";
const TESTED_VENDOR_BUILDS = Object.freeze({ "2026.0.0.23": TESTED_VENDOR_SHA256,
  "2024.13.1.242": "4871c81c7425b18cb8aa0650c82019f75dde504ca2d1d7e61d14aa5f1e874ffe",
  "2.3.7.476": "50916940fb11afe911f1bb11b24be075c8b616d5afae10b933c407bf618e1fbb",
  "1.4.9999": "dd8395d9dcdb5eb6e58641a730b22640d1909e72a55a48c3450cf6d0231040fa",
  "2.2.5.378": "054debab706e5fd42ce73df6c4739ce86c31804e00e039b9e78c16dfaffc265a" });
const SUPPORTED_RUNNER_VERSIONS = Object.freeze(Object.keys(TESTED_VENDOR_BUILDS));
const SOURCE_PATH = path.resolve(__dirname, "../overlays", HELPER_BUILDS[0].sourceFile);
const BUNDLED_MANIFEST_SHA256 = HELPER_BUILDS[0].manifestSha256;
const BUNDLED_BINARY_SHA256 = HELPER_BUILDS[0].binarySha256;
const BUNDLED_RELATIVE = path.join("native-runtimes", "gamemaker-opengl-helper", HELPER_VERSION, "universal");
const building = new Set();

function helperBuild(helperVersion = HELPER_VERSION) {
  const pin = HELPER_BUILDS.find(item => item.version === helperVersion);
  if (!pin) throw new Error("Choose a listed graphics helper version.");
  return pin;
}
function installDirectory(userDataDir, helperVersion = HELPER_VERSION) {
  helperBuild(helperVersion);
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir) || userDataDir.includes("\0")) {
    throw new Error("An absolute launcher data directory is required for the OpenGL helper.");
  }
  return path.join(userDataDir, "runtimes", "gamemaker-opengl-helper", helperVersion);
}
function checkHost() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("The software OpenGL helper requires an Apple Silicon or Intel Mac.");
  }
}
function sourceIdentity(helperVersion = HELPER_VERSION) {
  const pin = helperBuild(helperVersion);
  const digest = Native.hashFile(path.resolve(__dirname, "../overlays", pin.sourceFile));
  if (digest !== pin.sourceSha256) throw new Error("The OpenGL helper source checksum does not match the selected version.");
  return digest;
}

function getBundledFallbackStatus({ resourcesRoot, helperVersion = HELPER_VERSION } = {}) {
  const pin = helperBuild(helperVersion);
  const roots = resourcesRoot ? [resourcesRoot] : [process.resourcesPath, path.resolve(__dirname, "../../../resources")];
  for (const root of roots.filter(value => typeof value === "string" && path.isAbsolute(value))) {
    const directory = path.join(root, "native-runtimes", "gamemaker-opengl-helper", helperVersion, "universal");
    if (!fs.existsSync(directory)) continue;
    try {
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Bundled graphics helper directory changed.");
      const names = ["helper.json", "software-opengl.dylib", "software-opengl.m", "license.txt"];
      for (const name of names) {
        const stat = fs.lstatSync(path.join(directory, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Bundled graphics helper contains an invalid file.");
      }
      if (Native.hashFile(path.join(directory, "helper.json")) !== pin.manifestSha256) throw new Error("Bundled graphics helper manifest changed.");
      const record = JSON.parse(fs.readFileSync(path.join(directory, "helper.json"), "utf8"));
      const dylibPath = path.join(directory, "software-opengl.dylib");
      if (record.version !== helperVersion || record.sourceSha256 !== pin.sourceSha256 || record.binarySha256 !== pin.binarySha256 ||
        Native.hashFile(dylibPath) !== pin.binarySha256 || Native.hashFile(path.join(directory, "software-opengl.m")) !== pin.sourceSha256 ||
        Native.hashFile(path.join(directory, "license.txt")) !== record.licenseSha256 ||
        !["arm64", "x86_64"].every(architecture => Native.readMachOArchitectures(dylibPath, { allowLibrary: true }).includes(architecture))) {
        throw new Error("Bundled graphics helper identity or architecture changed.");
      }
      return { ...record, ready: true, bundled: true, directory, dylibPath, names, reason: null };
    } catch (error) { return { ready: false, present: true, reason: error.message }; }
  }
  return { ready: false, present: false, reason: "This app does not include the graphics helper." };
}

/** Play may install the small reviewed helper offline; end users need no compiler. */
async function installBundledFallback({ userDataDir, resourcesRoot, helperVersion = HELPER_VERSION } = {}) {
  const pin = helperBuild(helperVersion);
  checkHost();
  const existing = getFallbackStatus({ userDataDir, helperVersion });
  if (existing.ready) return existing;
  const bundled = getBundledFallbackStatus({ resourcesRoot, helperVersion });
  if (!bundled.ready) throw new Error(bundled.reason);
  const directory = installDirectory(userDataDir, helperVersion), parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true });
  const lock = directory + ".installing";
  let acquired = false;
  // Workers for different games can ask for the same global helper concurrently.
  for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
    try { fs.mkdirSync(lock); acquired = true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const installed = getFallbackStatus({ userDataDir, helperVersion });
      if (installed.ready) return installed;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new Error("The graphics helper installation did not finish. Try Play again.");
  let staging, previous, published = false;
  try {
    const installed = getFallbackStatus({ userDataDir, helperVersion });
    if (installed.ready) return installed;
    staging = fs.mkdtempSync(path.join(parent, ".install-"));
    for (const name of bundled.names) fs.copyFileSync(path.join(bundled.directory, name), path.join(staging, name));
    if (!getBundledFallbackStatus({ resourcesRoot, helperVersion }).ready || Native.hashFile(path.join(staging, "software-opengl.dylib")) !== pin.binarySha256) {
      throw new Error("Bundled graphics helper changed during installation.");
    }
    if (fs.existsSync(directory)) {
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Graphics helper installation is not an owned directory.");
      previous = directory + ".previous-" + randomUUID(); fs.renameSync(directory, previous);
    }
    fs.renameSync(staging, directory); published = true;
    const status = getFallbackStatus({ userDataDir, helperVersion });
    if (!status.ready) throw new Error(status.reason);
    return { ...status, installedFromBundle: true };
  } catch (error) {
    if (published) fs.rmSync(directory, { recursive: true, force: true });
    if (previous && !fs.existsSync(directory)) { fs.renameSync(previous, directory); previous = null; }
    throw error;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    if (previous) fs.rmSync(previous, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
function getFallbackStatus({ userDataDir, helperVersion = HELPER_VERSION } = {}) {
  const pin = helperBuild(helperVersion);
  try {
    checkHost();
    const directory = installDirectory(userDataDir, helperVersion);
    const record = JSON.parse(fs.readFileSync(path.join(directory, "helper.json"), "utf8"));
    if (record.version !== helperVersion || record.sourceSha256 !== sourceIdentity(helperVersion) || record.architecture !== "universal" ||
      record.testedVendorSha256 !== TESTED_VENDOR_SHA256 ||
      !Array.isArray(record.supportedRunnerVersions) || !record.supportedRunnerVersions.length ||
      record.supportedRunnerVersions.some(version => !SUPPORTED_RUNNER_VERSIONS.includes(version)) ||
      !/^[a-f0-9]{64}$/.test(record.binarySha256 || "")) {
      throw new Error("The OpenGL helper build record does not match its pinned source/version.");
    }
    const dylibPath = path.join(directory, "software-opengl.dylib");
    const architectures = Native.readMachOArchitectures(dylibPath, { allowLibrary: true });
    if (Native.hashFile(dylibPath) !== record.binarySha256 || !["arm64", "x86_64"].every(arch => architectures.includes(arch))) {
      throw new Error("The OpenGL helper library changed or has an incompatible architecture. Build the helper again.");
    }
    return { ...record, supportedRunnerVersions: [...SUPPORTED_RUNNER_VERSIONS], ready: true, dylibPath, installDir: directory, reason: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    const included = missing && getBundledFallbackStatus({ helperVersion }).ready;
    return { ready: false, version: helperVersion, sourceSha256: pin.sourceSha256,
      supportedRunnerVersions: [...SUPPORTED_RUNNER_VERSIONS], reason: missing
        ? included ? "The graphics helper can be installed from this app."
          : "The selected graphics helper is unavailable. Butterscotch supports compatible VM games."
        : error.message };
  }
}

// The caller owns a private, ad-hoc-signed runner stage. Never apply this
// environment to the installed vendor binary or the launcher process itself.
function resolveFallback({ userDataDir, runnerVersion, runnerSha256, helperVersion = HELPER_VERSION } = {}) {
  const pin = helperBuild(helperVersion);
  if (!SUPPORTED_RUNNER_VERSIONS.includes(runnerVersion)) {
    return { ready: false, version: helperVersion,
      reason: `Software OpenGL supports only official runners ${SUPPORTED_RUNNER_VERSIONS.join(", ")}.` };
  }
  if (runnerSha256 !== TESTED_VENDOR_BUILDS[runnerVersion]) {
    return { ready: false, version: helperVersion,
      reason: "The official runner checksum does not match this software OpenGL helper." };
  }
  const status = getFallbackStatus({ userDataDir, helperVersion });
  if (!status.ready) return status;
  return { ...status, environment: {
    DYLD_INSERT_LIBRARIES: status.dylibPath,
    MACLAUNCHER_ALLOW_SOFTWARE_OPENGL: "1",
    MACLAUNCHER_LEGACY_LOGICAL_OPENGL: pin.legacyLogicalRunnerVersions.includes(runnerVersion) ? "1" : "0"
  } };
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, { timeout: 120000, maxBuffer: 1024 * 1024, ...options });
  } catch (error) {
    if (error.code === "ENOENT" || /developer directory|xcode-select|invalid active developer/i.test(error.stderr || error.message)) {
      throw new Error("Apple Command Line Tools are required. Follow docs/runtimes/NATIVE_TOOL_SETUP.md, then build the OpenGL helper again.");
    }
    throw new Error(`OpenGL helper build failed: ${error.stderr || error.message}`);
  }
}

async function buildFallback({ userDataDir, logger, helperVersion = HELPER_VERSION } = {}) {
  const pin = helperBuild(helperVersion);
  checkHost();
  const sourceSha256 = sourceIdentity(helperVersion);
  const directory = installDirectory(userDataDir, helperVersion);
  const existing = getFallbackStatus({ userDataDir, helperVersion });
  if (existing.ready) return { ...existing, alreadyBuilt: true };
  if (building.has(directory)) throw new Error("The software OpenGL helper is already building.");
  building.add(directory);
  let staging = null;
  let previousDirectory = null;
  let published = false;
  try {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    staging = fs.mkdtempSync(path.join(path.dirname(directory), ".build-"));
    // Copy the pinned module source to a real file so native clang also works
    // when module code/resources are read through Electron's asar filesystem.
    const source = path.join(staging, "software-opengl.m");
    fs.writeFileSync(source, fs.readFileSync(path.resolve(__dirname, "../overlays", pin.sourceFile)));
    const dylibPath = path.join(staging, "software-opengl.dylib");
    const compilerArgs = ["-dynamiclib", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0", "-Wno-deprecated-declarations",
      ...(["software-gl-v2-universal", "software-gl-v3-universal", "software-gl-v4-universal", "software-gl-v5-universal"].includes(helperVersion) ? ["-install_name", "@rpath/software-opengl.dylib"] : []),
      "-framework", "AppKit", source, "-o", dylibPath];
    logger?.info?.(`[runtime] build OpenGL helper ${helperVersion}`);
    const compiler = await run("/usr/bin/clang", ["--version"]);
    await run("/usr/bin/clang", compilerArgs);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", dylibPath]);
    const binarySha256 = Native.hashFile(dylibPath);
    if (!["arm64", "x86_64"].every(arch => Native.readMachOArchitectures(dylibPath, { allowLibrary: true }).includes(arch))) throw new Error("Built OpenGL helper lacks an ARM64 or Intel library slice.");
    if (Native.hashFile(source) !== sourceSha256 || sourceIdentity(helperVersion) !== sourceSha256) {
      throw new Error("The pinned OpenGL helper source changed during its build.");
    }
    const record = { version: helperVersion, sourceSha256, binarySha256, architecture: "universal",
      supportedRunnerVersions: [...SUPPORTED_RUNNER_VERSIONS], testedVendorSha256: TESTED_VENDOR_SHA256,
      compiler: compiler.stdout.split("\n")[0], compilerArgs: compilerArgs.slice(0, -3), builtAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, "helper.json"), JSON.stringify(record, null, 2) + "\n");
    if (fs.existsSync(directory)) {
      previousDirectory = directory + ".previous-" + randomUUID();
      fs.renameSync(directory, previousDirectory);
    }
    fs.renameSync(staging, directory);
    published = true;
    const status = getFallbackStatus({ userDataDir, helperVersion });
    if (!status.ready) throw new Error(status.reason);
    return status;
  } catch (error) {
    if (published) fs.rmSync(directory, { recursive: true, force: true });
    if (previousDirectory && !fs.existsSync(directory)) {
      fs.renameSync(previousDirectory, directory);
      previousDirectory = null;
    }
    throw error;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    if (previousDirectory) fs.rmSync(previousDirectory, { recursive: true, force: true });
    building.delete(directory);
  }
}

module.exports = { buildFallback, getFallbackStatus, resolveFallback, getBundledFallbackStatus, installBundledFallback,
  HELPER_VERSION, HELPER_BUILDS, SOURCE_SHA256, SUPPORTED_RUNNER_VERSIONS, TESTED_VENDOR_SHA256, TESTED_VENDOR_BUILDS,
  BUNDLED_MANIFEST_SHA256, BUNDLED_BINARY_SHA256,
  __test: { installDirectory, sourceIdentity, SOURCE_PATH, BUNDLED_RELATIVE } };
