const fs = require("node:fs"), path = require("node:path");
const { createPinnedNativeManager, upstreamPins } = require("./pinned-native-manager");
const Upstream = require("./upstream"), Component = require("./component-runtime");
const { archiveFormat } = require("./release-files");
const dxvkUpstream = { id: "upstream", label: "DXVK", description: "Windows PE builds from DXVK and its historical projects. DXVK 2.x and 3.x require Vulkan 1.3 and the driver features supplied by compatible KosmicKrisp builds." };
const dxvkMacOS = { id: "macos", label: "DXVK-macOS", secondary: true, description: "DXVK-macOS targets MoltenVK. CrossOver uses builtin-layout async packages; plain-layout packages are separate." };
const macOSOfferForms = { crossover: "builtin" };
const dxvkTemplate = { id: "template", label: "Sikarugir Template", secondary: true, description: "The dxvk variant supplies DXVK async and D9VK for MoltenVK; dxvk3 supplies DXVK for KosmicKrisp. Installed libraries supply their component versions and Direct3D API coverage." };
const definitions = {
  gstreamer: { label: "GStreamer codecs", groupId: "codecs", sourceName: "GStreamer", sourceDescription: "GStreamer runtime packages and prepared local codec folders. Included plugins remain with their source Wine runtime.",
    upstreamUrl: "https://gstreamer.freedesktop.org/download/", upstreamLabel: "GStreamer downloads", memberOrder: 30,
    names: ["gstreamer", "gstreamer-1.0"], entryLibrary: "libgstreamer-1.0.0.dylib", pluginDirectory: "gstreamer-1.0", sources: [require("./gstreamer-source").catalogSource] },
  dxvk: { label: "DXVK", groupId: "directx-vulkan", memberOrder: 2, names: ["dxvk", "dxvk3", "d9vk"],
    sources: [["upstream", "DXVK", "doitsujin/dxvk", name => !/^dxvk-native(?:[-_.]|$)/i.test(name), null, { group: dxvkUpstream, variantLabel: "DXVK" }],
      ["macos", "DXVK-macOS", "Gcenx/DXVK-macOS", name => !/async/i.test(name), null, { group: dxvkMacOS, variantLabel: "Standard", optionsRuntimeForms: macOSOfferForms }],
      ["async", "DXVK-macOS async", "Gcenx/DXVK-macOS", name => /async/i.test(name), null, { group: dxvkMacOS, variantLabel: "Async", optionsRuntimeForms: macOSOfferForms }],
      ["d8vk", "D8VK", "AlpyneDreams/d8vk", null, null, { group: dxvkUpstream, variantLabel: "Historical D8VK", engine: "d8vk", componentLabel: "D8VK", description: "Historical D8VK releases published by AlpyneDreams/d8vk. Its Direct3D 8 work was merged into DXVK." }],
      ["d9vk", "D9VK", "misyltoad/d9vk", null, null, { group: dxvkUpstream, variantLabel: "Historical D9VK", engine: "d9vk", componentLabel: "D9VK", description: "Historical D9VK releases published by misyltoad/d9vk. Its Direct3D 9 work was merged into DXVK." }],
      ...["dxvk", "dxvk3", "d9vk"].map(component => ["template-" + component, "Sikarugir Template · " + component, "Sikarugir-App/Template", null, component,
        { group: dxvkTemplate, variantLabel: component === "d9vk" ? "DXVK subset (d9vk)" : component,
          description: "DXVK libraries from a Sikarugir Template component. Its installed files determine version and API coverage." }])] },
  "vkd3d-proton": { label: "vkd3d-proton", groupId: "directx-vulkan", memberOrder: 3, names: ["vkd3d-proton"],
    sources: [["upstream", "vkd3d-proton", "HansKristian-Work/vkd3d-proton", null, null, { description: "vkd3d-proton releases published by HansKristian-Work/vkd3d-proton. Direct3D 12 requires the Vulkan features used by the selected release; a Vulkan version alone does not establish KosmicKrisp driver support." }]] },
  vkd3d: { label: "Wine vkd3d", groupId: "directx-vulkan", memberOrder: 4, referenceOnly: true, localOnly: true, names: [], sources: [],
    sourceName: "Wine vkd3d", sourceUrl: "https://gitlab.winehq.org/wine/vkd3d", sourceDescription: "Wine vkd3d copies included with registered Wine runtimes remain in their source runtime." },
  d3dmetal: { label: "D3DMetal", groupId: "directx-metal", memberOrder: 1, names: ["d3dmetal", "apple_gptk", "redist"],
    sources: [{ id: "apple", label: "Apple Game Porting Toolkit", url: "https://developer.apple.com/games/game-porting-toolkit/", delivery: "local-files", registrationLabel: "Register Game Porting Toolkit…",
      description: "Apple distributes Game Porting Toolkit. Its download may require an Apple account and licence agreement. The downloaded disk image or extracted folder can be registered here.", discover: async () => [] },
      ["template", "Sikarugir Template", "Sikarugir-App/Template", null, "d3dmetal", { secondary: true }]] },
  dxmt: { label: "DXMT", groupId: "directx-metal", memberOrder: 0, names: ["dxmt"],
    sources: [["upstream", "DXMT", "3Shain/dxmt", name => /builtin/i.test(name)],
      ["template", "Sikarugir Template", "Sikarugir-App/Template", null, "dxmt"]] }
};
function assetName(asset) {
  const filename = asset?.filename || asset?.name || "", extension = archiveFormat(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
}
function templateName(pin) {
  const name = assetName(pin?.asset);
  return /^Template[-_]/i.test(name) ? name.replace(/^Template[-_]/i, "Template ") : null;
}
function translatorSource(pin) {
  const template = templateName(pin);
  const repository = /github\.com\/[^/]+\/([^/]+)/i.exec(pin?.sourceUrl || pin?.asset?.url || "")?.[1];
  return { kind: template ? "template" : "upstream", id: pin?.catalogSourceId || "upstream",
    label: template ? `Sikarugir ${template}` : repository || "Upstream" };
}
function catalogVersion(pin) {
  if (!pin || templateName(pin)) return "";
  const name = assetName(pin?.asset);
  const releaseTag = /\/releases\/tag\/([^/]+)/.exec(pin?.sourceUrl || "")?.[1];
  let release = releaseTag || pin?.upstreamTag || name || pin?.versionLabel || "";
  try { release = decodeURIComponent(release); } catch {}
  const versionPattern = /v?(\d+(?:\.\d+)+(?:-\d+-g[a-f0-9]+)?(?:[-.]?(?:alpha|beta|rc)\d*)?[a-z]?)/i;
  const declared = [pin.releaseVersion, pin.upstreamTag, pin.version, releaseTag].map(value => {
    const match = versionPattern.exec(String(value || "").trim());
    return match?.index === 0 ? match[1] : null;
  }).find(Boolean);
  const assetVersion = versionPattern.exec(name || release)?.[1];
  // Source-recognized releases precede package ABI prefixes. An asset may
  // still qualify that same release with a build revision or prerelease.
  const qualified = declared && assetVersion?.startsWith(declared) && /^[^\d.]/.test(assetVersion.slice(declared.length));
  const version = qualified ? assetVersion : declared || assetVersion || release;
  const qualifiers = [];
  if (/\bmacos\b/i.test(name)) qualifiers.push("macOS build");
  if (/\basync\b/i.test(name)) qualifiers.push("async");
  if (/\bbuiltin\b/i.test(name)) qualifiers.push("builtin");
  if (/\bcrossover\b/i.test(name.replace(/_/g, " "))) qualifiers.push("CrossOver build");
  const date = /(?:^|[-_])(\d{4})(\d{2})(\d{2})(?:[-_]|$)/.exec(name);
  if (/\brepack\b/i.test(name)) qualifiers.push(`repack${date ? ` ${date[1]}-${date[2]}-${date[3]}` : ""}`);
  else if (date) qualifiers.push(`${date[1]}-${date[2]}-${date[3]}`);
  if (/\bnative\b/i.test(name)) qualifiers.push("native");
  return [version, ...qualifiers].filter(Boolean).join(" · ");
}
function catalogDescription(pin, source = translatorSource(pin)) {
  return pin ? { version: catalogVersion(pin), source } : {};
}
function versionLabel(pin, installed, label) {
  pin ||= installed?.catalogEntry;
  const component = installed?.translator || installed?.installationMetadata?.translator;
  if (installed?.custom || installed?.source === "custom") return installed.versionLabel;
  if (!pin && !component?.version) return installed?.versionLabel;
  const template = templateName(pin);
  if (template && !component?.version) return [template, pin?.component].filter(Boolean).join(" · ");
  if (installed) return require("./translator-label").label(Component.withCatalogFacts(
    component || { engine: label }, catalogDescription(pin), pin?.catalogSourceId));
  return template || catalogVersion(pin);
}
function catalogSource([id, label, repository, filter, component, presentation = {}], projectLabel = component) {
  const upstream = Upstream.github({ repository, prerelease: true, allArchitectures: true, recognize: release =>
    (release.assets || []).filter(asset => archiveFormat(asset.name) && (!filter || filter(asset.name)) &&
      (!component || /^Template-/i.test(asset.name))).map(asset => ({
        version: (id + "-" + asset.name.replace(/\.(?:tar\.(?:gz|xz|bz2)|t[gx]z|zip|tar)$/i, "")).replace(/[^a-z0-9._-]/ig, "-"),
        architecture: "universal", label: versionLabel({ asset: { filename: asset.name }, upstreamTag: release.tag_name }, null, projectLabel || label), assets: [asset], details: { component, catalogSourceId: id, releaseVersion: release.tag_name, ...(presentation.engine ? { translatorEngine: presentation.engine } : {}) } })) });
  const versionOf = pin => {
    if (templateName(pin)) return templateName(pin).replace(/^Template /, "");
    return require("./version-order.mjs").catalogVersion(pin);
  };
  return { id, label, description: component ? `${projectLabel} copies taken from a Sikarugir Template release (${component}).` : `${label} releases published by ${repository}.`, url: `https://github.com/${repository}/releases`,
    versionOf, compareEntries: (a, b) => require("./version-order.mjs").compareVersions(versionOf(b), versionOf(a)),
    filterEntry: pin => !pin.asset?.filename || !filter || filter(pin.asset.filename),
    ...presentation, discover: async options => upstreamPins(await upstream.discover(options)) };
}
function createManager(engine, { dependencies = {} } = {}) {
  const definition = { ...definitions[engine], engine }, catalogSources = definition.sources.map(source => typeof source.discover === "function" ? source : catalogSource(source, definition.label));
  const downloadSource = catalogSources.find(source => source.delivery !== "local-files");
  const installedSource = pin => {
    const source = translatorSource(pin), declared = catalogSources.find(item => item.id === pin?.catalogSourceId);
    return declared?.optionsRuntimeForms ? { ...(typeof source === "object" ? source : { kind: "upstream", id: pin.catalogSourceId, label: declared.label }),
      optionsRuntimeForms: declared.optionsRuntimeForms } : source;
  };
  const manager = createPinnedNativeManager({ id: engine === "dxmt" ? "sikarugir-graphics-bridge" : "translator-" + engine,
    formerIds: engine === "dxmt" ? ["crossover-graphics-bridge"] : [], label: definition.label,
    upstreamUrl: definition.upstreamUrl, upstreamLabel: definition.upstreamLabel,
    formatVersionLabel: (pin, installed) => versionLabel(pin, installed, catalogSources.find(source => source.id === pin?.catalogSourceId)?.componentLabel || definition.label),
    discoverCatalog: () => [], ...(catalogSources.length ? { catalogSources } : {}), sourceUrl: definition.sourceUrl || downloadSource?.url || catalogSources[0]?.url || "https://gstreamer.freedesktop.org/", sourceLabel: "Source", sourceName: definition.sourceName, sourceDescription: definition.sourceDescription, nativeLibrary: true, cacheDownloads: true, supportsDefault: false, customRuntime: !definition.referenceOnly,
    resolveExecutable(root) { return Component.inspected(Component.componentRoot(root, definition), definition).executablePath; },
    inspectRuntime({ runtimePath, runtimeRoot, runtimeSource, runtimeCatalogEntry }) {
      return Component.inspected(Component.componentRoot(runtimeRoot || path.dirname(runtimePath), definition), definition, { ...catalogDescription(runtimeCatalogEntry), engine: runtimeCatalogEntry?.translatorEngine || definition.engine, source: runtimeCatalogEntry ? installedSource(runtimeCatalogEntry) : runtimeSource || "upstream" });
    },
    prepareInstall({ unpacked, pin }) {
      const selected = pin.component ? { ...definition, names: [pin.component] } : definition;
      const root = Component.componentRoot(unpacked, selected);
      const resources = path.join(unpacked, "package-resources");
      if (root !== unpacked && archiveFormat(pin.asset?.filename) === ".pkg" && fs.existsSync(resources)) {
        try { require("../copy-file").cloneOrCopySync(resources, path.join(root, "package-resources")); }
        catch (error) { console.warn("The optional package resources could not be retained:", error.message); }
      }
      const translator = Component.description(root, definition, { ...catalogDescription(pin, installedSource(pin)), engine: pin.translatorEngine || definition.engine });
      const files = Object.fromEntries(translator.files.filter(file => file.format !== "json").map(file => [file.relative, require("./pinned-native-manager").hashFile(file.path)]));
      const stored = require("./translator-description").installationDescription(translator);
      const relative = path.relative(unpacked, root);
      if (relative) {
        const temporary = path.join(path.dirname(unpacked), "component");
        require("../copy-file").cloneOrCopySync(root, temporary);
        for (const name of fs.readdirSync(unpacked)) fs.rmSync(path.join(unpacked, name), { recursive: true, force: true });
        fs.renameSync(temporary, path.join(unpacked, definition.names[0]));
      }
      return { translator: stored, files, translatorRelative: relative ? definition.names[0] : "" };
    }, dependencies: { extractArchive: require("./safe-archive").extractArchive, ...dependencies } });
  manager.translatorEngine = engine;
  manager.ui = { groupId: definition.groupId, sectionLabel: definition.label, memberOrder: definition.memberOrder, management: "managed" };
  if (definition.localOnly) {
    manager.delivery = { ...manager.delivery, catalog: "none" };
    const getState = manager.getState;
    manager.getState = function(options = {}) {
      const state = getState.call(this, options);
      const local = section => ({ ...section, sourceLinks: [{ label: definition.sourceName, url: section.catalog.sourceUrl }, ...(definition.sourceLinks || [])],
        ...(definition.referenceOnly ? { managementTitle: "Included copies", installedTitle: "Included" } : { managementTitle: "Codec sources", installedTitle: "Codecs" }),
        catalog: { ...section.catalog, delivery: "local-files", status: "success", installable: false, importable: false,
          refreshLabel: definition.referenceOnly ? "Refresh included copies" : "Refresh registrations",
          emptyLabel: definition.referenceOnly ? "No included copies found in registered runtimes." : "No codec folders registered.", error: null } });
      return { ...local(state), sections: state.sections?.map(local) };
    };
    manager.refreshCatalog = async options => manager.getState(options).catalog;
  }
  return Component.withIncludedReferences(definition.referenceOnly ? manager : Component.configure(manager, {
    ...definition, catalogDescription: pin => catalogDescription(pin, installedSource(pin)) }));
}
module.exports = { definitions, catalogSource, createManager, assetName, templateName, catalogVersion, catalogDescription, versionLabel };
