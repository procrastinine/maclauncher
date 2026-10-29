const SOURCE_URL = "https://github.com/Sikarugir-App/Template/releases";
// Runtime contracts are separate from excluded producer recipes/source inputs.
const VULKAN_PROFILE = Object.freeze({ id: "crossover-26.3.0-winevulkan-scene-v1",
  driverVersion: 47, unixCallCount: 674, marker: 0x2630002f });
const FIDELITYFX_PROFILE = Object.freeze({ id: "fidelityfx-api-1.0.1-sdk1.1.4", library: "amd_fidelityfx_vk.dll",
  original: "maclauncher_fidelityfx_vk_original.dll", referenceSha256: "a1624cc4238fef046f30c4d80ce3f47be63fc5f5373f49e3ee9edb9960f54c78",
  exports: Object.freeze(["ffxConfigure", "ffxCreateContext", "ffxDestroyContext", "ffxDispatch", "ffxQuery"]) });
function withSettingsOptions(manifest) {
  const entries = Object.fromEntries(Object.entries(manifest.runtime.entries).map(([id, runtime]) => [id, { ...runtime,
    settings: { ...runtime.settings, fields: runtime.settings.fields.map(field => field.key === "graphicsBridgeVersion" ? { ...field,
      options: [{ value: "auto", label: "Automatic" }], optionsAction: "listGraphicsBridgeVersions", optionsKey: "graphicsBridgeVersions" } : field) } }]));
  return { ...manifest, runtime: { ...manifest.runtime, entries } };
}
module.exports = { SOURCE_URL, VULKAN_PROFILE, FIDELITYFX_PROFILE, withSettingsOptions };
