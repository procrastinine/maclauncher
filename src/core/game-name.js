const fs = require("node:fs");
const path = require("node:path");

function directory(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}
const stem = file => path.basename(file, path.extname(file));
const comparable = name => name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const readable = name => /\s/u.test(name) || /[^\x00-\x7f]/u.test(name) || /^[A-Z][a-z]+$/.test(name);
const identifier = name => /^[a-z\d_.-]+$/.test(name) || /[a-z][A-Z]|[A-Z]{2,}[a-z]|[_-]/.test(name);

// A title supplied by a game wins over an artifact identifier. Folder titles are
// never replaced by an unrelated executable found beside the actual game data.
function resolveGameName(entry, { metadata = false } = {}) {
  metadata ||= entry?.nameSource?.type === "metadata";
  const raw = typeof entry?.name === "string" ? entry.name.trim() : "";
  const source = entry?.importPath || entry?.gamePath || "";
  const isFolder = source && directory(source);
  const folder = isFolder ? source : entry?.contentRootDir || path.dirname(source);
  const folderName = folder ? path.basename(folder, /\.app$/i.test(folder) ? path.extname(folder) : "") : "";
  const inputName = source ? stem(source) : "";
  const cleaned = raw.replace(/\s*\([^)]*\b(?:F\d{1,2}|Ctrl|Control|Cmd|Command|Alt|Esc|Escape)\s*[:=+][^)]*\)\s*$/i, "").trim();
  const keyHints = cleaned !== raw;
  const artifactName = raw === inputName || raw === path.basename(source) || raw === folderName;
  const sameTitle = comparable(folderName) && (comparable(raw).startsWith(comparable(folderName)) || comparable(folderName).startsWith(comparable(raw)));
  if (folderName && readable(folderName) && (keyHints || !raw ||
      identifier(raw) && (!metadata || artifactName || sameTitle) && (isFolder || sameTitle))) return folderName;
  if (cleaned) return cleaned;
  return folderName || inputName || raw;
}

function applyGameName(entry, options) {
  if (!entry || typeof entry !== "object") return entry;
  const name = resolveGameName(entry, options);
  return name && name !== entry.name ? { ...entry, name } : entry;
}
module.exports = { applyGameName, resolveGameName };
