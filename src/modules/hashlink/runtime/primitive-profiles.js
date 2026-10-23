const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROFILES = Object.freeze({
  "stock-2.0.0-10b77768ab91": "stock-2.0.0-10b77768ab91.json",
  "stock-2.0.0-d049add0a84d": "stock-2.0.0-d049add0a84d.json",
  "typed-1.9-macos-v2": "typed-1.9-macos-v2.json",
  "legacy-dynamic-1.12-macos-v1": "legacy-dynamic-1.12-macos-v1.json",
});
const profiles = new Map();
function forPin(pin) {
  const id = pin?.primitiveProfileId, name = PROFILES[id];
  if (!name) return null;
  if (!profiles.has(id)) {
    const bytes = fs.readFileSync(path.join(__dirname, "profiles", name));
    profiles.set(id, { value: JSON.parse(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  const record = profiles.get(id), profile = record.value;
  if (record.sha256 !== pin.primitiveProfileSha256 || profile.schemaVersion !== 1 ||
    profile.upstreamRevision !== pin.upstreamRevision || profile.architecture !== "x86_64" ||
    profile.callbackMarker !== pin.nativeAbi?.callbackMarker || profile.archiveSha256 && profile.archiveSha256 !== pin.asset?.sha256) return null;
  return profile;
}
module.exports = { forPin };
