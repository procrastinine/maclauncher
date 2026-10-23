const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_METADATA_BYTES = 64 * 1024;
const within = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};
function positiveAppId(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : null;
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 0xffffffff ? parsed : null;
}
function readMetadata(file, scope) {
  if (!within(scope, fs.realpathSync(file))) throw new Error("Steam metadata must stay inside its explicit source root.");
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_METADATA_BYTES) || !within(scope, fs.realpathSync(file)))
    throw new Error("Steam metadata must be a bounded regular game-local file.");
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key]))
    throw new Error("Steam metadata changed while it was inspected.");
  return { text: bytes.toString("utf8").replace(/^\uFEFF/, ""), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
function iniIds(text, sections, keys) {
  const results = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[;#]/.test(trimmed)) continue;
    const heading = /^\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(trimmed);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    if (!sections.includes(section)) continue;
    const pair = /^([^=]+)=(.*)$/.exec(trimmed);
    if (!pair || !keys.includes(pair[1].trim().toLowerCase())) continue;
    const value = positiveAppId(pair[2].trim());
    if (!value) throw new Error("Steam configuration has an invalid application ID.");
    results.push({ value, section, key: pair[1].trim() });
  }
  return results;
}
function parseAppManifest(text) {
  const tokens = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (/\s/.test(text[cursor])) { cursor++; continue; }
    if (text.startsWith("//", cursor)) { const end = text.indexOf("\n", cursor); cursor = end < 0 ? text.length : end + 1; continue; }
    if (tokens.length >= 2048) throw new Error("Steam application manifest has too many fields.");
    if (text[cursor] === "{" || text[cursor] === "}") { tokens.push(text[cursor++]); continue; }
    let value = "";
    if (text[cursor] === '"') {
      cursor++;
      let closed = false;
      while (cursor < text.length) {
        const character = text[cursor++];
        if (character === '"') { closed = true; break; }
        if (character === "\\") {
          if (cursor >= text.length) throw new Error("Truncated Steam application manifest escape.");
          value += text[cursor++];
        } else value += character;
        if (value.length > 4096) throw new Error("Steam application manifest field exceeds supported bounds.");
      }
      if (!closed) throw new Error("Truncated Steam application manifest string.");
    } else {
      const match = /^[^\s{}"]+/.exec(text.slice(cursor));
      if (!match || match[0].length > 4096) throw new Error("Invalid Steam application manifest field.");
      value = match[0]; cursor += value.length;
    }
    tokens.push(value);
  }
  cursor = 0;
  function object(depth = 0, nested = false) {
    if (depth > 8) throw new Error("Steam application manifest is too deeply nested.");
    const result = Object.create(null);
    while (cursor < tokens.length) {
      const key = tokens[cursor++];
      if (key === "}" && nested) return result;
      if (key === "{" || key === "}" || cursor >= tokens.length) throw new Error("Invalid Steam application manifest structure.");
      const name = key.toLowerCase();
      if (Object.hasOwn(result, name)) throw new Error("Steam application manifest contains a duplicate field.");
      const value = tokens[cursor++];
      result[name] = value === "{" ? object(depth + 1, true) : value;
      if (value === "}") throw new Error("Invalid Steam application manifest value.");
    }
    if (nested) throw new Error("Truncated Steam application manifest object.");
    return result;
  }
  const parsed = object();
  if (!parsed.appstate || typeof parsed.appstate !== "object") throw new Error("Steam application manifest lacks AppState metadata.");
  const value = positiveAppId(parsed.appstate.appid);
  if (!value) throw new Error("Steam application manifest has an invalid application ID.");
  return { value, installDir: typeof parsed.appstate.installdir === "string" ? parsed.appstate.installdir : null };
}

function readAppManifest(file, root) {
  const name = /^appmanifest_(\d{1,10})\.acf$/i.exec(path.basename(file));
  if (!name) throw new Error("Invalid Steam application manifest filename.");
  const data = readMetadata(file, root), result = parseAppManifest(data.text);
  if (positiveAppId(name[1]) !== result.value) throw new Error("Steam application manifest filename and AppState ID disagree.");
  return { ...result, sha256: data.sha256 };
}

/** Reads explicit game-local identity metadata only; no execution or global Steam scanning. */
function readGameAppId({ gameRoot, extraRoots = [], gen8SteamAppId, appManifestPath, manifestRoot } = {}) {
  if (!path.isAbsolute(gameRoot || "") || !Array.isArray(extraRoots) || extraRoots.length > 8)
    throw new Error("An absolute original game root and bounded extra roots are required.");
  const root = fs.realpathSync(gameRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error("The original Steam game root is not a directory.");
  const roots = [root];
  for (const item of extraRoots) {
    if (!path.isAbsolute(item || "")) throw new Error("Additional Steam metadata roots must be absolute.");
    const directory = fs.realpathSync(item);
    if (!within(root, directory) || !fs.statSync(directory).isDirectory()) throw new Error("Additional Steam metadata must stay inside the original game root.");
    if (!roots.includes(directory)) roots.push(directory);
  }
  const evidence = [], errors = [];
  function inspect(file, kind, parse, scope = root) {
    if (!fs.existsSync(file)) return;
    try {
      const data = readMetadata(file, scope), values = parse(data.text);
      for (const item of values) evidence.push({ kind, filePath: file, sha256: data.sha256, ...item });
    } catch (error) { errors.push({ filePath: file, message: error.message }); }
  }
  for (const directory of roots) {
    for (const relative of ["steam_appid.txt", "steam_settings/steam_appid.txt"])
      inspect(path.join(directory, relative), "steam-appid-file", text => {
        const value = positiveAppId(text);
        if (!value) throw new Error("steam_appid.txt must contain one positive application ID.");
        return [{ value }];
      });
    inspect(path.join(directory, "SmartSteamEmu.ini"), "steam-config", text => iniIds(text, ["smartsteamemu"], ["appid"]));
    inspect(path.join(directory, "steam_api.ini"), "steam-config", text => iniIds(text, ["steam"], ["appid"]));
    inspect(path.join(directory, "steam_settings/configs.app.ini"), "steam-config", text => iniIds(text, ["app::general"], ["appid"]));
  }
  if (gen8SteamAppId !== undefined && gen8SteamAppId !== null) {
    if (!Number.isInteger(gen8SteamAppId) || gen8SteamAppId < -0x80000000 || gen8SteamAppId > 0x7fffffff)
      errors.push({ kind: "gamemaker-gen8", message: "GEN8 Steam identity must be its inspected signed 32-bit value." });
    else if (gen8SteamAppId !== 0) evidence.push({ kind: "gamemaker-gen8", value: Math.abs(gen8SteamAppId), rawSignedValue: gen8SteamAppId });
  }
  if (appManifestPath) {
    if (!path.isAbsolute(appManifestPath) || !path.isAbsolute(manifestRoot || "")) throw new Error("An explicitly scoped application manifest path and root are required.");
    const scope = fs.realpathSync(manifestRoot), name = /^appmanifest_(\d{1,10})\.acf$/i.exec(path.basename(appManifestPath));
    if (!name || !within(scope, fs.realpathSync(appManifestPath))) throw new Error("Choose an explicit Steam application manifest inside its source root.");
    inspect(appManifestPath, "steam-appmanifest", text => {
      const result = parseAppManifest(text);
      if (positiveAppId(name[1]) !== result.value) throw new Error("Steam application manifest filename and AppState ID disagree.");
      return [result];
    }, scope);
  }
  const values = [...new Set(evidence.map(item => item.value))];
  const status = values.length > 1 ? "conflict" : values.length === 1 ? "found" : errors.length ? "invalid" : "missing";
  return { value: values.length === 1 ? values[0] : null, status, evidence, errors };
}

module.exports = { MAX_METADATA_BYTES, positiveAppId, parseAppManifest, readAppManifest, readGameAppId };
