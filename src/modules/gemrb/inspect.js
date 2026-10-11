const fs = require("node:fs");
const path = require("node:path");

function inspectGame(root) {
  const markers = [];
  const candidates = [];
  for (const directory of [root, path.join(root, "override")]) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (/^(baldur|icewind|icewind2|torment|gem-demo)\.gam$/i.test(name)) candidates.push(path.join(directory, name));
      }
    } catch {}
  }
  const formats = [];
  for (const filePath of candidates) {
    try {
      const fd = fs.openSync(filePath, "r"), data = Buffer.alloc(8);
      try { fs.readSync(fd, data, 0, 8, 0); } finally { fs.closeSync(fd); }
      const signature = data.toString("ascii");
      if (/^GAMEV\d\.\d$/.test(signature)) formats.push({ filePath, signature });
    } catch {}
  }
  const names = new Set(fs.readdirSync(root).map(name => name.toLowerCase()));
  for (const [filename, gameType] of [["icewind2.ini", "iwd2"], ["icewind.ini", "iwd"], ["torment.ini", "pst"], ["gem-demo.ini", "demo"]]) {
    if (names.has(filename)) markers.push({ filename, gameType });
  }
  const knownFormats = ["GAMEV0.0", "GAMEV1.0", "GAMEV1.1", "GAMEV2.0", "GAMEV2.1", "GAMEV2.2"];
  const signatures = [...new Set(formats.map(value => value.signature))];
  const specific = signatures.length === 1 ? signatures[0] : null;
  const signatureType = { "GAMEV0.0": "demo", "GAMEV1.0": "bg1", "GAMEV2.0": "bg2", "GAMEV2.1": "bg2", "GAMEV2.2": "iwd2" }[specific];
  const types = [...new Set([...markers.map(marker => marker.gameType), ...(signatureType ? [signatureType] : [])])];
  return { detectedVersion: specific || null, detectedVersionSource: specific ? formats.find(value => value.signature === specific).filePath + " header" : null,
    detectedVersionConfidence: specific ? "high" : "unknown", versionKind: "game-data-format",
    detectedGameType: types.length === 1 ? types[0] : "auto", gameTypeSource: types.length === 1 ? (signatureType ? "GAME header" : "game INI filename") : "unknown",
    compatibility: signatures.some(value => !knownFormats.includes(value)) ? "unsupported-format" : "format-recognized",
    formats, familyMarkers: markers, dataFormatVersion: "KEY V1 / TLK V1" };
}

module.exports = { inspectGame };
