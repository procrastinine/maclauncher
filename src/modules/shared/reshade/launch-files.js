const fs = require("node:fs"), path = require("node:path");
// Source, presentation and runtime status channels carry their launch's ID.
// Only the launch named by effects/reshade/launch.json reads them.
const CHANNEL = /^(?:source-control|source-status|presentation-control|presentation-status|runtime-status|browser-source)-[\w-]+\.(?:json|bin|state)$/;
const owned = (name, launchId) => typeof launchId === "string" && launchId !== "" &&
  (name.includes(`-${launchId}.`) || name.includes(`-${launchId}-virtual.`));
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// A new launch replaces launch.json, so earlier launches' channels are removed
// first. A recorded process that still runs keeps its own channels.
function pruneEarlierLaunches(directory, { isProcessAlive = processAlive } = {}) {
  let names, previous = null;
  try { names = fs.readdirSync(directory); } catch { return; }
  try { previous = JSON.parse(fs.readFileSync(path.join(directory, "launch.json"), "utf8")); } catch {}
  const live = previous && isProcessAlive(previous.pid) ? previous.launchId : null;
  for (const name of names) {
    if (!CHANNEL.test(name) || owned(name, live)) continue;
    const file = path.join(directory, name);
    try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); } catch { /* Upkeep never prevents Play. */ }
  }
}

module.exports = { CHANNEL, owned, pruneEarlierLaunches };
