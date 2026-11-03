const fs = require("node:fs");
const path = require("node:path");
const Icons = require("./icon-utils");
const { executableRole } = require("../modules/shared/executable-candidates");
const FileSignature = require("../modules/shared/file-signature");

function existing(value, kind) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) return false;
  try { const stat = fs.statSync(value); return kind === "directory" ? stat.isDirectory() : stat.isFile(); } catch { return false; }
}
function appRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  let current = path.resolve(value);
  for (let depth = 0; depth < 16; depth++) {
    if (existing(current, "directory") && (current.toLowerCase().endsWith(".app") ||
      existing(path.join(current, "Contents", "Info.plist"), "file") && existing(path.join(current, "Contents", "MacOS"), "directory"))) return current;
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return null;
}
function resolveIconCandidates(entry) {
  const results = [], seen = new Set(), directories = new Set();
  // Directory fields can be the containing Downloads folder for a file import.
  // Only folder imports may discover artwork from neighboring executables/apps.
  const fileImport = existing(entry?.importPath || entry?.gamePath, "file");
  const add = (value, source, selected = false) => {
    if (results.length >= 32 || !value || seen.has(value)) return;
    if (!existing(value, source === "app" ? "directory" : "file")) return;
    if (source === "exe" && !selected && executableRole(value) === "support") return;
    seen.add(value); results.push({ path: value, source });
  };
  for (const value of [entry?.importPath, entry?.gamePath, entry?.nativeAppPath, entry?.contentRootDir]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) continue;
    const app = appRoot(value);
    if (app) add(app, "app");
    // A recognized game can itself be an executable package. Its recorded
    // path supplies artwork even when its name resembles a support program;
    // the shared role rule excludes those programs from folder searches.
    if (path.extname(value).toLowerCase() === ".exe") add(value, "exe", true);
    if (!app && !fileImport) {
      if (existing(value, "directory")) directories.add(value);
    }
  }
  const content = entry?.contentRootDir;
  // A packaged game's payload may be one level below its executable. Search
  // that parent only inside the imported folder, or for conventional payload
  // directories; do not scan the parent of arbitrary imported game folders.
  if (!fileImport && existing(content, "directory") && !appRoot(content)) {
    const parent = path.dirname(content), imported = entry?.importPath;
    const relative = typeof imported === "string" ? path.relative(imported, parent) : "..";
    if (existing(imported, "directory") && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) ||
      ["game", "assets", "data"].includes(path.basename(content).toLowerCase())) directories.add(parent);
  }
  for (const directory of [...directories].slice(0, 8)) {
    let names;
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
      if (names.length > 4096) continue;
    } catch { continue; }
    const executableNames = names.filter(item => item.isFile() && /\.exe$/i.test(item.name) && executableRole(item.name) !== "support")
      .sort((a, b) => Icons.scoreExeCandidate(path.basename(b.name, path.extname(b.name)), entry?.name, path.basename(directory)) -
        Icons.scoreExeCandidate(path.basename(a.name, path.extname(a.name)), entry?.name, path.basename(directory)) || a.name.localeCompare(b.name));
    for (const item of executableNames.slice(0, 16)) add(path.join(directory, item.name), "exe");
    for (const item of names.filter(item => item.isDirectory() && /\.app$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8)) add(path.join(directory, item.name), "app");
  }
  return results;
}
function fileIdentity(value) {
  const stat = fs.statSync(value);
  return [fs.realpathSync(value), FileSignature.signature(stat)];
}
function sameFingerprint(previous, current) {
  const parse = value => {
    if (typeof value !== "string") return null;
    try {
      const parts = JSON.parse(value), count = parts?.[1] === "exe" ? 3 : parts?.[1] === "app" ? 4 : 0;
      if (!Array.isArray(parts) || parts[0] !== "icon-extract-v2" || parts.length !== count) return null;
      const identities = parts.slice(2).map(identity => {
        if (!Array.isArray(identity) || ![2, 6].includes(identity.length) || typeof identity[0] !== "string") return null;
        const signature = FileSignature.normalize(identity.length === 2 ? identity[1] : identity.slice(1));
        return signature ? [identity[0], signature] : null;
      });
      return identities.every(Boolean) ? [parts[0], parts[1], ...identities] : null;
    } catch { return null; }
  };
  const left = parse(previous), right = parse(current);
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}
function sourceFingerprint(candidate) {
  try {
    // Cached extraction failures from older implementations must not hide
    // icons after an extractor upgrade. Bump this identity when it changes.
    if (candidate.source === "exe") return JSON.stringify(["icon-extract-v2", "exe", fileIdentity(candidate.path)]);
    if (candidate.source === "app") {
      const icon = Icons.findAppBundleIconPath(candidate.path);
      if (!icon) return null;
      return JSON.stringify(["icon-extract-v2", "app", fileIdentity(path.join(candidate.path, "Contents", "Info.plist")), fileIdentity(icon)]);
    }
  } catch {}
  return null;
}
async function selectIconForEntry({ entry, moduleIconPath, moduleDefaultIconPath, canRenderPath, extractCandidate, signal }) {
  signal?.throwIfAborted();
  const existingSource = entry?.iconSource;
  if (entry?.iconPath && !["module", "module-default", "app", "exe"].includes(existingSource) &&
    entry.iconPath !== moduleDefaultIconPath && canRenderPath(entry.iconPath)) return { path: entry.iconPath, source: existingSource || null };
  if (moduleIconPath && canRenderPath(moduleIconPath)) return { path: moduleIconPath, source: "module" };
  for (const candidate of resolveIconCandidates(entry)) {
    signal?.throwIfAborted();
    try {
      const icon = await extractCandidate(candidate);
      signal?.throwIfAborted();
      if (icon && canRenderPath(icon)) return { path: icon, source: candidate.source };
    } catch { signal?.throwIfAborted(); }
  }
  return moduleDefaultIconPath && canRenderPath(moduleDefaultIconPath)
    ? { path: moduleDefaultIconPath, source: "module-default" } : { path: null, source: null };
}

module.exports = { resolveIconCandidates, sourceFingerprint, sameFingerprint, selectIconForEntry };
