// Current native save configuration facts. Read-only; shared by save browsing
// and one-time released-data recovery. No launcher save policy or old layouts.
const fs = require("node:fs");
const path = require("node:path");

const MAX_CONFIG_BYTES = 64 * 1024;

function readConfig(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    if (!fs.fstatSync(fd).isFile()) throw Error("Native save configuration is not a regular file.");
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_CONFIG_BYTES || bytes.subarray(0, length).includes(0)) throw Error("Native save configuration exceeds its size limit.");
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// system3-sdl2 461673b config.cpp:73–81,177–210: literal trimmed values,
// no quote/comment stripping, case-insensitive keys in the config section.
function system3SaveRoot(root) {
  const bytes = readConfig(path.join(root, "system3.ini"));
  if (!bytes) return root;
  let config = false, savedir = "";
  const trim = text => text.replace(/^[ \t\v\f\r\n]+|[ \t\v\f\r\n]+$/g, "");
  for (const line of bytes.toString("latin1").split("\n")) {
    if (Buffer.byteLength(line, "latin1") > 254) throw Error("System3 configuration uses native split-line parsing.");
    if (line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]/)?.[1];
    if (section) {
      if (section.toLowerCase() === "config") config = true;
      else if (section.toLowerCase() === "string") config = false;
      continue;
    }
    if (!config) continue;
    const equal = line.indexOf("=");
    if (equal < 0 || trim(line.slice(0, equal)).toLowerCase() !== "savedir") continue;
    savedir = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(trim(line.slice(equal + 1)), "latin1")).replace(/\\/g, "/");
  }
  // A suffix needs the effective native GameId; do not guess it from a title.
  if (savedir.endsWith("@")) throw Error("System3 savedir @ requires the effective runtime GameId.");
  return path.resolve(root, savedir || ".");
}

// xsystem4 04333ad / libsys4 20560d4 ini_lexer.l/ini_parser.y: literal strings,
// top-level assignments, lists and Formation blocks. No shell/INI expansion.
function iniStrings(bytes, encoding) {
  if (!bytes) return {};
  const tokens = [], text = bytes.toString("latin1");
  for (let i = 0; i < text.length;) {
    if (/[ \t\r\n]/.test(text[i])) { i++; continue; }
    if (text[i] === ";" || text.slice(i, i + 2) === "//") {
      const newline = text.indexOf("\n", i);
      if (newline < 0) throw Error("Native INI comment lacks its newline terminator.");
      i = newline + 1; continue;
    }
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0 || text.slice(i + 1, end).includes("\n")) throw Error("Unterminated native INI string.");
      tokens.push({ type: "string", value: text.slice(i + 1, end) }); i = end + 1; continue;
    }
    const word = text.slice(i).match(/^[A-Za-z]+[A-Za-z0-9_-]*/)?.[0];
    if (word) { tokens.push({ type: word === "Formation" ? "formation" : ["true", "false"].includes(word) ? "boolean" : "identifier", value: word }); i += word.length; continue; }
    const number = text.slice(i).match(/^\d+(?:\.\d+)?/)?.[0];
    if (number) { tokens.push({ type: "number", value: number }); i += number.length; continue; }
    if ("{}[]=,".includes(text[i])) { tokens.push({ type: text[i++] }); continue; }
    throw Error("Unsupported native INI token in save configuration.");
  }
  let position = 0;
  const result = {}, relevant = new Set(["GameName", "CodeName", "SaveFolder", "save-folder"]);
  const take = type => { const token = tokens[position++]; if (token?.type !== type) throw Error("Invalid native INI save configuration."); return token; };
  function value(depth) {
    if (depth > 32) throw Error("Native INI nesting exceeds its size limit.");
    if (tokens[position]?.type === "{") {
      position++;
      if (tokens[position]?.type !== "}") list(depth + 1, true);
      take("}"); return { type: "list" };
    }
    const token = tokens[position++];
    if (!["string", "number", "boolean"].includes(token?.type)) throw Error("Invalid native INI value.");
    return token;
  }
  function list(depth, trailing = false) {
    const values = [value(depth)];
    while (tokens[position]?.type === ",") {
      position++; if (tokens[position]?.type === "}") {
        if (!trailing) throw Error("Native INI trailing comma requires a braced list.");
        break;
      }
      values.push(value(depth));
    }
    return values;
  }
  function entries(nested = false, depth = 0) {
    if (depth > 32) throw Error("Native INI nesting exceeds its size limit.");
    while (position < tokens.length && tokens[position].type !== "}") {
      if (tokens[position].type === "formation") {
        position++; take("string"); take("{"); entries(true, depth + 1); take("}"); continue;
      }
      const name = take("identifier").value;
      let indexed = false;
      if (tokens[position]?.type === "[") {
        position++; if (take("number").value.includes(".")) throw Error("Native INI list index must be an integer.");
        take("]"); indexed = true;
      }
      take("="); const values = list(0);
      if (!nested && relevant.has(name)) {
        if (indexed || values.length !== 1 || values[0].type !== "string") throw Error("Native save path is not a scalar string.");
        result[name] = new TextDecoder(encoding, { fatal: true }).decode(Buffer.from(values[0].value, "latin1"));
      }
    }
  }
  entries(); if (position !== tokens.length) throw Error("Unbalanced native INI configuration.");
  return result;
}

