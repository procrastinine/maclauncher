const fs = require("node:fs"), path = require("node:path");
const { createPinnedNativeManager, upstreamPins } = require("./pinned-native-manager");
const Upstream = require("./upstream"), Component = require("./component-runtime");
const { archiveFormat } = require("./release-files");
const definitions = {
  gstreamer: { label: "GStreamer codecs", names: ["gstreamer-1.0"], sources: [] },
  dxvk: { label: "DXVK", apis: ["Direct3D 9", "Direct3D 10", "Direct3D 11"], names: ["dxvk", "dxvk3", "d9vk"],
    sources: [["upstream", "Upstream", "doitsujin/dxvk"], ["macos", "macOS", "Gcenx/DXVK-macOS", name => !/async/i.test(name)],
      ["async", "macOS async", "Gcenx/DXVK-macOS", name => /async/i.test(name)],
      ...["dxvk", "dxvk3", "d9vk"].map(component => ["template-" + component, "Sikarugir Template · " + component, "Sikarugir-App/Template", null, component])] },
  "vkd3d-proton": { label: "vkd3d-proton", apis: ["Direct3D 12"], names: ["vkd3d-proton"],
    sources: [["upstream", "Upstream", "HansKristian-Work/vkd3d-proton"]] },
  d3dmetal: { label: "D3DMetal", apis: ["Direct3D 11", "Direct3D 12"], names: ["d3dmetal", "apple_gptk", "redist"],
    sources: [["template", "Sikarugir Template", "Sikarugir-App/Template", null, "d3dmetal"]] },
  dxmt: { label: "DXMT", apis: ["Direct3D 10", "Direct3D 11"], names: ["dxmt"],
    sources: [["upstream", "Upstream", "3Shain/dxmt", name => /builtin/i.test(name)],
      ["template", "Sikarugir Template", "Sikarugir-App/Template", null, "dxmt"]] }
};
function catalogSource([id, label, repository, filter, component]) {
  const upstream = Upstream.github({ repository, prerelease: true, allArchitectures: true, recognize: release =>
    (release.assets || []).filter(asset => archiveFormat(asset.name) && (!filter || filter(asset.name)) &&
      (!component || /^Template-/i.test(asset.name))).map(asset => ({
        version: (id + "-" + asset.name.replace(/\.(?:tar\.(?:gz|xz|bz2)|t[gx]z|zip|tar)$/i, "")).replace(/[^a-z0-9._-]/ig, "-"),
        architecture: "universal", label: `${release.tag_name} (${label})`, assets: [asset], details: { component, catalogSourceId: id } })) });
  return { id, label, url: `https://github.com/${repository}/releases`, discover: async options => upstreamPins(await upstream.discover(options)) };
}
function createManager(engine, { dependencies = {} } = {}) {
  const definition = { ...definitions[engine], engine }, catalogSources = definition.sources.map(catalogSource);
  const manager = createPinnedNativeManager({ id: engine === "dxmt" ? "sikarugir-graphics-bridge" : "translator-" + engine,
    formerIds: engine === "dxmt" ? ["crossover-graphics-bridge"] : [], label: definition.label,
    discoverCatalog: () => [], ...(catalogSources.length ? { catalogSources } : {}), sourceUrl: catalogSources[0]?.url || "https://gstreamer.freedesktop.org/", nativeLibrary: true, cacheDownloads: true,
    resolveExecutable(root) { return Component.inspected(Component.componentRoot(root, definition), definition).executablePath; },
    inspectRuntime({ runtimePath, runtimeRoot, runtimeSource, runtimeLabel, runtimeVersion }) {
      return Component.inspected(Component.componentRoot(runtimeRoot || path.dirname(runtimePath), definition), definition, { source: runtimeSource || "upstream", version: runtimeLabel || runtimeVersion });
    },
    prepareInstall({ unpacked, pin }) {
      const selected = pin.component ? { ...definition, names: [pin.component] } : definition;
      const root = Component.componentRoot(unpacked, selected);
      const translator = Component.description(root, definition, { source: pin.catalogSourceId, version: pin.versionLabel || pin.version });
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
  return Component.configure(manager, definition);
}
module.exports = { definitions, catalogSource, createManager };
