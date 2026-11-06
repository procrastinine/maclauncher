const fs = require("node:fs"), path = require("node:path");
const Components = require("./runtime-components");

// Shared runtime downloads and caches without a Runtimes row; see
// core/component-service.js. "Used by" names runtimes by their Runtimes label.
const dependencies = ({ userDataDir }) => path.join(userDataDir, "runtimes", ".dependencies");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

module.exports = [
  {
    // Libraries that MacLauncher Builds packages share, such as a Vulkan
    // loader or codec closure, installed once with the first package that
    // declares them and removed by upkeep when no package declares them.
    id: "shared-package-dependencies",
    label: "Shared runtime libraries",
    description: "Libraries that several MacLauncher Builds packages load. Each is downloaded with the first runtime that needs it and is removed with the last one.",
    list(context) {
      const users = new Map();
      try {
        require("./package-dependencies").references(context.userDataDir, (declared, runtimeId) => {
          for (const dep of declared) users.set(JSON.stringify([dep.project, dep.release, dep.sha256]), [...users.get(JSON.stringify([dep.project, dep.release, dep.sha256])) || [], runtimeId]);
        });
      } catch {}
      return Components.storeEntries(dependencies(context)).flatMap(project => Components.storeEntries(project).flatMap(release =>
        Components.storeEntries(release, { match: /^[a-f0-9]{64}$/ }).map(directory => {
          const record = readJson(path.join(directory, "runtime.json")) || {}, sha256 = path.basename(directory);
          const key = JSON.stringify([path.basename(project), path.basename(release), sha256]);
          const named = [...new Set((users.get(key) || []).map(runtimeId => context.runtimeLabel?.(runtimeId) || runtimeId))];
          return { id: key, label: path.basename(project), version: `${path.basename(project)} ${path.basename(release)}`,
            identity: `SHA-256 ${sha256}`, architecture: record.catalogEntry?.projectPackage?.arch || null, path: directory,
            source: { url: record.repository ? `https://github.com/${record.repository}/releases` : "https://github.com/procrastinine/maclauncher-builds/releases" },
            users: named, ...(named.length ? { removable: false, removeReason: "Installed runtimes load this library. It is removed with the last of them." } : {}) };
        })));
    },
    remove(item, context) { return Components.removeOwned(item.path, dependencies(context)); }
  },
  Components.cacheComponent({
    id: "translator-descriptions",
    label: "Translator descriptions",
    description: "Facts read from installed graphics translator files, such as versions and supported Direct3D APIs. Settings read them again from the files when they are missing.",
    location: ({ userDataDir }) => path.join(userDataDir, "cache", "translator-descriptions"),
    users: ["CrossOver and Sikarugir translator settings"]
  })
];
