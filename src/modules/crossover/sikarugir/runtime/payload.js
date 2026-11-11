const fs = require("node:fs");
const path = require("node:path");
const Shared = require("../../sources/wine-payload");
const Host = require("../../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");
const Upstream = require("../../../shared/runtime/upstream");
const { extractArchive } = require("./archive");
const Catalog = require("./catalog");

const WINE_ROOT = "wswine.bundle", SUPPORT_ROOT = "support", { INVENTORY } = Shared;
const LABEL = "Sikarugir";
const walk = (root, signal) => Shared.walk(root, signal, LABEL);
const later = Shared.later;
function regularFile(root, relative) { return Shared.regularFile(root, relative, LABEL); }
// Template renderers and KosmicKrisp are checked by their own consumers.
function inspectClosure(root, records, signal) {
  return Shared.inspectClosure(root, records, signal, { label: LABEL, executableRoot: path.resolve(root, WINE_ROOT, "bin"),
    skip: relative => relative.startsWith(`${SUPPORT_ROOT}/Frameworks/renderer/`) || relative === `${SUPPORT_ROOT}/Frameworks/libvulkan_kosmickrisp.dylib`,
    required: [`${WINE_ROOT}/bin/wine`, `${WINE_ROOT}/bin/wineserver`, `${WINE_ROOT}/lib/wine/x86_64-unix/ntdll.so`, `${WINE_ROOT}/lib/wine/x86_64-unix/winemac.so`] });
}
// Engines unpack to wswine.bundle. A package that moves the bundle deeper or
// renames it is found by its Wine loader and server; the known path wins.
function findWineRoot(root) {
  const wine = directory => ["wine", "wineserver"].every(name => fs.existsSync(path.join(directory, "bin", name)));
  const known = path.join(root, WINE_ROOT), found = [];
  if (wine(known)) return known;
  (function visit(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
      const child = path.join(directory, entry.name);
      if (wine(child)) found.push(child); else if (depth < 3) visit(child, depth + 1);
    }
  })(root, 0);
  return found.length === 1 ? found[0] : known;
}
const hashAsync = (file, signal) => Shared.hashAsync(file, signal, LABEL);
async function preparePayload({ unpacked, pin, signal, logger, onProgress }, dependencies = {}) {
  throwIfAborted(signal);
  const template = pin.template;
  if (!Catalog.validateEntry(pin))
    throw new Error("The selected Wine download names no matching support archive. Reload versions and install it again.");
  const wineRoot = findWineRoot(unpacked);
  if (wineRoot !== path.join(unpacked, WINE_ROOT)) await fs.promises.rename(wineRoot, path.join(unpacked, WINE_ROOT));
  const scratch = await fs.promises.mkdtemp(path.join(path.dirname(unpacked), ".support-"));
  const stageProgress = (detail, downloaded = pin.downloadBytes) => onProgress?.({
    downloaded, total: pin.downloadBytes, detail: `${pin.versionLabel} · ${detail}`
  });
  let graphics, archiveSha256;
  try {
    const archive = path.join(scratch, template.asset.filename);
    logger?.info?.(`[sikarugir] acquiring support ${template.version}`);
    stageProgress("Downloading support libraries…", pin.asset.bytes || 0);
    // The publisher's size and digest verify the support archive when it lists them.
    archiveSha256 = (await Catalog.templates.download(Upstream.listedFile(template.asset), archive, { signal,
      onProgress: progress => onProgress?.({ ...progress, downloaded: (pin.asset.bytes || 0) + progress.downloaded,
        total: pin.downloadBytes, detail: `${pin.versionLabel} · Downloading support libraries…` }) })).sha256;
    throwIfAborted(signal);
    const templateUnpacked = path.join(scratch, "unpacked"); await fs.promises.mkdir(templateUnpacked);
    stageProgress("Extracting support libraries…");
    await (dependencies.extractArchive || extractArchive)(archive, templateUnpacked, signal);
    const templateRoot = require("../graphics/closure").templateContents(templateUnpacked, template.version);
    stageProgress("Preparing graphics libraries…");
    graphics = await (dependencies.stageTemplateClosure || require("../graphics").stageTemplateClosure)({
      templateRoot, templateVersion: template.version, destinationRoot: path.join(unpacked, SUPPORT_ROOT), signal });
  } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
  throwIfAborted(signal);
  if (Host.versionAtLeast(template.version, "1.0.24") && !graphics?.relativePaths?.templateRenderers)
    throw new Error("Sikarugir support libraries are incomplete. No runtime was installed.");
  stageProgress("Checking installed files…");
  const records = walk(unpacked, signal), native = inspectClosure(unpacked, records, signal);
  const minimumMacOS = later(native.minimumMacOS, graphics.minimumBaseMacOS || native.minimumMacOS);
  const hostVersion = (dependencies.systemVersionSync || Host.systemVersionSync)();
  if (!Host.versionAtLeast(hostVersion, minimumMacOS)) throw new Error(`This Sikarugir engine requires macOS ${minimumMacOS}.`);
  const inventory = await Shared.writeInventory(unpacked, records, signal, LABEL);
  const server = regularFile(unpacked, `${WINE_ROOT}/bin/wineserver`);
  if (fs.statSync(server).size > 32 * 1024 * 1024) throw new Error("Sikarugir server metadata exceeds its supported size.");
  const capabilities = Shared.wineCapabilities(path.join(unpacked, WINE_ROOT));
  return { schemaVersion: 1, engineVersion: pin.engineVersion, wineRoot: WINE_ROOT, supportRoot: SUPPORT_ROOT,
    inventory,
    minimumMacOS, architectures: native.architectures, nativeComponents: native.nativeComponents, capabilities,
    template: { version: template.version, archiveSha256, assetUrl: template.asset.url },
    graphics: { minimumBaseMacOS: graphics.minimumBaseMacOS, graphicsCapabilities: graphics.graphicsCapabilities,
      componentVersions: graphics.componentVersions, relativePaths: graphics.relativePaths } };
}

