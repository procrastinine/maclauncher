// dappermint's winecx-gptk runtime: CodeWeavers' CrossOver Wine changes on a
// current Wine release, downloaded as one Libraries archive. DXVK and DXMT
// arrive with it; D3DMetal comes from a version installed in Runtimes.
const Adapter = require("../../../runtime-adapters/wine");
module.exports = Adapter.descriptor("winecx", {
  manager: () => require("../winecx/runtime/manager"),
  // Its DXMT keeps the Whisky x64/x32 layout, which the camera adapter does
  // not use as a base; a DXMT version from Runtimes serves it.
  dxmtBase: () => null,
  // Its native closure uses loader-relative paths; the fallback root covers
  // libraries Wine opens by name.
  launchEnvironment: () => ({})
});
