// A graphics package stores identical provider payload files once. A
// payload-aliases.json in a provider's payload directory maps each removed path
// below it to the stored copy, relative to that directory. The nearest index
// above a path applies; reshade/temporal/payload-files.hpp is the native reader
// of the same rule. A path that exists is always the stored file.
const fs = require("node:fs");
const path = require("node:path");

const INDEX = "payload-aliases.json";
const cache = new Map();

/** A relative POSIX path without empty, "." or ".." parts. */
function safe(relative) {
  return typeof relative === "string" && relative.length > 0 && relative.split("/").every(part => part && part !== "." && part !== "..");
}

// A missing or invalid index has no aliases. Each index is read again only
// when the file itself changes.
function aliases(directory) {
  const file = path.join(directory, INDEX);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const key = stat.mtimeMs + ":" + stat.size, cached = cache.get(file);
  if (cached?.key === key) return cached.files;
  let files = new Map();
  try {
    const index = JSON.parse(fs.readFileSync(file, "utf8"));
    if (index?.schema === 1 && index.files && typeof index.files === "object")
      files = new Map(Object.entries(index.files).filter(([from, to]) => safe(from) && safe(to)));
  } catch {}
  cache.set(file, { key, files });
  return files;
}

// The nearest index at or above `relative` within base, with the path relative
// to that index's directory.
function nearest(base, relative) {
  const parts = path.posix.normalize(relative).split("/").filter(part => part && part !== ".");
  if (parts.includes("..")) return null;
  for (let depth = parts.length; depth >= 0; --depth) {
    const files = aliases(path.join(base, ...parts.slice(0, depth)));
    if (files) return { directory: parts.slice(0, depth).join("/"), files, key: parts.slice(depth).join("/") };
  }
  return null;
}

/** The base-relative path of the stored file for a payload path below base. */
function stored(base, relative) {
  if (fs.existsSync(path.join(base, relative))) return relative;
  const index = nearest(base, path.posix.dirname(relative));
  const target = index && index.files.get((index.key ? index.key + "/" : "") + path.posix.basename(relative));
  return target ? path.posix.join(index.directory, target) : relative;
}

/** The stored file for a payload path below base. */
function resolve(base, relative) {
  return path.join(base, stored(base, relative));
}

/** Whether a file or directory below base exists on disk or through aliases. */
function exists(base, relative) {
  if (fs.existsSync(path.join(base, relative))) return true;
  const index = nearest(base, relative);
  if (!index) return false;
  const prefix = index.key ? index.key + "/" : "";
  for (const from of index.files.keys()) if (from === index.key || from.startsWith(prefix)) return true;
  return false;
}

module.exports = { INDEX, safe, stored, resolve, exists };
