const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { copyAppBundle } = require("../../shared/runtime/app-bundle");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const execute = promisify(execFile);

async function extractDmg(archivePath, destination, signal, { run = execute, copy = copyAppBundle } = {}) {
  if (!archivePath.endsWith(".dmg")) throw new Error("RFVP requires a macOS disk image.");
  throwIfAborted(signal);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rfvp-mount-"));
  let started = false, attached = false;
  try {
    started = true;
    await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, archivePath],
      { signal, timeout: 60000, maxBuffer: 64 * 1024 });
    attached = true;
    throwIfAborted(signal);
    const source = path.join(mount, "RFVP.app");
    if (!fs.existsSync(source)) throw new Error("The RFVP disk image does not contain RFVP.app.");
    copy(source, path.join(destination, "RFVP.app"));
    throwIfAborted(signal);
  } finally {
    let detached = false;
    if (started) {
      try {
        // An interrupted attach may already have mounted the image. Cleanup
        // must run without the aborted download signal.
        await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000, maxBuffer: 64 * 1024 });
        detached = true;
      } catch (error) { if (attached) throw error; }
    }
    if (detached) fs.rmSync(mount, { recursive: true, force: true });
    else { try { fs.rmdirSync(mount); } catch {} }
  }
}

module.exports = { extractDmg };
