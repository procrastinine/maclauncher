// Compatible renderer closures are selected independently of the Wine engine.
// New rows require the same native/thunk command ABI as the included adapter.
const SOURCE_URL = "https://github.com/Sikarugir-App/Template/releases";
const CATALOG = Object.freeze([Object.freeze({
  version: "1.0.21", versionLabel: "DXMT · support 1.0.21", minimumMacOS: "14.0", hostArchitectures: ["arm64"],
  upstreamRevision: "Template-1.0.21:sha256:bbe996e4e4375318485953d0c7818b7b4b0a4dc1f13303bcc584f99f7602f78d", localBuild: false,
  cameraBridge: Object.freeze({ id: "dxmt-camera1", tableCount: 146,
    nativeSha256: "62dbce6c66f23308fcdf58fba7371271b0412a71074ad7add87a801516ce473a",
    thunkSha256: "e176504a3ee9d79d0f1b455141d79ed5f0355ce8ecf99317001ffd5d8e620367" }),
  asset: Object.freeze({ filename: "Template-1.0.21.tar.xz", bytes: 95883080, assetId: 604330514,
    url: "https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-1.0.21.tar.xz",
    sha256: "bbe996e4e4375318485953d0c7818b7b4b0a4dc1f13303bcc584f99f7602f78d", integritySource: "github-published-sha256" })
})]);
const RECOMMENDED_VERSION = "1.0.21";
function compatible(pin, adapter) {
  // The id names the complete reviewed command, parameter, thunk and portable
  // shader ABI. A matching table length alone does not establish compatibility.
  return Boolean(pin?.cameraBridge && adapter && pin.cameraBridge.id === adapter.id && pin.cameraBridge.tableCount === adapter.tableCount);
}
function withSettingsOptions(manifest) {
  const entries = Object.fromEntries(Object.entries(manifest.runtime.entries).map(([id, runtime]) => [id, { ...runtime,
    settings: { ...runtime.settings, fields: runtime.settings.fields.map(field => field.key === "graphicsBridgeVersion" ? { ...field,
      options: [{ value: "auto", label: "Automatic" }, ...CATALOG.map(pin => ({ value: pin.version, label: pin.versionLabel }))] } : field) } }]));
  return { ...manifest, runtime: { ...manifest.runtime, entries } };
}
module.exports = { SOURCE_URL, CATALOG, RECOMMENDED_VERSION, compatible, withSettingsOptions };
