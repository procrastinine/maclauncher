const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readGameConfigurationSources } = require("./script-config");

// Read source literals only. Evaluating Ren'Py/Python configuration would execute
// third-party code, and a partial dynamic expression is not a known directory.
function parseSaveDirectoryLiteral(expression) {
  const match = expression.match(/^(r|u|ur|ru)?(["'])((?:\\.|[^\\])*?)\2\s*(?:#.*)?$/i);
  if (!match) return null;
  for (let index = 0; index < match[3].length; index++) {
    if (match[3][index] === "\\") index++;
    else if (match[3][index] === match[2]) return null;
  }
  if (match[1]?.toLowerCase().includes("r")) return match[3];
  let value = "";
  const escapes = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  for (let index = 0; index < match[3].length; index++) {
    const character = match[3][index];
    if (character !== "\\") { value += character; continue; }
    const code = match[3][++index];
    if (Object.hasOwn(escapes, code)) { value += escapes[code]; continue; }
    const width = code === "x" ? 2 : code === "u" ? 4 : code === "U" ? 8 : 0;
    if (width) {
      const digits = match[3].slice(index + 1, index + 1 + width);
      if (digits.length !== width || !/^[0-9a-f]+$/i.test(digits)) return null;
      const point = parseInt(digits, 16);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
      value += String.fromCodePoint(point);
      index += width;
      continue;
    }
    if (/[0-7]/.test(code || "")) {
      const digits = match[3].slice(index).match(/^[0-7]{1,3}/)[0];
      value += String.fromCodePoint(parseInt(digits, 8));
      index += digits.length - 1;
      continue;
    }
    return null;
  }
  return value;
}

function safeSaveDirectoryName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !/[\\\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) && !/^[a-z]:/i.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

function parseSaveDirectoryList(expression) {
  const match = String(expression || "").match(/^\s*([\[(])([\s\S]*)([\])])\s*(?:#.*)?$/);
  if (!match || match[3] !== (match[1] === "[" ? "]" : ")")) return null;
  const values = []; let start = 0, quote = null;
  for (let index = 0; index <= match[2].length; index++) {
    const character = match[2][index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "," || index === match[2].length) {
      const item = match[2].slice(start, index).trim(); start = index + 1;
      if (!item && index === match[2].length) continue;
      const directory = parseSaveDirectoryLiteral(item);
      if (directory == null || !path.isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f\x7f]/.test(directory) || directory.split(/[\\/]/).includes("..")) return null;
      values.push(path.normalize(directory));
      if (values.length > 32) return null;
    }
  }
  return quote ? null : values;
}

function sourceAssignments(text, source, { python = false, unsafeContext = false, keys = ["save_directory", "savedir", "extra_savedirs"] } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 16 || keys.some(key => !/^[a-z_]{1,64}$/.test(key))) throw new Error("Invalid configuration field selection.");
  const field = keys.join("|");
  if (!new RegExp(`\\bconfig\\.(?:${field})\\s*=`).test(text)) return [];
  const assignmentPattern = new RegExp(`^\\s*(?:(?:define|default)(?:\\s+-?\\d+)?\\s+)?(?:\\$\\s*)?config\\.(${field})\\s*=(?!=)`);
  const assignments = [], contexts = [];
  let triple = null;
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    // Mask string/comment contents before looking for assignment syntax. This
    // prevents documentation or dialogue containing config code becoming proof.
    let masked = "", quote = null;
    for (let i = 0; i < original.length;) {
      if (triple) {
        if (original.startsWith(triple, i)) { masked += "   "; i += 3; triple = null; }
        else { masked += " "; i++; }
      } else if (quote) {
        if (original[i] === "\\") { masked += "  "; i += 2; }
        else { if (original[i] === quote) quote = null; masked += " "; i++; }
      } else if (original[i] === "#") { masked += " ".repeat(original.length - i); break; }
      else if (original.startsWith('"""', i) || original.startsWith("'''", i)) { triple = original.slice(i, i + 3); masked += "   "; i += 3; }
      else if (original[i] === '"' || original[i] === "'") { quote = original[i]; masked += " "; i++; }
      else masked += original[i++];
    }
    if (!masked.trim()) continue;
    const indentation = masked.match(/^\s*/)[0].replaceAll("\t", "    ").length;
    while (contexts.length && indentation <= contexts.at(-1).indentation) contexts.pop();
    const match = masked.match(assignmentPattern);
    if (match) assignments.push({ key: match[1], expression: original.slice(match[0].length).trim(), source,
      line: index + 1, confidence: "exact", unsafeContext: unsafeContext || contexts.some(item => item.unsafe) ||
        /^\s*\$/.test(masked) || (!python && !contexts.length && /^\s+config\./.test(masked)) });
    if (masked.trimEnd().endsWith(":")) {
      const safe = /^\s*(?:init(?:\s+-?\d+)?(?:\s+python(?:\s+hide)?)?|python\s+early)\s*:\s*$/.test(masked);
      contexts.push({ indentation, unsafe: !safe });
    }
  }
  return assignments;
}

function existsDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function resolveConfiguredSaveLocation(roots, {
  homeDir = os.homedir(), gameDir = roots?.find(existsDirectory) || null,
  renpyBaseDir = gameDir ? path.dirname(gameDir) : null, env = process.env, isMacApp = false
} = {}) {
  roots = (roots || []).filter(Boolean).map(root => path.resolve(root));
  gameDir = gameDir ? path.resolve(gameDir) : null;
  renpyBaseDir = renpyBaseDir ? path.resolve(renpyBaseDir) : null;
  const inspection = readGameConfigurationSources(roots);
  const assignments = inspection.sources.flatMap(item => item.compiledAssignments
    ? item.compiledAssignments.flatMap(assignment => assignment.python
      ? sourceAssignments(assignment.python, assignment.source, { python: true, unsafeContext: assignment.unsafeContext })
      : [assignment]) : sourceAssignments(item.text, item.source));
  const byKey = key => assignments.filter(item => item.key === key);
  const config = byKey("save_directory"), explicit = byKey("savedir");
  const unknown = (source, message) => ({ found: true, directory: null, primaryDirectory: null,
    directories: gameDir && !isMacApp && existsDirectory(path.join(gameDir, "saves"))
      ? [{ directory: path.join(gameDir, "saves"), role: "game-local", source: "Existing Ren'Py game-local save mirror; primary unresolved", confidence: "inferred" }] : [], source,
    confidence: "unknown", error: `${message} Select an explicit save-folder override.`, inspectionErrors: inspection.errors });
  function literalValue(items, { empty = false } = {}) {
    const values = items.map(item => item.unsafeContext ? undefined : item.expression?.trim() === "None" && empty ? "" : parseSaveDirectoryLiteral(item.expression || ""));
    if (values.some(value => value == null) || new Set(values).size > 1) return undefined;
    return values[0];
  }
  let directory, name = null, source, confidence = "exact", found = config.length > 0 || explicit.length > 0;
  if (explicit.length) {
    const value = literalValue(explicit);
    if (typeof value !== "string" || value.length > 4096 || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).includes("..")) return unknown(explicit[0].source, "Configured savedir is dynamic, conflicting, or is not a safe absolute literal.");
    directory = path.normalize(value); source = explicit[0].source;
  } else if (config.length) {
    name = literalValue(config, { empty: true });
    if (name === undefined || name !== "" && !safeSaveDirectoryName(name)) return unknown(config[0].source, "Save directory is dynamic, conflicting, conditional or is not a safe relative path.");
    source = config[0].source;
    if (!name) directory = gameDir ? path.join(gameDir, "saves") : null;
    else if (Object.hasOwn(env, "RENPY_PATH_TO_SAVES") && (typeof env.RENPY_PATH_TO_SAVES !== "string" || !path.isAbsolute(env.RENPY_PATH_TO_SAVES) || /[\x00-\x1f\x7f]/.test(env.RENPY_PATH_TO_SAVES))) {
      return unknown(source, "RENPY_PATH_TO_SAVES is not a safe absolute path and needs the runtime working directory to resolve.");
    } else if (typeof env.RENPY_PATH_TO_SAVES === "string") {
      directory = path.join(env.RENPY_PATH_TO_SAVES, name); source += " + RENPY_PATH_TO_SAVES";
    } else {
      // Match Ren'Py's standard path_to_saves search, using the actual runtime
      // base when the module has resolved an explicitly selected SDK.
      let portable = null;
      for (let base = renpyBaseDir, depth = 0; base && depth < 64; depth++) {
        const candidate = path.join(base, "Ren'Py Data");
        if (existsDirectory(candidate)) { portable = candidate; break; }
        const parent = path.dirname(base); if (parent === base) break; base = parent;
      }
      directory = portable ? path.join(portable, name) : path.join(homeDir, "Library", "RenPy", name);
      if (portable) source += " + Ren'Py Data";
    }
  } else if (gameDir) {
    directory = path.join(gameDir, "saves");
    source = "Ren'Py game-local save location";
    confidence = "inferred";
    // An unreadable/unsupported script may contain custom configuration. Keep
    // this known engine mirror visible but do not pretend its primary is known.
  }
  const directories = [];
  if (directory) directories.push({ directory, role: "primary", source, confidence });
  const local = gameDir && !isMacApp ? path.join(gameDir, "saves") : null;
  if (local && local !== directory) directories.push({ directory: local, role: "game-local", source: "Ren'Py non-Mac-app save mirror", confidence: "exact" });
  const extra = byKey("extra_savedirs"), extraValues = extra.map(item => item.unsafeContext ? null : parseSaveDirectoryList(item.expression));
  const extraUnknown = extra.length > 0 && (extraValues.some(value => value == null) || new Set(extraValues.map(value => JSON.stringify(value))).size > 1);
  if (!extraUnknown) for (const extraDirectory of extraValues[0] || []) {
    if (!directories.some(item => item.directory === extraDirectory)) directories.push({ directory: extraDirectory, role: "additional", source: extra[0].source, confidence: "exact" });
  }
  return { found, name, directory: directory || null, primaryDirectory: directory || null, directories,
    source: source || null, confidence: directory ? confidence : "unknown", error: [inspection.errors.length
      ? "Some script configuration could not be inspected; custom save locations may be unresolved." : null,
      extraUnknown ? "Additional configured save directories are dynamic, conflicting, or not safe absolute literals." : null].filter(Boolean).join(" ") || null,
    inspectionErrors: inspection.errors };
}

module.exports = { parseSaveDirectoryLiteral, parseSaveDirectoryList, safeSaveDirectoryName, sourceAssignments, resolveConfiguredSaveLocation };
