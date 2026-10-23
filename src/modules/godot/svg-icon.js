const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Icons = require("../../core/icon-utils"), Writable = require("../shared/writable-input");
const GameData = require("../shared/game-data"), {runIconCommand} = require("../../core/icon-extraction");
const script = path.join(__dirname, "svg-icon.jxa"), renderer = fs.readFileSync(script);
const MAX_BYTES = 256 * 1024;
function safeSvg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return false;
  let text;
  try {text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {return false;}
  text = text.replace(/^\s*<\?xml\s[^?]*\?>/i, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (!/^\s*<svg\b/i.test(text) || /<!|<\?|[&\\@]/.test(text) ||
      /<\s*(?:[\w.-]+:)?(?:script|foreignObject|image|feImage|iframe|object|embed|set|animate\w*|discard)\b/i.test(text) ||
      /\bon[a-z][\w:.-]*\s*=/i.test(text) ||
      /\b(?:xml:)?base\s*=/i.test(text)) return false;
  for (const match of text.matchAll(/\b(?:[\w.-]+:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi))
    if (!/^["']#[\w:.-]+["']$/.test(match[1])) return false;
  const urls = [...text.matchAll(/\burl\s*\(([^)]*)\)/gi)];
  return urls.length === (text.match(/\burl\s*\(/gi) || []).length && urls.every(match =>
    /^(?:#[\w:.-]+|"#[\w:.-]+"|'#[\w:.-]+')$/.test(match[1].trim()));
}
async function prepare(metadata, entry, {userDataDir, signal, runCommand = runIconCommand} = {}) {
  signal?.throwIfAborted();
  if (!metadata?.iconPath || !/\.svg$/i.test(metadata.iconPath) || !path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry?.gameId || "")) return null;
  try {
    const canonical = fs.realpathSync(metadata.iconPath), relative = path.relative(metadata.root, canonical);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
    const stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return null;
    const bytes = fs.readFileSync(canonical);
    return await prepareBytes(bytes, entry, {userDataDir, signal, runCommand, sourceRoot: metadata.root});
  } catch {signal?.throwIfAborted();return null;}
}
async function prepareBytes(bytes, entry, {userDataDir, signal, runCommand = runIconCommand, sourceRoot} = {}) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry?.gameId || "")) return null;
  let temporary;
  try {
    if (!safeSvg(bytes)) return null;
    const identity = crypto.createHash("sha256").update("godot-svg-v1").update(renderer).update(bytes).digest("hex");
    const directory = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot"), "icons");
    if (sourceRoot) {
      const sourceRelative = path.relative(sourceRoot, directory);
      if (sourceRelative !== ".." && !sourceRelative.startsWith(".." + path.sep) && !path.isAbsolute(sourceRelative)) return null;
    }
    Writable.assertOwnDirectory(userDataDir, directory);
    const target = path.join(directory, `project-svg-${identity}.png`);
    const cached = fs.lstatSync(target, {throwIfNoEntry: false});
    if (cached?.isFile() && cached.size <= 1024 * 1024 && Icons.isSupportedImageBuffer(fs.readFileSync(target))) return target;
    temporary = fs.mkdtempSync(path.join(directory, ".svg-"));
    const snapshot = path.join(temporary, "icon.svg"), output = path.join(temporary, "icon.png"), executableScript = path.join(temporary, "render.jxa");
    fs.writeFileSync(snapshot, bytes, {flag: "wx", mode: 0o400});
    // External tools cannot open Electron's virtual app.asar paths.
    fs.writeFileSync(executableScript, renderer, {flag: "wx", mode: 0o400});
    const env = {...process.env};for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_|FSR4_)/.test(key)) delete env[key];
    await runCommand("/usr/bin/osascript", ["-l", "JavaScript", executableScript, snapshot, output],
      {signal, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 65536, env});
    signal?.throwIfAborted();
    const result = fs.statSync(output);
    if (!result.isFile() || result.size > 1024 * 1024) return null;
    const png = fs.readFileSync(output);
    if (!Icons.isSupportedImageBuffer(png) || png.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
        png.readUInt32BE(16) > 256 || png.readUInt32BE(20) > 256) return null;
    Writable.atomicWrite(target, png, {root: userDataDir});return target;
  } catch {signal?.throwIfAborted();return null;}
  finally {if (temporary) await fs.promises.rm(temporary, {recursive: true, force: true});}
}
module.exports = {prepare, prepareBytes, safeSvg};
