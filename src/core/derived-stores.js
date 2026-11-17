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
    // Earlier Legendary copies that no longer provide the selected manifest APIs.
    id: "external-download-helpers",
    directories: ({ userDataDir }) => [path.join(userDataDir, "external", "tools")],
    match: /^legendary-[\w.+-]+-[0-9a-f]{12}$/,
    async keep(directory) {
      const legendary = require("./external-store-downloads").installedLegendary(directory);
      const name = item => path.basename(item.packagesPath);
      const listed = new Set(legendary.map(name));
      const kept = new Set([legendary[0], legendary.find(item => item.confirmsBuilds)].filter(Boolean).map(name));
      return entry => !listed.has(entry) || kept.has(entry);
    }
  }
];
