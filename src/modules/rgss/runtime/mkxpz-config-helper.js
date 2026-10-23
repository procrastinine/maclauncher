const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Bundled = require("../../shared/runtime/bundled-native");
const declarations = require("./distribution-supplementals.json");
const run = promisify(execFile);
const HELPER_VERSION = declarations.find(item => item.id === "mkxpz-config-helper")?.version;
const signatureCache = new Map();
let hostVersion;

function declaration(version = HELPER_VERSION) {
  const item = declarations.find(item => item.id === "mkxpz-config-helper" && item.version === version);
  if (!item) throw new Error("This MKXP-Z configuration helper version is unavailable.");
  return item;
}

async function resolveConfigHelper({ resourcesRoot, helperVersion = HELPER_VERSION, platform = process.platform, arch = process.arch, dependencies = {} } = {}) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) throw new Error("MKXP-Z config isolation requires an Apple Silicon or Intel Mac.");
  const pin = declaration(helperVersion);
  const roots = resourcesRoot ? [resourcesRoot] : [process.resourcesPath, path.resolve(__dirname, "../../../resources")];
  let directory;
  for (const root of roots.filter(value => typeof value === "string" && path.isAbsolute(value))) {
    const candidate = path.join(root, "native-runtimes", pin.directoryRelative);
    if (fs.existsSync(candidate)) { directory = fs.realpathSync(candidate); break; }
  }
  if (!directory) throw new Error("The included MKXP-Z configuration helper is missing. Reinstall MacLauncher.");
  const original = roots.find(root => typeof root === "string" && path.isAbsolute(root) && fs.existsSync(path.join(root, "native-runtimes", pin.directoryRelative)));
  const selected = path.join(fs.realpathSync(original), "native-runtimes", pin.directoryRelative);
  if (fs.lstatSync(selected).isSymbolicLink()) throw new Error("The included MKXP-Z config helper directory changed.");
  Bundled.verifyPayload(directory, pin);
  const record = JSON.parse(Bundled.readRegular(path.join(directory, pin.manifestRelative), Bundled.LIMITS.manifestBytes).bytes);
  const library = pin.files.find(file => file.path === "mkxpz-config.dylib"), dylibPath = path.join(directory, library.path);
  if (record.schemaVersion !== 1 || record.id !== pin.id || record.version !== pin.version || record.sourceSha256 !== pin.sourceSha256 ||
      record.binarySha256 !== library.sha256 || record.minimumMacOS !== pin.minimumMacOS ||
      record.scope !== (pin.version === "1.0.0" || pin.version.startsWith("config-identity-v7-") ? "selected-executable-config-and-display-identity" : "selected-executable-bundle-config-chdir") || record.build?.signing !== "ad-hoc" ||
      record.build?.installName !== "@rpath/mkxpz-config.dylib" ||
      JSON.stringify(record.architectures) !== JSON.stringify(library.architectures)) throw new Error("The MKXP-Z config helper build identity changed.");
  const systemVersion = dependencies.systemVersion ? await dependencies.systemVersion() : hostVersion ||= (await run("/usr/bin/sw_vers", ["-productVersion"], { timeout: 10000 })).stdout.trim();
  if (!Bundled.versionAtLeast(systemVersion, pin.minimumMacOS)) throw new Error(`MKXP-Z config isolation requires macOS ${pin.minimumMacOS}.`);
  const signatureKey = Bundled.fileIdentity(dylibPath);
  if (signatureCache.get(dylibPath) !== signatureKey) {
    await (dependencies.verifySignature || (file => run("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 30000, maxBuffer: 1024 * 1024 })))(dylibPath);
    if (signatureCache.size >= 16) signatureCache.delete(signatureCache.keys().next().value);
    signatureCache.set(dylibPath, signatureKey);
  }
  return Object.freeze({ version: pin.version, directory, dylibPath, sourceSha256: pin.sourceSha256,
    binarySha256: library.sha256, manifestSha256: pin.manifestSha256, minimumMacOS: pin.minimumMacOS,
    architectures: Object.freeze([...library.architectures]), shared: true });
}

function validateInjectionSignature(output) {
  const match = String(output).match(/flags=0x([a-f0-9]+)/i);
  if (!match) throw new Error("The selected MKXP-Z executable has no readable code-signature policy.");
  const flags = parseInt(match[1], 16);
  const entitlement = name => new RegExp(`<key>\\s*${name.replace(/\./g, "\\.")}\\s*</key>\\s*<true\\s*/>`, "i").test(output);
  if (flags & 0x800 || flags & 0x2000 && !entitlement("com.apple.security.cs.disable-library-validation") ||
      flags & 0x10000 && !(entitlement("com.apple.security.cs.allow-dyld-environment-variables") && entitlement("com.apple.security.cs.disable-library-validation"))) {
    throw new Error("This selected MKXP-Z build blocks the shared config helper through its signing policy. Choose an injection-compatible MKXP-Z version in Runtimes.");
  }
  return { flags, injectionCompatible: true };
}

async function assertInjectionCompatible(executablePath, { inspectSignature } = {}) {
  const inspect = inspectSignature || (async file => {
    const result = await run("/usr/bin/codesign", ["--display", "--verbose=4", "--entitlements", ":-", file], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return result.stdout + "\n" + result.stderr;
  });
  try { return validateInjectionSignature(await inspect(executablePath)); }
  catch (error) {
    if (error.code || error.killed) throw new Error("Cannot inspect the selected MKXP-Z signing policy. Choose a valid signed runtime in Runtimes.");
    throw error;
  }
}

function launchEnvironment({ prepared, helper, gameName, gameIcon, environment = process.env }) {
  const env = { ...environment };
  for (const name of Object.keys(env)) if (name.startsWith("MACLAUNCHER_MKXPZ_CONFIG_") || name.startsWith("MACLAUNCHER_MKXP_CONFIG_")) delete env[name];
  const ownHelper = file => path.basename(file) === "mkxpz-config.dylib" || file.includes("/mkxpz-config-helper/");
  const injected = String(env.DYLD_INSERT_LIBRARIES || "").split(":").filter(file => file && !ownHelper(file));
  env.DYLD_INSERT_LIBRARIES = [...new Set([helper.dylibPath, ...injected])].join(":");
  env.MACLAUNCHER_MKXPZ_CONFIG_EXECUTABLE = prepared.executablePath;
  env.MACLAUNCHER_MKXPZ_CONFIG_SOURCE = prepared.sourceConfigDir;
  env.MACLAUNCHER_MKXPZ_CONFIG_TARGET = prepared.configDir;
  // This label is scoped to the already guarded child, never its parent.
  if (typeof gameName === "string" && gameName.trim() && !gameName.includes("\0") && Buffer.byteLength(gameName, "utf8") <= 1024) {
    env.MACLAUNCHER_MKXPZ_CONFIG_GAME_NAME = gameName.trim();
    env.SDL_APP_NAME = gameName.trim();
  }
  if (typeof gameIcon === "string" && path.isAbsolute(gameIcon) && !gameIcon.includes("\0")) {
    try {
      const icon = fs.realpathSync(gameIcon), stat = fs.lstatSync(icon);
      if (stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024) env.MACLAUNCHER_MKXPZ_CONFIG_GAME_ICON = icon;
    } catch {} // Optional display identity cannot block ordinary Play.
  }
  return env;
}

module.exports = { HELPER_VERSION, declaration, resolveConfigHelper, validateInjectionSignature, assertInjectionCompatible, launchEnvironment };