function createPayloadResolver({ systemVersionSync = Host.systemVersionSync } = {}) {
  const check = Shared.createInventoryCheck({ label: LABEL, systemVersionSync });
  const important = new Set([`${WINE_ROOT}/bin/wine`, `${WINE_ROOT}/bin/wineserver`, `${WINE_ROOT}/lib/wine/x86_64-unix/ntdll.so`, `${SUPPORT_ROOT}/graphics.json`]);
  return function resolvePayload(install, { verification = "full", signal } = {}) {
    if (!install) return { install: null, reason: "Sikarugir Wine is not installed." };
    try {
      throwIfAborted(signal);
      const evidence = install.installationMetadata;
      if (evidence?.schemaVersion !== 1 || evidence.wineRoot !== WINE_ROOT || evidence.supportRoot !== SUPPORT_ROOT)
        throw new Error("Sikarugir registration is incomplete. Remove and install this version again.");
      if (Host.versionAtLeast(evidence.template?.version || "0.0.0", "1.0.24") && !evidence.graphics?.relativePaths?.templateRenderers)
        throw new Error("Sikarugir support libraries are incomplete. Install this version again to restore its renderers.");
      const supported = check(install.installDir, evidence.inventory, { verification, signal, important, minimumMacOS: evidence.minimumMacOS });
      if (!supported.supported) return { install: null, reason: supported.reason, minimumMacOS: evidence.minimumMacOS };
      const wineRoot = path.join(install.installDir, WINE_ROOT), templateRoot = path.join(install.installDir, SUPPORT_ROOT);
      return { install: { ...install, wineRoot, engineRoot: wineRoot, executablePath: path.join(wineRoot, "bin", "wine"),
        serverPath: path.join(wineRoot, "bin", "wineserver"), templateRoot, supportRoot: templateRoot,
        frameworksRoot: path.join(templateRoot, "Frameworks"), runtimeLibraries: templateRoot,
        capabilities: evidence.capabilities, graphicsCapabilities: evidence.graphics?.graphicsCapabilities,
        graphicsMetadata: evidence.graphics, minimumMacOS: evidence.minimumMacOS, engineVersion: evidence.engineVersion },
        reason: null, minimumMacOS: evidence.minimumMacOS };
    } catch (error) { if (error.name === "AbortError") throw error; return { install: null, reason: error.message }; }
  };
}

module.exports = { WINE_ROOT, SUPPORT_ROOT, INVENTORY, walk, inspectClosure, findWineRoot, hashAsync, preparePayload, createPayloadResolver };
