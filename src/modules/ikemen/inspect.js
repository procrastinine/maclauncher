const fs = require("node:fs");
const path = require("node:path");

function readInfo(filePath) {
  try {
    if (fs.statSync(filePath).size > 256 * 1024) return null;
    const text = fs.readFileSync(filePath, "utf8");
    const section = text.match(/\[Info\]([^]*?)(?=^\s*\[|$(?![^]))/im)?.[1] || "";
    const value = name => section.match(new RegExp(`^\\s*${name}\\s*=\\s*([^;\\r\\n]+)`, "im"))?.[1]?.trim().replace(/^"|"$/g, "") || null;
    return { filePath, mugenVersion: value("mugenversion"), ikemenVersion: value("ikemenversion"), contentVersion: value("versiondate") };
  } catch { return null; }
}
function compareVersion(left, right) {
  if (!/^\d+(?:\.\d+)*$/.test(left || "")) return null;
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}
function inspectGame(root, motifRelative) {
  const requirements = [];
  const motif = readInfo(path.join(root, motifRelative));
  if (motif) requirements.push({ ...motif, kind: "motif" });
  try {
    // Bounded sample of character declarations; missing/ambiguous requirements
    // stay unknown and do not imply that every character has been validated.
    for (const name of fs.readdirSync(path.join(root, "chars")).slice(0, 64)) {
      const filePath = name.toLowerCase().endsWith(".def") ? path.join(root, "chars", name) : path.join(root, "chars", name, `${name}.def`);
      const info = readInfo(filePath);
      if (info) requirements.push({ ...info, kind: "character" });
    }
  } catch {}
  const unsupported = requirements.filter(value => compareVersion(value.mugenVersion, "1.1") === 1 || compareVersion(value.ikemenVersion, "1.0.0") === 1);
  const unknownRequirements = requirements.filter(value =>
    (value.mugenVersion && compareVersion(value.mugenVersion, "1.1") === null) ||
    (value.ikemenVersion && compareVersion(value.ikemenVersion, "1.0.0") === null));
  const detectedVersion = motif?.ikemenVersion || motif?.mugenVersion || null;
  return { detectedVersion, detectedVersionSource: detectedVersion ? motif.filePath + " [Info] declaration" : null,
    detectedVersionConfidence: detectedVersion ? "declared" : "unknown", versionKind: "content-runtime-requirement",
    mugenVersion: motif?.mugenVersion || null, ikemenVersion: motif?.ikemenVersion || null,
    contentVersion: motif?.contentVersion || null, requirements, unsupported, unknownRequirements,
    compatibility: unsupported.length ? "requires-newer-runtime" : unknownRequirements.length ? "unknown-declaration"
      : detectedVersion ? "declared-range-supported" : "unknown",
    inspectedCharacterLimit: 64 };
}

module.exports = { inspectGame, readInfo, compareVersion };
