const File = require("../shared/runtime/pinned-file");
const asset = Object.freeze({ id: "rgss-gmgsx", label: "GMGSx MIDI soundfont", filename: "GMGSx.SF2", bytes: 4140692,
  sha256: "4b1b1e07eef830c395180a067a868d9c6b26d96fd568a68645f79cf874dd9773",
  url: "https://github.com/procrastinine/maclauncher-builds/releases/download/upstream-mirrors-1/GMGSx.SF2" });
const configured = context => typeof context.runtimeSettings?.soundfontPath === "string" && context.runtimeSettings.soundfontPath.trim();
module.exports = { asset, resolve: userDataDir => File.resolve(asset, userDataDir),
  ensure: context => configured(context) ? null : File.ensure(asset, context) };
