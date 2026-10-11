const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const Native = require("../shared/runtime/local-native");
const GameData = require("../shared/game-data");
const XP3 = require("./xp3");
const { decode, signalUnavailableOptionalPlugins } = require("./script");
const PROFILE = "kag3-sdl2-v1";
const POLYFILL_PIN = "fe6d40e9a1667293ebb053af7f06374b7dac9292";
const KNOWN_GAME = { exe: "8fe682bc2c4b6b9f50a11be0f1fba7c101396f27e30f43a61f6923e7918c8027", patch: "d4a32c185d47ca1c8c4fcd82124a0fb1c1dbec09bce9f7f8b71cfbaefb4b3491" };
function regular(file) { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error("KiriKiri source and resource files must be regular files."); return st; }
function mkdir(root, directory) {
  let current = root;
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("KiriKiri script path is outside launcher storage.");
  for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); if (!fs.existsSync(current)) fs.mkdirSync(current); const st = fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("KiriKiri script directories cannot use symlinks."); }
  return current;
}
function resources(userRoot) {
  const source = path.join(__dirname, "resources", "kag3-polyfill"), manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  if (manifest.schema !== 1 || manifest.upstreamRevision !== POLYFILL_PIN) throw new Error("KAG3 compatibility files do not match the required version.");
  const root = mkdir(userRoot, path.join(userRoot, "runtimes", "kag3-polyfill", POLYFILL_PIN));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Unsafe KAG3 resource filename.");
    const input = path.join(source, name), output = path.join(root, name);
    regular(input);
    if (fs.statSync(input).size !== expected.size || Native.hashFile(input) !== expected.sha256) throw new Error(`KAG3 packaged resource checksum differs: ${name}`);
    if (fs.existsSync(output)) { regular(output); if (Native.hashFile(output) !== expected.sha256) throw new Error(`KAG3 installed resource checksum differs: ${name}`); }
    else fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
  }
  return { root, manifest };
}
function guardUnavailableAudio(text) {
  // Match the stock KAG3 class definitions, then bound their complete bodies.
  // This does not substitute a working MIDI/CDDA implementation.
  return text.replace(/class\s+(KAGMIDISoundBuffer|KAGCDDASoundBuffer)\s+extends\s+(?:MIDISoundBuffer|CDDASoundBuffer)\s*,\s*KAGSoundBuffer\s*\{[\s\S]*?\n\}/g, "// MacLauncher: unavailable MIDI/CDDA class omitted from this owned KAG3 copy.");
}
function skipLegacyOpeningWait(text) {
  // The reviewed English release puts the wait beside its opening Wave tag.
  // Leave later sound waits intact; they are part of the game's scene timing.
  return text.replace(/(\[playse\s+buf=2\s+storage=wa\.wav\])\[ws\s+canskip=true\]/, "$1");
}
function silenceLegacyMidiTags(text) {
  const midi = /\bstorage\s*=\s*(?:"[^"\r\n]{1,256}\.mid"|'[^'\r\n]{1,256}\.mid'|[^\s\]\r\n"']{1,256}\.mid)(?=\s|$)/i;
  return text.replace(/\[(?:playbgm|fadeinbgm)\b([^\]\r\n]{0,1024})\]/gi,
    (tag, options) => midi.test(options) ? "[stopbgm]" : tag)
    .replace(/^([\t ]*)@(?:playbgm|fadeinbgm)\b([^\r\n]{0,1024})/gim,
      (tag, indentation, options) => midi.test(options) ? `${indentation}@stopbgm` : tag);
}
function disambiguateMessageDrawFace(text) {
  // Stock MessageLayer uses "face" for its font name, shadowing Layer.face in
  // this TJS host. Its province clear must select the inherited native drawing
  // property; otherwise colorRect paints an opaque image over the background.
  if (!/\bclass\s+MessageLayer\s+extends\s+KAGLayer\b/.test(text) || !/\bvar\s+face\s*;/.test(text)) return text;
  return text.replace(/^([\t ]*)face([\t ]*=[\t ]*df(?:Auto|Province|Alpha|AddAlpha|Opaque|Mask)[\t ]*;)/gm, "$1super.face$2");
}
function hostPrelude(originalRoot) {
  const root = JSON.stringify(fs.realpathSync(originalRoot).replace(/\\/g, "/") + "/");
  // Host properties preserve source strings, comments and embedded KAG
  // expressions. Native runtime resource paths are unaffected.
  return `{
if(typeof(global.__MacLauncherKagHost) !== "Object") global.__MacLauncherKagHost = %[
  "assetPath" => ${root}, "dataPath" => global.System.dataPath, "setArgument" => global.System.setArgument
];
property _MacLauncherExePath { getter { return global.__MacLauncherKagHost.assetPath; } }
&global.System.exePath = &_MacLauncherExePath;
global.System.setArgument = function(name, value) {
  var host = global.__MacLauncherKagHost;
  return host.setArgument(name, name == "-datapath" ? host.dataPath : value);
};
if(typeof(global.System.adjustMonitor) === "Object" && typeof(global.AdjustMoni) !== "Object") global.AdjustMoni = global.System.adjustMonitor;
}`;
}
function selectLanguageArchives(files, primary, context) {
  const initial = primary.members.get("system/initialize.tjs") || primary.members.get("initialize.tjs");
  if (!initial || initial.size > 512 * 1024) return { files, language: null };
  let text;
  try { text = decode(XP3.readScript(primary, initial, { allowPlainProtected: true })); } catch { return { files, language: null }; }
  const declaration = text.match(/\bvar\s+(\w+)\s*=\s*System\.getArgument\(["'](-[A-Za-z]+)["']\)/);
  if (!declaration) return { files, language: null };
  const variable = declaration[1], argument = declaration[2];
  const archivePattern = new RegExp(`System\\.exePath\\s*\\+\\s*["']([A-Za-z0-9_-]+_)["']\\s*\\+\\s*${variable}\\s*\\+\\s*["']\\.xp3["']`);
  const prefix = text.match(archivePattern)?.[1];
  const fallback = text.match(new RegExp(`else\\s*\\{[^{}]{0,500}\\b${variable}\\s*=\\s*["']([a-z]{2,3})["']`))?.[1];
  if (!prefix || !fallback) return { files, language: null };
  const available = files.map(file => path.basename(file)).map(name => new RegExp(`^${prefix}([a-z]{2,3})\\.xp3$`, "i").exec(name)?.[1]?.toLowerCase()).filter(Boolean);
  if (!available.length || !available.includes(fallback)) return { files, language: null };
  const requested = (context.runtimeSettings?.args || []).find(value => typeof value === "string" && value.startsWith(argument + "="))?.slice(argument.length + 1);
  let language = fallback;
  if (requested) {
    for (const branch of text.matchAll(/if\s*\(([^)]{1,500})\)\s*\{([^{}]{0,500})/g)) {
      const selected = branch[2].match(new RegExp(`\\b${variable}\\s*=\\s*["']([a-z]{2,3})["']`))?.[1];
      const aliases = [...branch[1].matchAll(new RegExp(`\\b${variable}\\s*==\\s*["']([^"']+)["']`, "g"))].map(match => match[1]);
      if (selected && aliases.includes(requested)) { language = selected; break; }
    }
    if (available.includes(requested)) language = requested;
  }
  if (!available.includes(language)) throw new Error("The selected script language archive is missing.");
  return { files: files.filter(file => {
    const name = path.basename(file);
    const localized = new RegExp(`^${prefix}([a-z]{2,3})\\.xp3$`, "i").exec(name);
    const patch = /^patch_([a-z]{2,3})\d*\.xp3$/i.exec(name);
    return (!localized || localized[1].toLowerCase() === language) && (!patch || patch[1].toLowerCase() === language);
  }), language: { selected: language, available: [...new Set(available)], argument, evidence: `${primary.file}!/${initial.name}` } };
}
function sourceArchives(entry, context) {
  if (entry.moduleData?.protectedEntries && entry.moduleData?.xp3ContentProfile !== "verified-plain-v1") throw new Error("Protected XP3 games require unsupported title-specific filters.");
  const root = fs.realpathSync(entry.contentRootDir), selected = entry.moduleData?.archivePath;
  if (!selected) return null;
  const primary = fs.realpathSync(selected);
  if (path.dirname(primary) !== root) throw new Error("Selected XP3 archive is outside the imported game directory.");
  const rest = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile() && /\.xp3$/i.test(item.name) && path.join(root, item.name) !== primary)
    .sort((a, b) => { const patch = n => /^patch\d*\.xp3$/i.test(n) ? 1 : 0; return patch(a.name) - patch(b.name) || a.name.localeCompare(b.name, "en", { numeric: true }); });
  if (rest.length > 32) throw new Error("The XP3 archive count exceeds supported limits.");
  const files = [primary, ...rest.map(item => path.join(root, item.name))];
  regular(primary);
  const base = XP3.inspectArchive(primary), localized = selectLanguageArchives(files, base, context);
  return { archives: localized.files.map(file => { regular(file); return { ...(file === primary ? base : XP3.inspectArchive(file)), sha256: Native.hashFile(file) }; }), language: localized.language };
}
function manifestMatches(directory, identity, aliases) {
  try {
    const file = path.join(directory, "profile.json"); regular(file);
    if (fs.statSync(file).size > 1024 * 1024) return false;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.schema !== 1 || record.profile !== PROFILE || record.identity !== identity || record.polyfillRevision !== POLYFILL_PIN) return false;
    if (!record.files || typeof record.files !== "object" || Array.isArray(record.files)) return false;
    const files = Object.entries(record.files);
    if (files.length > 2048 || !files.some(([name]) => /^startup\.tjs$/i.test(name)) ||
      !files.some(([name]) => /^(?:system\/)?initialize\.tjs$/i.test(name))) return false;
    for (const [relative, sha256] of files) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(sha256)) return false;
      const target = path.join(directory, relative); regular(target); if (Native.hashFile(target) !== sha256) return false;
    }
    for (const [name, target] of Object.entries(aliases)) if (!fs.lstatSync(path.join(directory, name)).isSymbolicLink() || fs.readlinkSync(path.join(directory, name)) !== target) return false;
    for (const [name, target] of Object.entries(record.scriptAliases || {})) {
      if (path.basename(name) !== name || !record.files[target] || !/\.(tjs|ks)$/i.test(name) ||
          !fs.lstatSync(path.join(directory, name)).isSymbolicLink() || fs.readlinkSync(path.join(directory, name)) !== target) return false;
    }
    return record;
  } catch { return false; }
}
function prepareGame(entry, context) {
  const sources = sourceArchives(entry, context);
  if (!sources) return null; // Already-native loose projects retain their original route.
  const { archives, language } = sources;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.gameId || "")) throw new Error("Import this KiriKiri game before preparing its owned compatibility files.");
  const adapterSha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename))
    .update(fs.readFileSync(path.join(__dirname, "xp3.js"))).update(fs.readFileSync(path.join(__dirname, "script.js"))).digest("hex");
  const identity = crypto.createHash("sha256").update(JSON.stringify({ profile: PROFILE, adapterSha256, polyfill: POLYFILL_PIN, language, sources: archives.map(item => [item.file, item.sha256]) })).digest("hex");
  if (fs.existsSync(context.userDataDir)) {
    const userRoot = fs.realpathSync(context.userDataDir);
    const destination = path.join(GameData.resolveGameModuleDir(userRoot, entry.gameId, "kirikiri"), "profiles", `${PROFILE}-${identity.slice(0, 24)}`);
    const previous = manifestMatches(destination, identity, { system_polyfill: path.join(userRoot, "runtimes", "kag3-polyfill", POLYFILL_PIN) });
    if (previous) { resources(userRoot); return { ...previous, preparedRoot: destination, cached: true }; }
  }
  const scripts = new Map(); let scriptBytes = 0;
  for (const archive of archives) for (const member of archive.members.values()) if (/\.(tjs|ks)$/i.test(member.name)) {
    // XP3's protected bit also marks ordinary readable storage. Allow only
    // independently checksum-verified plaintext scripts; real encrypted bytes
    // still require an explicitly supported content filter.
    const bytes = XP3.readScript(archive, member, { allowPlainProtected: true }); scriptBytes += bytes.length;
    if (scriptBytes > XP3.LIMITS.scriptsTotal || scripts.size >= 2048 && !scripts.has(member.name.toLowerCase())) throw new Error("KiriKiri script size or count exceeds supported limits.");
    const text = decode(bytes);
    if (text.includes("\0")) throw new Error("Encoded/encrypted KiriKiri script is not supported by this profile.");
    scripts.set(member.name.toLowerCase(), { name: member.name, text, archive: archive.file });
  }
  const initialize = scripts.get("system/initialize.tjs") || scripts.get("initialize.tjs"), startup = scripts.get("startup.tjs");
  if (!startup || !initialize || !/\bkagVersion\s*=\s*["']3\./.test(initialize.text)) return null;
  const kagVersion = initialize.text.match(/\bkagVersion\s*=\s*["'](3\.[^"'\r\n]{1,70})["']/)?.[1] || null;
  fs.mkdirSync(context.userDataDir, { recursive: true });
  const userRoot = fs.realpathSync(context.userDataDir), polyfill = resources(userRoot);
  const known = archives.some(item => item.sha256 === KNOWN_GAME.exe) && archives.some(item => item.sha256 === KNOWN_GAME.patch);
  const parent = mkdir(userRoot, path.join(GameData.resolveGameModuleDir(userRoot, entry.gameId, "kirikiri"), "profiles")), destination = path.join(parent, `${PROFILE}-${identity.slice(0, 24)}`);
  const aliases = { system_polyfill: polyfill.root }, previous = manifestMatches(destination, identity, aliases);
  if (previous) return { ...previous, preparedRoot: destination, cached: true };
  if (fs.existsSync(destination)) throw new Error("KiriKiri script cache changed; reset the cache before retrying.");
  const staging = path.join(parent, `.prepare-${randomUUID()}`); fs.mkdirSync(staging);
  const changes = [], warnings = ["Windows plugins and native menus are unsupported."];
  try {
    for (const script of scripts.values()) {
      let text = script.text;
      const optionalPlugins = signalUnavailableOptionalPlugins(text);
      if (optionalPlugins !== text) changes.push({ file: script.name, operation: "preserve publisher catch fallback for optional unsupported Windows plugins" });
      text = optionalPlugins;
      if (/^(?:system\/)?config\.tjs$/i.test(script.name)) {
        text = text.replace(/(^[\t ]*;?saveDataLocation\s*=\s*)[^;\r\n]+/gm, "$1System.dataPath");
        changes.push({ file: script.name, operation: "route KAG saves through System.dataPath" });
        if (known) text = text.replace(/(^[\t ]*;?type\s*=\s*)["'](?:MIDI|CDDA)["']/gm, '$1"Wave"');
      }
      if (/^(?:system\/)?bgm\.tjs$/i.test(script.name)) { const guarded = guardUnavailableAudio(text); if (guarded !== text) changes.push({ file: script.name, operation: "omit stock unsupported MIDI/CDDA class declarations" }); text = guarded; }
      if (/^(?:system\/)?messagelayer\.tjs$/i.test(script.name)) {
        const adapted = disambiguateMessageDrawFace(text);
        if (adapted !== text) changes.push({ file: script.name, operation: "select inherited drawing face while preserving the MessageLayer font variable" });
        text = adapted;
      }
      if (known && /\.ks$/i.test(script.name)) {
        const muted = silenceLegacyMidiTags(text);
        if (muted !== text) changes.push({ file: script.name, operation: "omit literal MIDI music tags unsupported by SDL Wave buffers" });
        text = muted;
      }
      if (known && /^(?:scenario\/)?first\.ks$/i.test(script.name)) {
        const adapted = skipLegacyOpeningWait(text);
        if (adapted !== text) changes.push({ file: script.name, operation: "known old English release: skip opening sound-completion wait" });
        text = adapted;
      }
      if (script.name.toLowerCase() === "startup.tjs") {
        const sourcePaths = [];
        for (const archive of archives) { const dirs = new Set([""]); for (const item of archive.members.values()) { const at = item.name.lastIndexOf("/"); if (at >= 0) dirs.add(item.name.slice(0, at + 1)); } for (const dir of dirs) sourcePaths.push(`Storages.addAutoPath(${JSON.stringify(archive.file.replace(/\\/g, "/") + ">" + dir)});`); }
        text = `${sourcePaths.join("\n")}\nScripts.execStorage("system_polyfill/PolyfillInitialize.tjs");\n${hostPrelude(entry.contentRootDir)}\n${text}`;
        changes.push({ file: script.name, operation: "present original executable-relative asset paths and preserve the managed native datapath" });
      }
      const output = path.join(staging, script.name); mkdir(staging, path.dirname(output)); fs.writeFileSync(output, `\ufeff${text}`, { flag: "wx", mode: 0o444 });
      changes.push({ file: script.name, operation: "extract script only and transcode UTF-8 BOM" });
    }
    if (known) warnings.push("MIDI music muted; opening sound wait skipped.");
    for (const [name, target] of Object.entries(aliases)) fs.symlinkSync(target, path.join(staging, name), "dir");
    // KAG often loads script basenames after adding original archive paths.
    // Root aliases resolve to private adapted scripts without duplicating
    // their bytes, while all images/audio remain in the original archives.
    const scriptAliases = {};
    for (const script of scripts.values()) {
      const basename = path.basename(script.name);
      if (basename !== script.name && !scripts.has(basename.toLowerCase())) scriptAliases[basename] = script.name;
    }
    for (const [name, target] of Object.entries(scriptAliases)) fs.symlinkSync(target, path.join(staging, name));
    const files = {}; for (const script of scripts.values()) files[script.name] = Native.hashFile(path.join(staging, script.name));
    const record = { schema: 1, profile: PROFILE, identity, adapterSha256, polyfillRevision: POLYFILL_PIN, sourceArchives: archives.map(item => ({ file: item.file, sha256: item.sha256, bytes: item.size })), files, changes, warnings,
      kagVersion, language, scriptAliases, versionSource: `${initialize.archive}!/${initialize.name} explicit script version constant after bounded extraction`,
      contentProfile: archives.some(archive => archive.protectedEntries) ? "verified-plain-v1" : "plain",
      compatibility: known ? "Legacy English KAG3 compatibility mode; limited audio" : "KAG3 SDL2 compatibility mode", preparedAt: new Date().toISOString(), scriptBytes };
    fs.writeFileSync(path.join(staging, "profile.json"), JSON.stringify(record, null, 2)); fs.renameSync(staging, destination);
    return { ...record, preparedRoot: destination, cached: false };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { PROFILE, POLYFILL_PIN, prepareGame, selectLanguageArchives, hostPrelude, decode, guardUnavailableAudio, skipLegacyOpeningWait, silenceLegacyMidiTags, disambiguateMessageDrawFace };
