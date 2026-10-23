const Binding = require("../modules/shared/reshade/launch-binding");

function warningsForLaunch(entry, options = {}) {
  const prepared = Array.isArray(options.preparationWarnings) ? options.preparationWarnings
    .filter(reason => typeof reason === "string" && reason.trim()) : [];
  const launch = Binding.read(entry, options);
  if (!launch || launch.phase !== "spawned" || !launch.launchId || launch.launchId === options.previousLaunchId ||
      options.pid && launch.pid !== options.pid) return prepared;
  const warnings = Array.isArray(launch.graphicsWarnings) ? launch.graphicsWarnings
    .filter(warning => typeof warning?.reason === "string" && warning.reason.trim())
    .map(warning => warning.reason) : [];
  return [...new Set([...prepared, ...warnings])];
}

module.exports = {warningsForLaunch};
