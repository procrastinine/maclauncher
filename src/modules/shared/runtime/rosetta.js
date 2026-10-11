const fs = require("node:fs");
const { execFile: nodeExecFile, spawnSync: nodeSpawnSync } = require("node:child_process");
const { readMachOArchitectures } = require("./local-native");
const { createAbortError, isAbortError, throwIfAborted } = require("./download-utils");

const PACKAGE_ID = "com.apple.pkg.RosettaUpdateAuto";
const RUNTIME_PATH = "/Library/Apple/usr/libexec/oah/libRosettaRuntime";
const INSTALL_LOCATION = "/Library/Apple/";
const SYSTEM_VERSION_PATH = "/System/Library/CoreServices/SystemVersion.plist";
const LICENSE_URL = "https://www.apple.com/legal/sla/";
const SUPPORT_URL = "https://support.apple.com/en-us/102527";
const SOFTWAREUPDATE = "/usr/sbin/softwareupdate";
const INSTALL_ARGS = ["--install-rosetta", "--agree-to-license"];
const MANUAL_INSTRUCTION = "Open Terminal in Applications → Utilities (/System/Applications/Utilities/Terminal.app) and run /usr/sbin/softwareupdate --install-rosetta, then follow Apple's license and authorization prompts. macOS installs Rosetta under /Library/Apple/.";

function systemEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DYLD_")));
  return { ...env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
}

function parseSystemVersion(text) {
  const read = key => String(text || "").match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]?.trim() || null;
  return { systemVersion: read("ProductVersion"), systemBuild: read("ProductBuildVersion") };
}

function parsePackageInfo(text) {
  const read = key => String(text || "").match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() || null;
  if (read("package-id") !== PACKAGE_ID) return { packageId: null, version: null, installedAt: null };
  const seconds = Number(read("install-time"));
  const date = new Date(seconds * 1000);
  return { packageId: PACKAGE_ID, version: read("version"),
    installedAt: seconds > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null };
}

function prerequisitePlan(status) {
  return { kind: "prerequisite", prerequisiteId: "rosetta", managerId: "rosetta", label: "Rosetta",
    version: status.version || null, systemVersion: status.systemVersion, systemBuild: status.systemBuild,
    requiresDownload: true, licenseRequired: true, licenseUrl: LICENSE_URL, sourceUrl: SUPPORT_URL,
    confirmLabel: "Agree and Install", installLocation: INSTALL_LOCATION,
    detail: "Required to run this Intel runtime. Installation requires acceptance of Apple's software license.",
    manualInstruction: MANUAL_INSTRUCTION };
}

function requiredError(status, code = "ROSETTA_REQUIRED", detail = "Rosetta is required to run this Intel runtime.", cause) {
  return Object.assign(new Error(`${detail} ${MANUAL_INSTRUCTION}`, cause ? { cause } : undefined), {
    code, prerequisite: prerequisitePlan(status), installLocation: INSTALL_LOCATION
  });
}

// Only Apple's installer is invoked, and only after the service receives explicit
// license acceptance. An authorization fallback uses macOS's own password dialog;
// credentials never pass through Node or launcher settings.
function createAppleInstaller({ execFile = nodeExecFile } = {}) {
  const execute = (command, args, context) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", maxBuffer: 256 * 1024,
      timeout: 10 * 60 * 1000, env: systemEnvironment(), ...(context.signal ? { signal: context.signal } : {}) },
    (error, stdout, stderr) => {
      if (error) {
        error.installerOutput = `${stdout || ""}\n${stderr || ""}`.trim().slice(-2000);
        reject(error);
      } else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
  return async context => {
    if (context.licenseAccepted !== true) throw new Error("Apple's Rosetta license has not been accepted.");
    try { return await execute(SOFTWAREUPDATE, INSTALL_ARGS, context); }
    catch (error) {
      if (isAbortError(error) || context.signal?.aborted) throw error;
      if (context.allowAuthorization === false || !/\b(root|administrator|authorization|authentication|permission denied)\b/i.test(error.installerOutput || "")) throw error;
      context.onProgress?.({ phase: "authorize", label: "Authorize Rosetta installation" });
      try {
        return await execute("/usr/bin/osascript", ["-e",
          'do shell script "/usr/sbin/softwareupdate --install-rosetta --agree-to-license" with administrator privileges'], context);
      } catch (authorizationError) {
        if (/\(-128\)|user cancelle?d/i.test(authorizationError.installerOutput || "")) throw createAbortError("Rosetta authorization canceled.");
        throw authorizationError;
      }
    }
  };
}

