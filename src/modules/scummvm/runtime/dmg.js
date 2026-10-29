const Dmg = require("../../shared/runtime/dmg");

function extractDmg(archivePath, destination, signal, options = {}) {
  return Dmg.extractDmg(archivePath, destination, signal,
    { payloadName: "ScummVM.app", project: "ScummVM", ...options });
}

module.exports = { extractDmg };
