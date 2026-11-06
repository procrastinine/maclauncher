const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Architecture = require("./architecture");

// Helpers for components.js declarations, the downloadable files listed in
// Runtimes → Components (see core/component-service.js for the contract).

async function sha256File(file, { signal } = {}) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, signal })) hash.update(bytes);
  return hash.digest("hex");
}

// Removes one owned file or folder inside `root`. The entry is renamed to a
// trash name in its own folder first and then deleted without following links,
// as storage upkeep does, so a stopped removal is finished by the next upkeep.
async function removeOwned(target, root) {
  if (!path.isAbsolute(target || "") || !path.isAbsolute(root || "")) throw new Error("The component location is invalid.");
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink()) throw new Error("The component location is a link and stays in place.");
  const parent = fs.realpathSync(path.dirname(target)), base = fs.realpathSync(root);
  const relative = path.relative(base, path.join(parent, path.basename(target)));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("The component is outside its store.");
  const Storage = require("../../../core/storage-maintenance");
  await Storage.removeTrash(Storage.moveToTrash(path.join(parent, path.basename(target))));
  return true;
}

// Directory entries of a store, without links, temporary or trash entries.
function storeEntries(root, { match = /^[^.]/, directories = true, files = false } = {}) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => match.test(entry.name) && !entry.isSymbolicLink() &&
      (directories && entry.isDirectory() || files && entry.isFile())).map(entry => path.join(root, entry.name)).sort();
  } catch { return []; }
}

const included = row => row?.included === true || row?.bundledExecution === "direct" || row?.removable === false;

// The CPU build of an installed version, as translator rows name it: the CPU
// slices of its installed file, then the build its release declares, then the
// CPU its installation was made for.
function installedBuild(row) {
  const slices = [...new Set((Array.isArray(row?.architectures) ? row.architectures : []).map(Architecture.normalizeArchitecture)
    .filter(cpu => cpu === "arm64" || cpu === "x64"))];
  if (slices.length) return slices.length > 1 ? "universal" : slices[0];
  return Architecture.recordArchitecture(row?.catalogEntry) || Architecture.normalizeArchitecture(row?.architecture);
}

/** A component for a runtime manager whose versions have no row in Runtimes.
 * Installed versions are listed with their CPU build; Delete removes one through
 * the manager, and a local copy of a release archive installs offline when its
 * SHA-256 matches a version in the manager's cached catalog. */
function fromRuntimeManager(manager, { id = manager.id, label = manager.label, description, users = [], extensions = ["gz", "zip", "xz", "tar", "tgz", "txz"] } = {}) {
  if (!manager?.id) throw new Error("A runtime component needs its manager.");
  return {
    id, label, description, managerId: manager.id,
    list(context) {
      const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.[manager.id],
        runtimeSettings: context.settings?.runtimes });
      const sections = Array.isArray(state?.sections) && state.sections.length ? state.sections : [{ ...state, id: "default" }];
      const named = typeof users === "function" ? users(context) : users;
      return sections.flatMap(section => (Array.isArray(section.installed) ? section.installed : []).filter(row => row.installDir && !row.reference && !included(row)).map(row => {
        const versionLabel = section.versionLabels?.[row.version] || state.versionLabels?.[row.version] || row.versionLabel || row.version;
        const url = row.assetUrl || row.catalogEntry?.asset?.url || null;
        return { id: JSON.stringify([section.id || "default", row.version, row.architecture || null, row.installDir]),
          version: String(versionLabel || ""), identity: /^[a-f0-9]{64}$/.test(row.archiveSha256 || "") ? `SHA-256 ${row.archiveSha256}` : null,
          architecture: installedBuild(row), path: row.installDir,
          source: row.source === "manual" || row.source === "custom" ? "manual" : url ? { url } : null,
          users: named, ...(row.ready === false ? { status: row.error || "Needs repair" } : {}),
          runtime: { sectionId: section.id || "default", version: row.version, architecture: row.architecture, variant: row.variant,
            platformKey: row.platformKey, installDir: row.installDir } };
      }));
    },
    remove(item, context) { return context.runtimeAction(manager.id, "uninstall", item.runtime); },
    import: { label: `Add ${label} archive`, kinds: ["file"], extensions,
      async run(file, context) {
        const sha256 = await sha256File(file, context);
        for (const architecture of ["arm64", "x64"]) {
          const pins = manager.core?.listCatalog?.({ userDataDir: context.userDataDir, architecture }) || [];
          const pin = pins.find(row => row?.asset?.sha256 === sha256);
          if (!pin) continue;
          await context.runtimeAction(manager.id, "install", { sectionId: "default", version: pin.version, architecture }, { archiveFile: file });
          return { version: pin.version, architecture };
        }
        throw new Error(`The file does not match any ${label} release recorded on this Mac (SHA-256 ${sha256}).`);
      } } };
}

// One cache folder as a single component row. Deleting it removes the folder;
// its owner fills it again when needed.
function cacheComponent({ id, label, description, location, users = [] }) {
  return { id, label, description, cache: true,
    list(context) {
      const directory = location(context);
      return directory && fs.existsSync(directory) ? [{ id: "cache", version: "", path: directory, source: { label: "Created by MacLauncher" },
        users: typeof users === "function" ? users(context) : users }] : [];
    },
    remove(item, context) { return removeOwned(item.path, context.userDataDir); } };
}

module.exports = { sha256File, removeOwned, storeEntries, installedBuild, fromRuntimeManager, cacheComponent };
