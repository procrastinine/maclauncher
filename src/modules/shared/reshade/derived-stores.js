const path = require("node:path"), crypto = require("node:crypto"), LaunchFiles = require("./launch-files");

// Graphics data that each launch leaves behind; see core/storage-maintenance.js.
// A game's effects/reshade/launch.json names its current launch, whose files
// stay for live edits and status. Earlier launches' files are no longer read.
const launches = new WeakMap();
function currentLaunches(context) {
  if (!launches.has(context)) {
    const ids = new Set();
    for (const gameId of context.gameIds()) {
      const launch = context.readJson(path.join(context.userDataDir, "games", gameId, "effects", "reshade", "launch.json"));
      if (typeof launch?.launchId === "string" && launch.launchId) ids.add(launch.launchId);
    }
    launches.set(context, ids);
  }
  return launches.get(context);
}
const bindings = context => path.join(context.userDataDir, "graphics", "payload-bindings");
const RECORD = /^[a-f0-9]{64}\.json$/;

module.exports = [
  {
    // A private graphics copy of a Mac app (effects/app-copy) goes to trash
    // here when Play no longer needs it or replaces it; this finishes a
    // removal that stopped. Nothing else matches.
    id: "graphics-app-copies",
    directories: context => context.gameIds().map(gameId => path.join(context.userDataDir, "games", gameId, "effects")),
    match: require("../../../core/storage-maintenance").TRASH
  },
  {
    // Source, presentation and runtime status channels of one launch.
    id: "graphics-launch-files",
    directories: context => context.gameIds().map(gameId => path.join(context.userDataDir, "games", gameId, "effects", "reshade")),
    // Each new launch removes its game's earlier channels; this catches the rest.
    match: LaunchFiles.CHANNEL,
    keep(directory, context) {
      const launchId = context.readJson(path.join(directory, "launch.json"))?.launchId;
      return name => LaunchFiles.owned(name, launchId);
    }
  },
  {
    // The processor bound to each launch, for live edits while it runs.
    id: "graphics-payload-bindings",
    directories: context => [bindings(context)],
    match: RECORD,
    keep(directory, context) {
      const current = currentLaunches(context);
      return name => {
        const record = context.readJson(path.join(directory, name), 16384);
        return !record || current.has(record.launchId) || context.processAlive(record.pid);
      };
    }
  },
  {
    // Manifest snapshots, shared by content, that the remaining bindings name.
    id: "graphics-payload-snapshots",
    directories: context => [path.join(bindings(context), "snapshots")],
    match: RECORD,
    keep(directory, context) {
      const referenced = new Set();
      try {
        for (const name of require("node:fs").readdirSync(bindings(context))) {
          if (!RECORD.test(name)) continue;
          const snapshot = context.readJson(path.join(bindings(context), name), 16384)?.snapshot;
          if (typeof snapshot === "string") referenced.add(snapshot + ".json");
        }
      } catch {}
      return name => referenced.has(name);
    }
  },
  {
    // GPU compute requests and replies of one launch.
    id: "graphics-compute-sessions",
    directories: context => [path.join(context.userDataDir, "graphics", "compute-sessions")],
    match: /^[a-f0-9]{64}$/,
    keep(_directory, context) {
      const current = new Set([...currentLaunches(context)].map(id => crypto.createHash("sha256").update(id).digest("hex")));
      return name => current.has(name);
    }
  },
  {
    // A model source archive kept after its checkpoint was extracted and
    // verified. Another model from the same archive downloads it again.
    id: "graphics-model-archives",
    directories: context => [path.join(context.userDataDir, "runtimes", "graphics-neural-models", ".source-archives")],
    match: /^[a-f0-9]{64}\.zip$/
  },
  {
    // A model download that stopped before it was verified and installed.
    // Downloading the model again starts a new one.
    id: "graphics-model-downloads",
    directories: context => [path.join(context.userDataDir, "runtimes", "graphics-neural-models")],
    match: /^\.download-[A-Za-z0-9]{6}$/,
    minAgeMs: 24 * 60 * 60 * 1000
  }
];
