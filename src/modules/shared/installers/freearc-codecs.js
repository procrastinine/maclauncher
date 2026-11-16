// Decoder planning follows mac-game-porter (MIT, Copyright (c) 2026 KarmSakha).
// See freearc-notices.txt for the complete notice.
const { installerError } = require("./inno-header");
const BUILTINS = new Set(["delta", "dispack", "dispack070", "lzma", "lzma2", "exe", "bcj", "dict", "rep", "lzp", "tor", "tornado", "grzip", "mm", "tta", "ppmd", "lz4", "storing"]);
const bad = message => { throw installerError(message, "INSTALLER_FREEARC_DECODER"); };
function parseIni(text) {
  if (typeof text !== "string" || text.length > 1024 * 1024 || text.includes("\0")) bad("The FreeArc decoder configuration is invalid.");
  const result = Object.create(null); let section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      section = undefined; const match = /^\[External compressor:([^\]]+)\]$/i.exec(line);
      if (match) { section = { header: "1" }; for (const name of match[1].split(",").map(n => n.trim().toLowerCase())) { if (!/^[a-z0-9_.-]+$/.test(name) || Object.hasOwn(result, name)) bad("The FreeArc decoder configuration has conflicting methods."); result[name] = section; } }
    } else if (section && line.includes("=")) { const at = line.indexOf("="); section[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim(); }
  }
  return result;
}
function argv(text) {
  if (!text || /[\0\r\n&|<>]/.test(text)) bad("The FreeArc decoder command is invalid.");
  const result = []; let token = "", quote = false, started = false;
  for (const c of text) {
    if (c === '"') { quote = !quote; started = true; }
    else if (/\s/.test(c) && !quote) { if (started) result.push(token); token = ""; started = false; }
    else { token += c; started = true; }
  }
  if (quote) bad("The FreeArc decoder command has unmatched quotes.");
  if (started) result.push(token);
  return result;
}
function leaf(name) {
  if (typeof name !== "string" || !/^[a-z0-9_$ .-]+$/i.test(name) || name === "." || name === ".." || /unarc\.dll/i.test(name)) bad("The FreeArc decoder path is invalid.");
  return name;
}
function split4x4(method) {
  const parts = method.split(":");
  for (let i = 1; i < parts.length; i++) if (!/^\d|^.\d/.test(parts[i])) return parts.slice(i).join(":");
  bad("The 4x4 decoder has no inner method.");
}
function planStage(method, ini, files, depth = 0) {
  if (depth > 8 || typeof method !== "string" || !method || method.length > 4096 || /[\x00-\x1f]/.test(method)) bad("The FreeArc decoder method is invalid.");
  const [name] = method.split(":"), lower = name.toLowerCase();
  if (lower === "srep" && !Object.hasOwn(ini, lower)) bad("This installer doesn't include the SREP decoder its archives need.");
  if (lower === "4x4") return { kind: "4x4", name: lower, method, inner: planStage(split4x4(method), ini, files, depth + 1) };
  if (BUILTINS.has(lower)) return { kind: "native", name: lower, method };
  const found = wanted => files.find(file => file.toLowerCase() === wanted.toLowerCase());
  if (Object.hasOwn(ini, lower)) {
    const section = ini[lower], command = section.unpackcmd;
    if (!command) bad(lower === "srep" ? "This installer doesn't include the SREP decoder its archives need." : "The FreeArc external decoder has no command.");
    const pipe = /<stdin>|<stdout>/i.test(command);
    const cmd = argv(command.replaceAll("{options}", "").replaceAll("{compressor}", name).replace(/<stdin>|<stdout>/gi, ""));
    const exe = leaf(cmd[0]), executable = found(exe) || found(exe + ".exe");
    if (!executable || !/\.exe$/i.test(executable) || /^(?:setup|installer|unarc|cmd|powershell|msiexec)\.exe$/i.test(executable)) bad(lower === "srep" ? "This installer doesn't include the SREP decoder its archives need." : "The required FreeArc decoder executable is missing or is an installer command.");
    cmd[0] = executable;
    let kind = pipe ? "pipe" : "files";
    if (pipe && /^(?:xtool|rtool)/i.test(executable)) {
      const dashes = cmd.map((a, i) => a === "-" ? i : -1).filter(i => i >= 0);
      if (dashes.length < 2) bad("The seekable FreeArc decoder command needs input and output paths.");
      cmd[dashes.at(-2)] = "{in}"; cmd[dashes.at(-1)] = "{out}"; kind = "seek";
    }
    const packed = leaf(section.packedfile || "$$arcpackedfile$$.tmp"), unpacked = leaf(section.datafile || "$$arcdatafile$$.tmp");
    if (kind === "files" && packed.toLowerCase() === unpacked.toLowerCase()) bad("The external decoder input and output paths conflict.");
    return { kind, name: lower, method, cmd, header: section.header !== "0", packed, unpacked };
  }
  const dll = found("cls-" + lower + ".dll");
  if (dll) return { kind: "cls", name: lower, method, dll, parameters: method.slice(name.length + 1) };
  bad("No decoder is available for the FreeArc method: " + method);
}
function planChain(chain, ini = {}, files = []) {
  const parts = String(chain).split("+"); if (parts.length > 32) bad("The FreeArc decoder chain exceeds its limit.");
  return parts.reverse().map(method => planStage(method.trim(), ini, files));
}
const needsWine = stages => stages.some(stage => stage.kind === "4x4" ? needsWine([stage.inner]) : stage.kind !== "native");
module.exports = { BUILTINS, parseIni, argv, planStage, planChain, needsWine };
