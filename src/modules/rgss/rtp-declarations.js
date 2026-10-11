const fs = require("node:fs");
const path = require("node:path");
const { normalizeRtpId } = require("./rgss-utils");

function declarations(section) {
  if (!section || typeof section !== "object") return null;
  const keys = ["rtp1", "rtp2", "rtp3"].some(key => Object.hasOwn(section, key))
    ? ["rtp1", "rtp2", "rtp3"] : ["rtp"];
  if (!keys.some(key => Object.hasOwn(section, key))) return null;
  return keys.filter(key => Object.hasOwn(section, key)).map(key => String(section[key] || "").trim()).filter(Boolean);
}

function readDeclarations(root) {
  if (typeof root !== "string") return null;
  try {
    const name = fs.readdirSync(root).find(name => name.toLowerCase() === "game.ini");
    if (!name) return null;
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    let game = false; const section = Object.create(null);
    for (const line of raw.split(/\r?\n/)) {
      const heading = line.trim().match(/^\[([^\]]+)\]$/);
      if (heading) { game = heading[1].trim().toLowerCase() === "game"; continue; }
      const setting = game && line.match(/^\s*(rtp[123]?)\s*=\s*(.*)$/i);
      if (setting) section[setting[1].toLowerCase()] = setting[2].replace(/\s[;#].*$/, "").trim();
    }
    return declarations(section);
  } catch (error) { if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return null; throw error; }
}

function forEntry(entry) {
  const data = entry?.moduleData || {};
  // Cached imports retain the declaration, including an explicitly empty RTP.
  if (Array.isArray(data.rtpDeclarations)) return data.rtpDeclarations;
  const found = readDeclarations(entry?.contentRootDir || entry?.gamePath);
  if (found !== null) return found;
  return data.rtpId ? [data.rtpId] : [];
}

function requiredPacks(entry, runtimeSettings = {}) {
  if (runtimeSettings.rtpMode === "manual") return [];
  return [...new Set(forEntry(entry).map(normalizeRtpId).filter(Boolean))];
}

module.exports = { declarations, readDeclarations, forEntry, requiredPacks };
