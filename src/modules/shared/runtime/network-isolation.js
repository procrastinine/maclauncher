const fs = require("node:fs");
const path = require("node:path");

// Network access is resolved centrally; runtime metadata exposes only the
// independent policy controlling child-process creation.
function withNetworkSettings(manifest) {
  if (!manifest?.runtime) return manifest;
  const runtime = manifest.runtime, entries = { ...runtime.entries };
  for (const id of new Set([...(runtime.supported || []), ...Object.keys(entries)])) {
    const entry = entries[id] || {};
    if (entry.launch === false) continue;
    const settings = entry.settings || {};
    const { networkIsolation: _legacyNetwork, ...defaults } = settings.defaults || {};
    const fields = (settings.fields || []).filter(field => field.key !== "networkIsolation")
      .map(field => field.key === "enableProtections" ? { ...field,
        label: "Block child processes",
        description: "Prevent game scripts from starting other programs. Applies on the next launch." } : field);
    entries[id] = { ...entry, settings: { ...settings,
      defaults, fields } };
  }
  return { ...manifest, runtime: { ...runtime, entries } };
}

function profile({ assetPort } = {}) {
  if (assetPort !== undefined && (!Number.isInteger(assetPort) || assetPort < 1 || assetPort > 65535))
    throw new Error("The local game asset server has an invalid port.");
  return `(version 1)\n(allow default)\n(deny network*)\n` +
    `(allow network* (local unix-socket) (remote unix-socket))\n` +
    `(deny network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))\n` +
    `(deny mach-lookup (global-name "com.apple.mDNSResponder"))\n` +
    (assetPort === undefined ? "" : `(allow network-outbound (remote ip "localhost:${assetPort}"))\n`);
}

// sandbox-exec and the system shell strip inherited DYLD variables. Restore
// only explicit DYLD assignments, as argv data, after the policy is installed.
// The existing Rosetta arch -e path similarly restores them after its boundary.
const BOOTSTRAP = `set -eu
count=$1
shift
while [ "$count" -gt 0 ]; do
  export "$1"
  shift
  count=$((count - 1))
done
exec "$@"`;

function assertDirect(command) {
  if (["open", "osascript", "launchctl"].includes(path.basename(command)))
    throw new Error("Network isolation requires launching the game directly, without an external application service.");
}
function wrap(command, args, environment, { assetPort, acknowledge = false, platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("Network isolation requires macOS.");
  assertDirect(command);
  try { fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK); }
  catch { throw new Error("macOS network isolation is unavailable. The game was not started."); }
  const assignments = Object.entries(environment || process.env).filter(([key, value]) =>
    /^DYLD_[A-Z0-9_]+$/.test(key) && typeof value === "string" && !value.includes("\0"))
    .map(([key, value]) => `${key}=${value}`);
  const script = acknowledge ? BOOTSTRAP.replace('exec "$@"', 'printf "isolated\\n" >&3\nexec 3>&-\nexec "$@"') : BOOTSTRAP;
  return ["/usr/bin/sandbox-exec", ["-p", profile({ assetPort }), "/bin/sh", "-c", script,
    "maclauncher-network", String(assignments.length), ...assignments, command, ...args]];
}

function waitUntilApplied(child) {
  return new Promise((resolve, reject) => {
    const stream = child.stdio?.[3];
    if (!stream) { reject(new Error("Network isolation confirmation is unavailable. The game was not started.")); return; }
    let response = "", finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      stream.removeListener("data", data); stream.removeListener("end", end);
      stream.removeListener("error", failure); child.removeListener("error", failure);
      stream.destroy();
      error ? reject(error) : resolve();
    };
    const failure = () => finish(new Error("macOS could not enforce network isolation. The game was not started."));
    const data = chunk => {
      response += chunk.toString("ascii");
      if (response === "isolated\n") finish();
      else if (response.length >= 9) failure();
    };
    const end = () => { if (response !== "isolated\n") failure(); };
    const timer = setTimeout(failure, 5000);
    stream.on("data", data); stream.once("end", end); stream.once("error", failure); child.once("error", failure);
  });
}

module.exports = { withNetworkSettings, profile, wrap, BOOTSTRAP, assertDirect, waitUntilApplied };
