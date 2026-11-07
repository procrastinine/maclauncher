const fs = require("node:fs"), path = require("node:path");
const Components = require("../shared/runtime/runtime-components");

// Android downloads without a Runtimes row; see core/component-service.js.
const images = ({ userDataDir }) => path.join(userDataDir, "android", "system-images");
const google = ({ userDataDir }) => path.join(userDataDir, "android", "google", "packages");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const attached = directory => { try { return fs.readdirSync(path.join(directory, "mounted")).length > 0; } catch { return false; } };

module.exports = [
  {
    // One original image per archive identity, attached read-only while an
    // AIM game runs. The AIM provider downloads it again, after consent.
    id: "android-system-images",
    label: "Android system image",
    description: "The original Android system image that AIM attaches read-only for Android games. Each game's writable data stays separate.",
    list(context) {
      return Components.storeEntries(images(context), { match: /^[a-f0-9]{64}$/ }).flatMap(directory => {
        const record = readJson(path.join(directory, "image.json"));
        if (!record || record.archiveSha256 !== path.basename(directory)) return [];
        const inUse = attached(directory);
        return [{ id: path.basename(directory), version: `Image ${record.archiveSha256.slice(0, 12)}`, identity: `SHA-256 ${record.archiveSha256}`,
          path: directory, source: { label: "AIM system image" }, users: ["Android games through AIM"],
          ...(inUse ? { removable: false, removeReason: "The image is attached for a running Android game. Quit the game to delete it." } : {}) }];
      });
    },
    remove(item, context) {
      if (attached(item.path)) throw new Error("The image is attached for a running Android game. Quit the game to delete it.");
      return Components.removeOwned(item.path, images(context));
    }
  },
  {
    // microG Services and Companion for the shared Google account service.
    // An installed release stays in use; a deleted one is replaced by the
    // newest release with the next Google sign-in, after consent.
    id: "android-google-packages",
    label: "microG Services and Companion",
    description: "The official microG packages that provide the shared Google account service to Android games.",
    list(context) {
      return require("./google/packages").installedReleases(context.userDataDir).map(release => ({ id: release.version,
        version: `microG ${release.version}`, path: release.root,
        source: /^https:\/\//.test(release.releaseUrl || "") ? { url: release.releaseUrl } : { label: "microG releases" },
        users: ["Android games with Google sign-in"] }));
    },
    remove(item, context) { return Components.removeOwned(item.path, google(context)); },
    async refresh({ signal, logger } = {}) {
      const release = await require("./google/packages").discoverRelease({ signal, logger });
      return `Newest: microG ${release.version}. A deleted copy is replaced by the newest release with the next Google sign-in.`;
    }
  },
  {
    // The repository indexes that the Android store window searches. The
    // window reads an index again after a day or on its own Refresh.
    id: "android-store-catalogs",
    label: "Android store catalogs",
    cache: true,
    description: "The package indexes of F-Droid and IzzyOnDroid that the Android store window searches. The window reads a deleted index again when it needs it.",
    list({ userDataDir }) {
      const { SOURCES } = require("./store/repositories");
      return Components.storeEntries(path.join(userDataDir, "external", "catalogs")).filter(directory => SOURCES[path.basename(directory)])
        .map(directory => { const source = SOURCES[path.basename(directory)];
          return { id: source.id, version: `${source.label} index`, path: directory, source: { url: source.repo }, users: ["Android store window"] }; });
    },
    remove(item, { userDataDir }) { return Components.removeOwned(item.path, path.join(userDataDir, "external", "catalogs")); }
  }
];