function createRosettaService({ platform = process.platform, arch = process.arch, fileSystem = fs,
  spawnSync = nodeSpawnSync, readArchitectures = readMachOArchitectures, runInstaller = createAppleInstaller(),
  now = Date.now } = {}) {
  let cached = null, checkedAt = 0, pending = null;
  const required = platform === "darwin" && arch === "arm64";
  function readSystem() {
    try {
      const content = fileSystem.readFileSync(SYSTEM_VERSION_PATH);
      return content.length <= 64 * 1024 ? parseSystemVersion(content.toString("utf8")) : { systemVersion: null, systemBuild: null };
    } catch { return { systemVersion: null, systemBuild: null }; }
  }
  function getStatus({ force = false, includeVersion = true, verify = false } = {}) {
    if (!required) return { required: false, available: true, installed: false, version: null, packageId: null,
      installedAt: null, systemVersion: null, systemBuild: null, source: "not-required", installLocation: INSTALL_LOCATION };
    if (!force && !verify && cached && (cached.available || now() - checkedAt < 2000) && (!includeVersion || cached.versionChecked)) return { ...cached };
    if (!force && !verify && cached?.available) {
      // Add package evidence lazily; warm launch checks never fork pkgutil again.
      const info = readPackage();
      cached = { ...cached, ...info, versionChecked: true };
      return { ...cached };
    }
    let present = false;
    try { present = fileSystem.statSync(RUNTIME_PATH).isFile(); } catch {}
    let available = present, source = present ? "system-runtime" : "missing";
    if (verify || !present) {
      try {
        const result = spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], {
          stdio: "ignore", timeout: 3000, env: systemEnvironment()
        });
        available = result.status === 0 && !result.error;
        source = available ? "system-translation-probe" : "missing";
      } catch { available = false; source = "missing"; }
    }
    cached = { required: true, available, installed: available, source, ...readSystem(),
      packageId: null, version: null, installedAt: null, installLocation: INSTALL_LOCATION,
      runtimePath: present ? RUNTIME_PATH : null, versionChecked: !available || includeVersion,
      ...(available && includeVersion ? readPackage() : {}) };
    checkedAt = now();
    return { ...cached };
  }
  function readPackage() {
    try {
      const result = spawnSync("/usr/sbin/pkgutil", ["--pkg-info", PACKAGE_ID], {
        encoding: "utf8", maxBuffer: 64 * 1024, timeout: 3000, env: systemEnvironment()
      });
      if (result.status === 0 && !result.error) return parsePackageInfo(result.stdout);
    } catch {}
    return { packageId: null, version: null, installedAt: null };
  }
  function isAvailable(options = {}) { return getStatus({ ...options, includeVersion: false }).available; }
  function requiresForExecutable(executable, { forceIntel = false } = {}) {
    if (!required) return false;
    if (forceIntel) return true;
    try { const architectures = readArchitectures(executable); return architectures.includes("x86_64") && !architectures.includes("arm64"); }
    catch { return false; }
  }
  function createRequiredError() { return requiredError(getStatus()); }
  async function ensure(context = {}) {
    throwIfAborted(context.signal);
    if (isAvailable()) return getStatus();
    if (pending) return pending;
    pending = (async () => {
      const status = getStatus(), plan = prerequisitePlan(status);
      if (typeof context.confirmRuntimeInstall !== "function") throw requiredError(status);
      const consent = await context.confirmRuntimeInstall(plan);
      throwIfAborted(context.signal);
      if (!consent || consent?.approved === false) throw createAbortError("Rosetta installation canceled.");
      const licensed = consent?.approved === true && consent.licenseAccepted === true || consent === true && context.licenseAccepted === true;
      if (!licensed) throw requiredError(status, "ROSETTA_LICENSE_REQUIRED", "Apple's Rosetta license must be accepted before installation.");
      // Another app may have completed installation while consent was open.
      if (getStatus({ force: true, includeVersion: false }).available) return getStatus();
      context.onProgress?.({ phase: "install", label: "Installing Rosetta…", prerequisiteId: "rosetta" });
      try {
        await runInstaller({ ...context, licenseAccepted: true, plan });
        throwIfAborted(context.signal);
        const installed = getStatus({ force: true, verify: true });
        if (!installed.available) throw new Error("Apple's installer did not make Intel translation available.");
        context.logger?.info?.(`[runtime] Rosetta ${installed.version || "system component"} on macOS ${installed.systemVersion || "unknown"} (${installed.systemBuild || "unknown"})`);
        return installed;
      } catch (error) {
        if (isAbortError(error) || context.signal?.aborted) throw createAbortError("Rosetta installation canceled.");
        throw requiredError(status, "ROSETTA_INSTALL_FAILED", `Rosetta installation failed: ${error.installerOutput || error.message}`, error);
      }
    })();
    try { return await pending; }
    finally { pending = null; }
  }
  async function ensureForExecutable(executable, context = {}, options = {}) {
    return requiresForExecutable(executable, options) ? ensure(context) : null;
  }
  return { getStatus, isAvailable, requiresForExecutable, createRequiredError, ensure, ensureForExecutable,
    clearCache: () => { cached = null; checkedAt = 0; } };
}

module.exports = { createRosettaService, createAppleInstaller, parsePackageInfo, parseSystemVersion, prerequisitePlan,
  PACKAGE_ID, RUNTIME_PATH, INSTALL_LOCATION, LICENSE_URL, SUPPORT_URL, ...createRosettaService() };
