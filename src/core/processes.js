const { spawn: nodeSpawn } = require("node:child_process");
const { readMachOArchitectures } = require("../modules/shared/runtime/local-native");
const Rosetta = require("../modules/shared/runtime/rosetta");

function rosettaCommand(cmd, args, env) {
  try {
    const architectures = readMachOArchitectures(cmd);
    // macOS starts a thin Intel executable through Rosetta directly. Avoid
    // the SIP-protected arch trampoline, which strips DYLD library paths.
    if (architectures.length === 1 && architectures[0] === "x86_64") return [cmd, args];
  } catch {}
  const environment = Object.entries(env || process.env).flatMap(([key, value]) =>
    /^DYLD_[A-Z0-9_]+$/.test(key) && typeof value === "string" && !value.includes("\0") ? ["-e", `${key}=${value}`] : []);
  return ["arch", ["-x86_64", ...environment, cmd, ...args]];
}

/**
 * Launches native processes, optionally through macOS arch for Rosetta x64 support.
 * Defaults to detached, ignored stdio, and unref. Callers that wait for exit can pass
 * { detached: false, stdio: "inherit" }; checked launches resolve on spawn, not exit.
 */
function createProcessLauncher({ spawn = nodeSpawn, rosetta = Rosetta, prerequisiteContext = {} } = {}) {
  function requiresTranslation(cmd, needsRosetta) {
    return needsRosetta || rosetta.requiresForExecutable(cmd);
  }
  function prepareProcess(cmd, args, options, needsRosetta) {
    if (needsRosetta && !rosetta.isAvailable()) throw rosetta.createRequiredError();
    const { stdio, detached, ...rest } = options || {};
    const spawnOptions = { ...rest, stdio: stdio ?? "ignore", detached: detached ?? true };
    const [executable, parameters] = needsRosetta ? rosettaCommand(cmd, args, spawnOptions.env) : [cmd, args];
    const child = spawn(executable, parameters, spawnOptions);
    // Keep a listener for unchecked failures and errors after a successful spawn.
    // Checked launches additionally attach their rejection handler before unref.
    child.on("error", () => {});
    return { child, detached: spawnOptions.detached };
  }

  function spawnDetachedProcess(cmd, args = [], options = {}, needsRosetta = false) {
    const { child, detached } = prepareProcess(cmd, args, options, requiresTranslation(cmd, needsRosetta));
    if (detached) child.unref();
    return child;
  }

  async function spawnDetachedChecked(cmd, args = [], options = {}, needsRosetta = false, context = prerequisiteContext) {
    const translation = requiresTranslation(cmd, needsRosetta);
    // Keep installed launches synchronous until spawn: no dialog, package lookup,
    // or extra promise turn on the warm path.
    if (translation && !rosetta.isAvailable()) await rosetta.ensure(context);
    const { child, detached } = prepareProcess(cmd, args, options, translation);
    const spawned = new Promise((resolve, reject) => {
      function onSpawn() {
        child.removeListener("error", onError);
        resolve();
      }
      function onError(error) {
        child.removeListener("spawn", onSpawn);
        reject(error);
      }
      child.once("spawn", onSpawn);
      child.once("error", onError);
      if (detached) child.unref();
    });
    try {
      await Promise.all([spawned, context?.onProcessSpawn?.(child)]);
    } catch (error) {
      if (child.pid && child.exitCode == null && child.signalCode == null) { try { child.kill(); } catch {} }
      throw error;
    }
    return child;
  }

  return { spawnDetachedProcess, spawnDetachedChecked };
}

module.exports = { createProcessLauncher, ...createProcessLauncher() };
