const fs = require("node:fs");
const path = require("node:path");
const Host = require("../../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");
const { readPlistFile } = require("../../../shared/runtime/app-bundle");
const Shared = require("../../sources/wine-payload");

// The release archive holds one Libraries folder: the Wine tree in Wine, and
// the DXVK and DXMT Windows libraries beside it.
const ROOT = "Libraries", WINE = `${ROOT}/Wine`, LABEL = "WineCX";
const REQUIRED = [`${WINE}/bin/wineserver`, `${WINE}/lib/wine/x86_64-unix/wine`, `${WINE}/lib/wine/x86_64-unix/ntdll.so`, `${WINE}/lib/wine/x86_64-unix/winemac.so`];
const isTree = directory => fs.existsSync(path.join(directory, "Wine", "bin", "wineserver")) && fs.existsSync(path.join(directory, "Wine", "lib", "wine"));
// A package that wraps the Libraries folder in another directory is found by
// its Wine tree; the known path wins.
function findRoot(unpacked) {
  const known = path.join(unpacked, ROOT), found = [];
  if (isTree(known)) return known;
  (function visit(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
      const child = path.join(directory, entry.name);
      if (isTree(child)) found.push(child); else if (depth < 3) visit(child, depth + 1);
    }
  })(unpacked, 0);
  if (found.length !== 1) throw new Error("The WineCX download contains no complete Wine tree. No runtime was installed.");
  return found[0];
}
// The runtime's own version file: its release version and the translator
// versions it was packaged with.
function readVersionFile(root) {
  const file = path.join(root, "WhiskyWineVersion.plist");
  if (!fs.existsSync(file)) return {};
  const plist = readPlistFile(file) || {}, version = plist.version || {};
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const parts = [number(version.major), number(version.minor), number(version.patch)];
  return { ...(parts.every(part => part !== null) ? { runtimeVersion: parts.join(".") } : {}),
    ...(plist.gptkCapable === true ? { gptkCapable: true } : {}),
    componentVersions: Object.fromEntries([["dxvk", plist.dxvkVersion], ["dxmt", plist.dxmtVersion]]
      .filter(([, value]) => typeof value === "string" && /^[\w.+-]{1,64}$/.test(value))) };
}
async function preparePayload({ unpacked, pin, signal, onProgress }, dependencies = {}) {
  throwIfAborted(signal);
  const root = findRoot(unpacked);
  if (root !== path.join(unpacked, ROOT)) await fs.promises.rename(root, path.join(unpacked, ROOT));
  for (const entry of fs.readdirSync(unpacked)) if (entry !== ROOT) await fs.promises.rm(path.join(unpacked, entry), { recursive: true, force: true });
  onProgress?.({ downloaded: pin?.downloadBytes || 0, total: pin?.downloadBytes || 0, detail: `${pin?.versionLabel || LABEL} · Checking installed files…` });
  const records = Shared.walk(unpacked, signal, LABEL);
  const native = Shared.inspectClosure(unpacked, records, signal, { label: LABEL, required: REQUIRED, executableRoot: path.join(unpacked, WINE, "bin") });
  const hostVersion = (dependencies.systemVersionSync || Host.systemVersionSync)();
  if (!Host.versionAtLeast(hostVersion, native.minimumMacOS)) throw new Error(Shared.requiresMacOS(native.minimumMacOS));
  const versions = readVersionFile(path.join(unpacked, ROOT)), wineRoot = path.join(unpacked, WINE);
  const inventory = await Shared.writeInventory(unpacked, records, signal, LABEL);
  return { schemaVersion: 1, root: ROOT, wineRoot: WINE, inventory, minimumMacOS: native.minimumMacOS, architectures: native.architectures,
    nativeComponents: native.nativeComponents, capabilities: Shared.wineCapabilities(wineRoot), wineVersion: Shared.wineVersion(wineRoot), ...versions };
}
function createPayloadResolver({ systemVersionSync = Host.systemVersionSync } = {}) {
  const check = Shared.createInventoryCheck({ label: LABEL, systemVersionSync }), important = new Set(REQUIRED);
  return function resolvePayload(install, { verification = "full", signal } = {}) {
    if (!install) return { install: null, reason: "WineCX is not installed." };
    try {
      throwIfAborted(signal);
      const evidence = install.installationMetadata;
      if (evidence?.schemaVersion !== 1 || evidence.root !== ROOT || evidence.wineRoot !== WINE)
        throw new Error("WineCX registration is incomplete. Remove and install this version again.");
      const supported = check(install.installDir, evidence.inventory, { verification, signal, important, minimumMacOS: evidence.minimumMacOS });
      if (!supported.supported) return { install: null, reason: supported.reason, minimumMacOS: evidence.minimumMacOS };
      const librariesRoot = path.join(install.installDir, ROOT), wineRoot = path.join(install.installDir, WINE);
      return { install: { ...install, librariesRoot, wineRoot, engineRoot: wineRoot,
        executablePath: path.join(wineRoot, "bin", "wine"), serverPath: path.join(wineRoot, "bin", "wineserver"),
        libraryRoot: path.join(wineRoot, "lib"), capabilities: evidence.capabilities, minimumMacOS: evidence.minimumMacOS,
        wineVersion: evidence.wineVersion || "", engineVersion: evidence.wineVersion || install.version,
        componentVersions: evidence.componentVersions || {}, gptkCapable: evidence.gptkCapable === true },
        reason: null, minimumMacOS: evidence.minimumMacOS };
    } catch (error) { if (error.name === "AbortError") throw error; return { install: null, reason: error.message }; }
  };
}

module.exports = { ROOT, WINE, REQUIRED, findRoot, readVersionFile, preparePayload, createPayloadResolver };
