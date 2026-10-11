const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readArchiveText } = require("../detect");
const Consumer = require("../../shared/runtime/steamworks/native-consumer-probe");
const AppId = require("../../shared/runtime/steamworks/app-id");

const MAX_SOURCE_BYTES = 512 * 1024;
const CANDIDATES = ["luasteam.dll", "luasteam.so", "native/luasteam.dll", "native/luasteam.so", "lib/luasteam.so"];
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
function identity(file) {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String).join(":");
  } catch { return null; }
}
function originalSource(entry) {
  const data = entry?.moduleData || {}, kind = data.sourceKind;
  const target = data.embeddedLovePath || data.launchTargetPath || data.packagedPath || entry?.gamePath;
  if (!path.isAbsolute(target || "") || !["source-dir", "windows-fused", "linux-fused", "love-archive", "app-bundle"].includes(kind)) return null;
  const directory = kind === "source-dir" ? target : path.dirname(target);
  return { directory, scriptPath: kind === "source-dir" ? path.join(target, "main.lua") : target, archive: kind !== "source-dir" };
}
function analyzeSource(text) {
  // Tokenize instead of matching inside comments or quoted sample code. This
  // deliberately recognizes concrete require/init calls, not arbitrary Lua.
  const source = String(text || ""), tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const rest = source.slice(cursor);
    if (/^\s/.test(rest)) { cursor++; continue; }
    const comment = rest.startsWith("--");
    const long = /^(?:--)?\[(=*)\[/.exec(rest);
    if (long) {
      const end = source.indexOf("]" + long[1] + "]", cursor + long[0].length);
      if (!comment) tokens.push({ value: "", string: true });
      cursor = end < 0 ? source.length : end + long[1].length + 2; continue;
    }
    if (comment) { const end = source.indexOf("\n", cursor); cursor = end < 0 ? source.length : end + 1; continue; }
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0]; let value = "", closed = false; cursor++;
      while (cursor < source.length) {
        const char = source[cursor++];
        if (char === quote) { closed = true; break; }
        if (char === "\\") { value += source[cursor++] || ""; } else value += char;
      }
      tokens.push({ value: closed ? value : "", string: true }); continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(rest);
    tokens.push({ value: word ? word[0] : rest[0], string: false }); cursor += word ? word[0].length : 1;
  }
  const is = (index, value) => tokens[index]?.value === value && !tokens[index].string;
  const literal = index => tokens[index]?.string && tokens[index].value === "luasteam";
  const names = [], optional = tokens.some((token, index) => !token.string && token.value === "pcall" &&
    is(index + 1, "(") && is(index + 2, "require") && is(index + 3, ",") && literal(index + 4));
  for (let index = 0; index < tokens.length - 4; index++) {
    const token = tokens[index];
    if (!token.string && /^[A-Za-z_]\w*$/.test(token.value) && is(index + 1, "=") && is(index + 2, "require") &&
        (literal(index + 3) || (is(index + 3, "(") && literal(index + 4) && is(index + 5, ")")))) names.push(token.value);
  }
  if (!names.length) return { required: false, optional, apiStyle: null };
  const call = method => tokens.some((token, index) => !token.string && names.includes(token.value) &&
    is(index + 1, ".") && is(index + 2, method) && is(index + 3, "("));
  const lower = call("init"), upper = call("Init");
  return { required: true, optional: false, apiStyle: lower && !upper ? "lowercase" : upper && !lower ? "PascalCase" : "unknown" };
}

/** Cached, bounded original-game evidence. Optional pcall never activates setup. */
function inspect(entry) {
  const source = originalSource(entry);
  if (!source) return null;
  const candidates = CANDIDATES.map(relative => path.join(source.directory, relative));
  const signature = JSON.stringify([source.scriptPath, identity(source.scriptPath), source.directory,
    ...candidates.map(file => [file, identity(file)])]);
  const previous = entry?.moduleData?.luaSteamEvidence;
  if (previous?.schemaVersion === 1 && previous.signature === signature) return previous;
  let script = null;
  try {
    if (source.archive) script = readArchiveText(source.scriptPath, "main.lua", MAX_SOURCE_BYTES);
    else {
      const stat = fs.lstatSync(source.scriptPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_SOURCE_BYTES) script = fs.readFileSync(source.scriptPath, "utf8");
    }
  } catch { /* Unknown source is not promoted to a required native dependency. */ }
  const analysis = analyzeSource(script);
  const result = { schemaVersion: 1, signature, ...analysis, gameRoot: source.directory,
    sourceSha256: script == null ? null : digest(script), consumers: [] };
  if (result.required) {
    for (const file of candidates) {
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) continue;
        const probe = Consumer.inspectNativeSteamConsumer(file);
        if (!probe.steamDependencies?.length) continue;
        result.consumers.push({ filePath: file, format: probe.format, architectures: probe.architectures,
          symbols: [...new Set(probe.steamDependencies.flatMap(item => item.symbols))].sort() });
      } catch { /* A filename alone does not prove a compatible native ABI. */ }
    }
  }
  entry.moduleData = { ...entry.moduleData, luaSteamEvidence: result };
  return result;
}

function requiredIdentity(entry) {
  const evidence = inspect(entry);
  if (!evidence?.required) return null;
  if (evidence.apiStyle !== "lowercase" || !evidence.consumers.length)
    throw Object.assign(new Error("This game's LuaSteam native API version is not supported yet."), { code: "LUA_STEAM_ABI_UNVERIFIED" });
  const appId = AppId.readGameAppId({ gameRoot: evidence.gameRoot });
  if (appId.status !== "found")
    throw Object.assign(new Error("The game's Steam application ID could not be found."), { code: "STEAM_API_APP_ID_REQUIRED" });
  return { evidence, appId };
}

module.exports = { inspect, requiredIdentity, analyzeSource, originalSource, MAX_SOURCE_BYTES };
