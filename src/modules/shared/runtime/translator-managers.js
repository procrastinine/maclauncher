const fs = require("node:fs"), path = require("node:path");
const { createPinnedNativeManager, upstreamPins } = require("./pinned-native-manager");
const Upstream = require("./upstream"), Component = require("./component-runtime");
const { archiveFormat } = require("./release-files");
const definitions = {
  gstreamer: { label: "GStreamer codecs", groupId: "codecs", localOnly: true, sourceName: "GStreamer", sourceDescription: "Included plugins stay with the selected Wine runtime. Prepared codec folders can add plugins that use the same GStreamer and GObject libraries.", sourceLinks: [{ label: "GStreamer downloads", url: "https://gstreamer.freedesktop.org/download/" }], memberOrder: 30, names: ["gstreamer-1.0"], sources: [] },
  dxvk: { label: "DXVK", groupId: "directx-vulkan", memberOrder: 2, names: ["dxvk", "dxvk3", "d9vk"],
    sources: [["upstream", "DXVK", "doitsujin/dxvk", null, null, { secondary: true }], ["macos", "DXVK-macOS", "Gcenx/DXVK-macOS", name => !/async/i.test(name), null, { description: "CrossOver's included copy or automatic choice is the ordinary route; Sikarugir uses its Template. DXVK-macOS releases published by Gcenx/DXVK-macOS are an optional macOS alternative." }],
      ["async", "DXVK-macOS async", "Gcenx/DXVK-macOS", name => /async/i.test(name), null, { secondary: true, description: "DXVK-macOS async releases published by Gcenx/DXVK-macOS, with asynchronous shader compilation." }],
      ["d8vk", "D8VK", "AlpyneDreams/d8vk", null, null, { secondary: true, engine: "d8vk", componentLabel: "D8VK", description: "Historical D8VK releases published by AlpyneDreams/d8vk. Its Direct3D 8 work was merged into DXVK; modern DXVK packages can include this API." }],
      ["d9vk", "D9VK", "misyltoad/d9vk", null, null, { secondary: true, engine: "d9vk", componentLabel: "D9VK", description: "Historical D9VK releases published by misyltoad/d9vk. Its Direct3D 9 work was merged into DXVK; installed libraries determine each package's API coverage." }],
      ...["dxvk", "dxvk3", "d9vk"].map(component => ["template-" + component, "Sikarugir Template · " + component, "Sikarugir-App/Template", null, component, { secondary: true, ...(component === "d9vk" ? { description: "D9VK copies taken from a Sikarugir Template release. This is the older Direct3D 8/9 variant." } : {}) }])] },
  "vkd3d-proton": { label: "vkd3d-proton", groupId: "directx-vulkan", memberOrder: 3, names: ["vkd3d-proton"],
    sources: [["upstream", "vkd3d-proton", "HansKristian-Work/vkd3d-proton"]] },
  vkd3d: { label: "Wine vkd3d", groupId: "directx-vulkan", memberOrder: 4, referenceOnly: true, localOnly: true, names: [], sources: [],
    sourceName: "Wine vkd3d", sourceUrl: "https://gitlab.winehq.org/wine/vkd3d", sourceDescription: "Wine vkd3d copies included with registered Wine runtimes remain in their source runtime." },
  d3dmetal: { label: "D3DMetal", groupId: "directx-metal", upstreamUrl: "https://developer.apple.com/games/game-porting-toolkit/", upstreamLabel: "Apple Game Porting Toolkit downloads", memberOrder: 1, names: ["d3dmetal", "apple_gptk", "redist"],
    sources: [["template", "Sikarugir Template", "Sikarugir-App/Template", null, "d3dmetal"]] },
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
  return template ? { kind: "template", id: pin?.catalogSourceId || "template", label: template } : pin?.catalogSourceId || "upstream";
}
function versionLabel(pin, installed, label) {
  const template = templateName(pin), component = installed?.translator?.version;
  if (pin?.component && pin.component.toLowerCase() !== label.toLowerCase()) label += ` (${pin.component})`;
  if (template) return component ? `${label} ${component} · ${template}` : `${template} · ${label} component`;
  return component ? `${label} ${component}` : assetName(pin?.asset) || installed?.versionLabel || pin?.versionLabel;
}
function catalogSource([id, label, repository, filter, component, presentation = {}], projectLabel = component) {
  const upstream = Upstream.github({ repository, prerelease: true, allArchitectures: true, recognize: release =>
    (release.assets || []).filter(asset => archiveFormat(asset.name) && (!filter || filter(asset.name)) &&
      (!component || /^Template-/i.test(asset.name))).map(asset => ({
        version: (id + "-" + asset.name.replace(/\.(?:tar\.(?:gz|xz|bz2)|t[gx]z|zip|tar)$/i, "")).replace(/[^a-z0-9._-]/ig, "-"),
        architecture: "universal", label: versionLabel({ asset: { filename: asset.name } }, null, projectLabel || label), assets: [asset], details: { component, catalogSourceId: id, ...(presentation.engine ? { translatorEngine: presentation.engine } : {}) } })) });
  return { id, label, description: component ? `${projectLabel} copies taken from a Sikarugir Template release (${component}).` : `${label} releases published by ${repository}.`, url: `https://github.com/${repository}/releases`, ...presentation, discover: async options => upstreamPins(await upstream.discover(options)) };
}
function createManager(engine, { dependencies = {} } = {}) {
  const definition = { ...definitions[engine], engine }, catalogSources = definition.sources.map(source => catalogSource(source, definition.label));
  const manager = createPinnedNativeManager({ id: engine === "dxmt" ? "sikarugir-graphics-bridge" : "translator-" + engine,
    formerIds: engine === "dxmt" ? ["crossover-graphics-bridge"] : [], label: definition.label,
    upstreamUrl: definition.upstreamUrl, upstreamLabel: definition.upstreamLabel,
    formatVersionLabel: (pin, installed) => versionLabel(pin, installed, catalogSources.find(source => source.id === pin?.catalogSourceId)?.componentLabel || definition.label),
    discoverCatalog: () => [], ...(catalogSources.length ? { catalogSources } : {}), sourceUrl: definition.sourceUrl || catalogSources[0]?.url || "https://gstreamer.freedesktop.org/", sourceLabel: "Source", sourceName: definition.sourceName, sourceDescription: definition.sourceDescription, nativeLibrary: true, cacheDownloads: true, supportsDefault: !definition.referenceOnly, customRuntime: !definition.referenceOnly,
    resolveExecutable(root) { return Component.inspected(Component.componentRoot(root, definition), definition).executablePath; },
    inspectRuntime({ runtimePath, runtimeRoot, runtimeSource, runtimeCatalogEntry }) {
      return Component.inspected(Component.componentRoot(runtimeRoot || path.dirname(runtimePath), definition), definition, { engine: runtimeCatalogEntry?.translatorEngine || definition.engine, source: runtimeCatalogEntry ? translatorSource(runtimeCatalogEntry) : runtimeSource || "upstream" });
    },
    prepareInstall({ unpacked, pin }) {
      const selected = pin.component ? { ...definition, names: [pin.component] } : definition;
      const root = Component.componentRoot(unpacked, selected);
      const translator = Component.description(root, definition, { engine: pin.translatorEngine || definition.engine, source: translatorSource(pin) });
      const files = Object.fromEntries(translator.files.filter(file => file.format !== "json").map(file => [file.relative, require("./pinned-native-manager").hashFile(file.path)]));
      translator.files = translator.files.map(file => ({ ...file, path: file.relative }));
      delete translator.root; delete translator.id;
      const relative = path.relative(unpacked, root);
      if (relative) {
        const temporary = path.join(path.dirname(unpacked), "component");
        require("../copy-file").cloneOrCopySync(root, temporary);
        for (const name of fs.readdirSync(unpacked)) fs.rmSync(path.join(unpacked, name), { recursive: true, force: true });
        fs.renameSync(temporary, path.join(unpacked, definition.names[0]));
      }
      return { translator, files, translatorRelative: relative ? definition.names[0] : "" };
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
  return Component.withIncludedReferences(definition.referenceOnly ? manager : Component.configure(manager, definition));
}
module.exports = { definitions, catalogSource, createManager, assetName, templateName, versionLabel };
