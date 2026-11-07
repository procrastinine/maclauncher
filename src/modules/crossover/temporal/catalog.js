const SOURCE_URL = "https://github.com/Sikarugir-App/Template/releases";
// The FidelityFX API 1.0.1 profile: one proxy per backend library, each
// loading the game's own library under its original's name.
const FIDELITYFX_PROFILE = Object.freeze({ id: "fidelityfx-api-1.0.1-sdk1.1.4",
  libraries: Object.freeze({ vk: "amd_fidelityfx_vk.dll", dx12: "amd_fidelityfx_dx12.dll" }),
  originals: Object.freeze({ vk: "maclauncher_fidelityfx_vk_original.dll", dx12: "maclauncher_fidelityfx_dx12_original.dll" }),
  exports: Object.freeze(["ffxConfigure", "ffxCreateContext", "ffxDestroyContext", "ffxDispatch", "ffxQuery"]) });
function withSettingsOptions(manifest) {
  const entries = Object.fromEntries(Object.entries(manifest.runtime.entries).map(([id, runtime]) => [id, { ...runtime,
    settings: { ...runtime.settings, fields: runtime.settings.fields.map(field => field.key === "graphicsBridgeVersion" ? { ...field,
      options: [{ value: "auto", label: "Automatic" }], optionsAction: "listGraphicsBridgeVersions", optionsKey: "graphicsBridgeVersions" } : field) } }]));
  return { ...manifest, runtime: { ...manifest.runtime, entries } };
}
module.exports = { SOURCE_URL, FIDELITYFX_PROFILE, withSettingsOptions };
