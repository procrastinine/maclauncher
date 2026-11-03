const File = require("../shared/runtime/pinned-file");
const profile = require("./kag3-profile.json"), font = profile.files["font.ttf"];
const asset = Object.freeze({ id: "kag3-ume-gothic", label: "KAG3 Ume Gothic O5 font", filename: "font.ttf", bytes: font.size, sha256: font.sha256,
  url: `https://raw.githubusercontent.com/krkrsdl2/kag3/${profile.upstreamRevision}/data/system_polyfill/font.ttf` });
module.exports = { asset, resolve: userDataDir => File.resolve(asset, userDataDir), ensure: context => File.ensure(asset, context) };
