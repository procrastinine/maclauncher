const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function readJsonObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The object (or, with `array`, the array) stored at filePath for a
// read-merge-write update, or null when there is none. A document that exists
// but cannot be read is never treated as empty: a read error is retried in
// place and then thrown, and a malformed document throws SyntaxError carrying
// `salvaged`, its readable top-level members.
function readJsonObjectForUpdate(filePath, { attempts = 3, array = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      if (attempt >= attempts) throw error;
      continue;
    }
    let value;
    try { value = JSON.parse(text); }
    catch (error) { throw Object.assign(error, { salvaged: array ? [] : salvageJsonObject(text) }); }
    if (!value || typeof value !== "object" || Array.isArray(value) !== array)
      throw Object.assign(new SyntaxError(`${path.basename(filePath)} is not a JSON ${array ? "array" : "object"}.`), { salvaged: array ? [] : {} });
    return value;
  }
}

// The shared read before a change to a durable JSON document. Missing is null.
// A read error is retried in place and then thrown, so the caller refuses or
// skips its change and the document stays as it is. A malformed document is
// first copied byte for byte beside it (`onPreserved(copy)`), and its readable
// top-level members are returned for the change to merge into.
function readJsonDocument(filePath, { array = false, onPreserved } = {}) {
  try { return readJsonObjectForUpdate(filePath, { array }); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const copy = preserveUnreadable(filePath);
    if (copy) onPreserved?.(copy, error);
    return error.salvaged;
  }
}

// The complete top-level members of a damaged JSON object, in order, up to the
// first member that cannot be read, such as a truncated one.
function salvageJsonObject(text) {
  const out = {};
  let index = 0;
  const space = () => { while (/\s/.test(text[index] || "")) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length && text[index] !== "\"") index += text[index] === "\\" ? 2 : 1;
    if (index++ >= text.length) throw new SyntaxError("Unterminated string.");
    return text.slice(start, index);
  };
  const value = () => {
    const start = index, closing = [];
    do {
      const char = text[index];
      if (char === undefined) throw new SyntaxError("Unterminated value.");
      if (char === "\"") { string(); continue; }
      if (char === "{" || char === "[") closing.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") { if (closing.pop() !== char) throw new SyntaxError("Unbalanced value."); }
      else if (!closing.length && (char === "," || /\s/.test(char))) break;
      index++;
    } while (closing.length || !/[,}\s]/.test(text[index] || ","));
    return JSON.parse(text.slice(start, index));
  };
  try {
    space();
    if (text[index++] !== "{") return out;
    for (;;) {
      space();
      if (text[index] !== "\"") return out;
      const key = JSON.parse(string());
      space();
      if (text[index++] !== ":") return out;
      space();
      const member = value();
      if (key !== "__proto__") out[key] = member;
      space();
      if (text[index++] !== ",") return out;
    }
  } catch { return out; }
}

// Told once about each new copy of an unreadable document, as {file, copy}, so
// the launcher can name the copy in a notice whichever process made it.
const preservedListeners = new Set();
function onUnreadablePreserved(listener) {
  preservedListeners.add(listener);
  return () => preservedListeners.delete(listener);
}

// Keeps an unreadable document byte for byte beside it as
// `<name>.unreadable-<time>.json` (for `<name>.json`), written atomically,
// before a writer replaces it. A copy with the same bytes is reused. Null when
// there is no document.
function preserveUnreadable(filePath) {
  let bytes;
  try { bytes = fs.readFileSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const directory = path.dirname(filePath), extension = path.extname(filePath);
  const prefix = `${path.basename(filePath, extension)}.unreadable-`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(extension)) continue;
    try { if (fs.readFileSync(path.join(directory, name)).equals(bytes)) return path.join(directory, name); } catch {}
  }
  const target = path.join(directory, prefix + new Date().toISOString().replace(/[:.]/g, "-") + extension);
  writeFileAtomic(target, bytes);
  for (const listener of preservedListeners) {
    try { listener({ file: filePath, copy: target }); } catch {}
  }
  return target;
}

// Keep readers from seeing partially written launcher metadata or cheat settings.
function writeJsonAtomic(filePath, value) {
  return writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

function writeFileAtomic(filePath, contents) {
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error(`JSON destination is not a regular file: ${filePath}`);
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return filePath;
}

module.exports = { readJsonObject, readJsonObjectForUpdate, readJsonDocument, salvageJsonObject, preserveUnreadable, onUnreadablePreserved, writeJsonAtomic };
