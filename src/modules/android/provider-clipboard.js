const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Bundled = require("../shared/runtime/bundled-native");
const Included = require("../shared/runtime/included-helpers");
function resolveHelper() {
  const declarations = require("./privacy-distribution.json"), pin = declarations[0];
  const included = Included.resolveIncluded(declarations, { id: pin.id, version: pin.version, verification: "full" });
  if (included) {
    const { directory } = included;
    return path.join(directory, "clipboard-helper");
  }
  throw new Error("The included Android clipboard helper is missing. Reinstall MacLauncher.");
}
async function create(context = {}) {
  // Darwin Unix-domain addresses have a short fixed maximum. Only the socket
  // lives here; application files and clipboard contents are never stored here.
  const socket = path.join("/private/tmp", "maclauncher-clipboard-" + crypto.randomBytes(16).toString("hex") + ".sock");
  const child = spawn(resolveHelper(), [socket], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000); timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); }); child.stdin.end();
      });
    }
    await fs.promises.rm(socket, { force: true });
  };
  try {
    await context.onToolProcessSpawn?.(child, { stopWithLauncher: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The Android clipboard helper did not start.")), 5000); timer.unref();
      let pending = "";
      const cleanup = () => { clearTimeout(timer); child.stdout.off("data", onData); child.off("error", onError); child.off("close", onClose); };
      const onData = bytes => { pending += bytes.toString(); if (pending.includes("ready\n")) { cleanup(); resolve(); } else if (pending.length > 1024) { cleanup(); reject(new Error("The Android clipboard helper returned an invalid response.")); } };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("The Android clipboard helper could not start.")); };
      child.stdout.on("data", onData); child.once("error", onError); child.once("close", onClose);
    });
    return { socket, close, enroll(pid) {
      if (closed || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("The Android clipboard process is unavailable.");
      child.stdin.write(JSON.stringify({ op: "enroll", pid }) + "\n");
    } };
  } catch (error) { await close(); throw error; }
}
module.exports = { create, resolveHelper };