function system4SaveRoot(root, environment) {
  const config = iniStrings(readConfig(path.join(root, "System40.ini")), "shift_jis");
  if (!config.CodeName) throw Error("System4 CodeName is unavailable.");
  const home = environment.XSYSTEM4_HOME || (environment.XDG_DATA_HOME ? environment.XDG_DATA_HOME + "/xsystem4" : environment.HOME ? environment.HOME + "/.xsystem4" : root);
  const homeRoot = path.resolve(root, home);
  // Native get_save_path concatenates these components; a leading slash in
  // GameName/SaveFolder does not discard the native home prefix.
  let destination = path.resolve(root, home + "/" + (config.GameName ?? config.CodeName) + "/" + (config.SaveFolder ?? "SaveData"));
  const global = iniStrings(readConfig(path.join(homeRoot, ".xsys4rc")), "utf-8");
  if (Object.hasOwn(global, "save-folder")) destination = path.resolve(root, global["save-folder"]);
  const game = iniStrings(readConfig(path.join(root, ".xsys4rc")), "utf-8");
  if (Object.hasOwn(game, "save-folder")) destination = path.resolve(root, game["save-folder"]);
  return destination;
}

// xsystem35 82c8b76 profile.c:76–146 loads HOME then local .xsys35rc.
// Whitespace before ':' and control bytes are removed; values are literal.
function system35SaveLocation(root, environment) {
  let savedir;
  for (const file of [environment.HOME && path.join(environment.HOME, ".xsys35rc"), path.join(root, ".xsys35rc")].filter(Boolean)) {
    const bytes = readConfig(file);
    if (!bytes) continue;
    for (const line of bytes.toString("latin1").split("\n")) {
      if (line.length > 254) throw Error("System35 configuration uses native split-line parsing.");
      let parsed = "", afterColon = false;
      for (const ch of line) {
        if (ch === ":") afterColon = true;
        if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || !afterColon && /[ \t\v\f\r]/.test(ch)) continue;
        parsed += ch;
      }
      if (!parsed || parsed.startsWith("#")) continue;
      const colon = parsed.indexOf(":");
      if (colon < 0) break; // Native parsing keeps prior entries and stops this file.
      if (parsed.slice(0, colon) === "savedir") savedir = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parsed.slice(colon + 1).replace(/^[ \t\v\f\r]+/, ""), "latin1"));
    }
  }
  if (savedir === undefined) return { directory: root, configured: false };
  if (!savedir) throw Error("Empty System35 savedir selects root-level native slot paths.");
  if (savedir.startsWith("~")) {
    if (!environment.HOME) throw Error("System35 tilde save directory requires HOME.");
    savedir = environment.HOME + savedir.slice(1);
  }
  return { directory: path.resolve(root, savedir), configured: true };
}

module.exports = { system3SaveRoot, system35SaveLocation, system4SaveRoot };
