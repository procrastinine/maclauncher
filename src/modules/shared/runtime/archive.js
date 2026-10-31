const fs = require("node:fs");
const path = require("node:path");
const ReleaseFiles = require("./release-files");

// Archive kinds and file lookups over release-files.js. Format detection and
// extraction live in release-files.js; callers use it directly.
function archiveKind(name) {
  const format = ReleaseFiles.archiveFormat(name);
  return !format ? null : format === ".zip" || format === ".dmg" ? format.slice(1) : "tar";
}
// A file name that names a Mac build: a platform word between separators.
function isMacName(name) {
  return /(?:^|[^a-z0-9])(?:mac|macos|macosx|osx|darwin|apple)(?:[^a-z0-9]|$)/i.test(String(name || ""));
}

// The shallowest entry under root that matches, breadth first and bounded,
// so a package that moves its files one or more folders deeper still resolves.
function findEntry(root, matches, { maxDepth = 4, maxEntries = 20000 } = {}) {
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length) {
    const [directory, depth] = queue.shift();
    let items = [];
    try { items = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const item of items) {
      if (++seen > maxEntries) return null;
      if (item.name === "__MACOSX" || item.isSymbolicLink()) continue;
      const file = path.join(directory, item.name);
      if (matches(file, item)) return file;
      if (item.isDirectory() && depth < maxDepth && !item.name.endsWith(".app")) queue.push([file, depth + 1]);
    }
  }
  return null;
}

module.exports = { archiveKind, isMacName, findEntry };
