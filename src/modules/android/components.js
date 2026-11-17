const path = require("node:path");
const Components = require("../shared/runtime/runtime-components");

// Remaining application data stores; original images have a Runtimes manager.
const google = ({ userDataDir }) => path.join(userDataDir, "android", "google", "packages");

module.exports = [
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
