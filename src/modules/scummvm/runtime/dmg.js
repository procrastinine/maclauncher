const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { copyAppBundle } = require("../../shared/runtime/app-bundle");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const execute = promisify(execFile);

async function extractDmg(archivePath, destination, signal, { run = execute, copy = copyAppBundle, payloadName = "ScummVM.app" } = {}) {
  if (!archivePath.endsWith(".dmg")) throw new Error("ScummVM requires a macOS disk image.");
  throwIfAborted(signal);
  // Disk images cannot be mounted on some external/network filesystems. The
  // system temporary directory supplies a local mount independently of storage.
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-scummvm-mount-"));
  let attached = false, attachStarted = false;
  try {
    attachStarted = true;
    await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, archivePath],
      { signal, timeout: 60000, maxBuffer: 64 * 1024 });
    attached = true;
    throwIfAborted(signal);
    const source = path.join(mount, payloadName);
    if (!fs.existsSync(source)) throw new Error(`The ScummVM disk image does not contain ${payloadName}.`);
    copy(source, path.join(destination, payloadName));
    throwIfAborted(signal);
  } finally {
    // An interrupted attach can already have mounted the image. Try detaching
    // without the cancelled signal even if attach did not return successfully.
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
