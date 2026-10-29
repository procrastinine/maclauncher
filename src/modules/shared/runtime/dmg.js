const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { copyAppBundle } = require("./app-bundle");
const { throwIfAborted } = require("./download-utils");
const execute = promisify(execFile);

async function extractDmg(archivePath, destination, signal, { payloadName, project = "Runtime", run = execute, copy = copyAppBundle } = {}) {
  if (!archivePath.endsWith(".dmg")) throw new Error(`${project} requires a macOS disk image.`);
  if (typeof payloadName !== "string" || !payloadName || path.basename(payloadName) !== payloadName || [".", ".."].includes(payloadName))
    throw new Error("Invalid disk image payload name.");
  throwIfAborted(signal);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-runtime-mount-"));
  let attached = false, attachStarted = false;
  try {
    attachStarted = true;
    await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, archivePath],
      { signal, timeout: 60000, maxBuffer: 64 * 1024 });
    attached = true;
    throwIfAborted(signal);
    const source = path.join(mount, payloadName);
    if (!fs.existsSync(source)) throw new Error(`The ${project} disk image does not contain ${payloadName}.`);
    copy(source, path.join(destination, payloadName));
    throwIfAborted(signal);
  } finally {
    // An interrupted attach can already have mounted the image. Cleanup must
    // also run after cancellation, without inheriting the cancelled signal.
    let detached = false;
    if (attachStarted) {
      try {
        await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000, maxBuffer: 64 * 1024 });
        detached = true;
      } catch (error) { if (attached) throw error; }
    }
    if (detached) fs.rmSync(mount, { recursive: true, force: true });
    else { try { fs.rmdirSync(mount); } catch {} }
  }
}

module.exports = { extractDmg };
