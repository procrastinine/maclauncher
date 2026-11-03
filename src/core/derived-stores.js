const fs = require("node:fs"), path = require("node:path");

// Derived stores owned by core services; see storage-maintenance.js.
module.exports = [
  {
    id: "obsolete-internal-tool-copies",
    directories: ({userDataDir}) => {
      const root=path.join(userDataDir,"internal-tools");
      try{return fs.readdirSync(root,{withFileTypes:true}).filter(item=>item.isDirectory()&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.name)).map(item=>path.join(root,item.name));}catch{return [];}
    },
    match: /^[a-f0-9]{64}$/
  },
  {
    id: "shared-package-dependencies",
    directories: ({userDataDir}) => [path.join(userDataDir,"runtimes/.dependencies")],
    match: /^[a-z0-9][a-z0-9-]{0,79}$/,
    async keep(directory,{userDataDir}) {
      // Project containers stay; their owned entries retire under the same
      // nonblocking kernel lock as installs, through shared guarded trash.
      await require("../modules/shared/runtime/package-dependencies").collect(userDataDir);
      return () => true;
    }
  },
  {
    // Removing a runtime version moves its folder here as trash first; a
    // removal that stopped is finished by the next pass. Nothing else matches.
    id: "runtime-removals",
    directories: ({ userDataDir }) => [path.join(userDataDir, "runtimes")],
    match: require("./storage-maintenance").TRASH
  },
  {
    // Store download helpers. A newer release installs beside the earlier
    // one; downloads use the newest (Legendary also keeps the newest one that
    // can confirm Epic builds), so earlier helpers are never used again.
    id: "external-download-helpers",
    directories: ({ userDataDir }) => [path.join(userDataDir, "external", "tools")],
    match: /^(?:gogdl-[\w.+-]+-(?:arm64|x64)|legendary-[\w.+-]+)-[0-9a-f]{12}$/,
    async keep(directory) {
      let names = [];
      try { names = fs.readdirSync(directory); } catch {}
      const count = (prefix, part = "") => names.filter(name => name.startsWith(prefix) && name.includes(part)).length;
      // Verifying a helper reads its files, so it happens only while an
      // earlier helper is present.
      const arches = ["arm64", "x64"].filter(arch => count("gogdl-", `-${arch}-`) > 1);
      if (!arches.length && count("legendary-") < 2) return () => true;
      const legendary = require("./external-store-downloads").installedLegendary(directory);
      const { installed } = require("./gogdl-tool");
      // Each list is sorted newest first; an architecture with one helper keeps it.
      const gogdl = await Promise.all(arches.map(arch => installed(directory, arch)));
      const name = item => path.basename(item.packagesPath || path.dirname(item.executablePath));
      const listed = new Set([...legendary, ...gogdl.flat()].map(name));
      const kept = new Set([legendary[0], legendary.find(item => item.confirmsBuilds), ...gogdl.map(rows => rows[0])]
        .filter(Boolean).map(name));
      // Only verified, superseded helpers are removed; anything unrecognized,
      // and every helper of an architecture with one, stays.
      return entry => !listed.has(entry) || kept.has(entry);
    }
  }
];
