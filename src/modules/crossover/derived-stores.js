const fs = require("node:fs"), path = require("node:path");

// Derived Windows-runtime data; see core/storage-maintenance.js.
function loaderFolders(context) {
  const folders = context.gameIds().map(gameId => path.join(context.userDataDir, "games", gameId, "runtimes", "crossover", "graphics-loader"));
  const hosts = path.join(context.userDataDir, "graphics", "compute-hosts");
  try {
    for (const item of fs.readdirSync(hosts, { withFileTypes: true }))
      if (item.isDirectory()) folders.push(path.join(hosts, item.name, "graphics-loader"));
  } catch {}
  return folders;
}
module.exports = [
  {
    // A GPU compute host folder (environment, loaders and graphics views) is
    // named by its CrossOver or Sikarugir version and backend. Hosts of
    // versions still listed in Runtimes stay; a host whose version was removed
    // is rebuilt if that version is installed again.
    id: "graphics-compute-hosts",
    directories: context => [path.join(context.userDataDir, "graphics", "compute-hosts")],
    match: /^[0-9a-f]{24}$/,
    keep(_directory, context) {
      try {
        const names = new Set([require("./runtime/compute-host"), require("./sikarugir/runtime/compute-host")]
          .flatMap(host => host.hostNames(context.userDataDir)));
        return name => names.has(name);
      } catch { return () => true; }
    },
    minAgeMs: 24 * 60 * 60 * 1000
  },
  {
    // Each signed graphics loader is named by the identity of its CrossOver
    // files, helpers and scene closure, so a CrossOver or helper update adds
    // another. The two newest stay; an older one in use again is rebuilt.
    id: "crossover-graphics-loaders",
    directories: loaderFolders,
    match: /^[0-9a-f]{24}$/,
    newest: 2,
    minAgeMs: 24 * 60 * 60 * 1000
  },
  {
    // A loader being signed in a temporary folder when the launcher quit.
    id: "crossover-graphics-loader-staging",
    directories: loaderFolders,
    match: /^prepare-[A-Za-z0-9]{6}$/,
    minAgeMs: 24 * 60 * 60 * 1000
  }
];
