const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { copyAppBundle } = require("./app-bundle");
const { throwIfAborted } = require("./download-utils");
const { locatePackaged } = require("./release-files");
const execute = promisify(execFile);

// macOS 27 deprecates `hdiutil attach` in favour of `diskutil image attach`.
// A macOS without that verb, or an attach it cannot complete, uses hdiutil;
// each tool detaches what it attached.
const TOOLS = {
  diskutil: { attach: (image, mount) => ["/usr/sbin/diskutil", ["image", "attach", "--readOnly", "--nobrowse", "--mountPoint", mount, image]],
    detach: mount => ["/usr/sbin/diskutil", ["eject", mount]] },
  hdiutil: { attach: (image, mount) => ["/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, image]],
    detach: mount => ["/usr/bin/hdiutil", ["detach", mount]] }
};
const mounted = mount => { try { return fs.statSync(mount).dev !== fs.statSync(path.dirname(mount)).dev; } catch { return false; } };

// Without a payload name, the volume's visible files are copied; its
// Applications link and hidden layout files stay behind.
async function extractDmg(archivePath, destination, signal, { payloadName, project = "Runtime", run = execute, copy = copyAppBundle } = {}) {
  if (!archivePath.endsWith(".dmg")) throw new Error(`${project} requires a macOS disk image.`);
  if (payloadName !== undefined && (typeof payloadName !== "string" || !payloadName || path.basename(payloadName) !== payloadName || [".", ".."].includes(payloadName)))
    throw new Error("Invalid disk image payload name.");
  throwIfAborted(signal);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-runtime-mount-"));
  let attached = false, tool = null;
  try {
    for (const name of ["diskutil", "hdiutil"]) {
      tool = name;
      try {
        const [command, args] = TOOLS[name].attach(archivePath, mount);
        await run(command, args, { signal, timeout: 60000, maxBuffer: 64 * 1024 });
        break;
      } catch (error) {
        if (name === "hdiutil" || signal?.aborted) throw error;
        if (mounted(mount)) break;
      }
    }
    attached = true;
    throwIfAborted(signal);
    if (payloadName) {
      // A publisher may move the payload into a folder on the volume.
      const source = locatePackaged(mount, payloadName);
      if (!source) throw new Error(`The ${project} disk image does not contain ${payloadName}.`);
      copy(source, path.join(destination, payloadName));
    } else for (const item of fs.readdirSync(mount, { withFileTypes: true })) {
      if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
      await run("/usr/bin/ditto", [path.join(mount, item.name), path.join(destination, item.name)], { signal, timeout: 600000, maxBuffer: 64 * 1024 });
    }
    throwIfAborted(signal);
  } finally {
    // An interrupted attach can already have mounted the image. Cleanup must
    // also run after cancellation, without inheriting the cancelled signal.
    let detached = false;
    if (tool) {
      try {
        const [command, args] = TOOLS[tool].detach(mount);
        await run(command, args, { timeout: 30000, maxBuffer: 64 * 1024 });
        detached = true;
      } catch (error) { if (attached) throw error; }
    }
    if (detached) fs.rmSync(mount, { recursive: true, force: true });
    else { try { fs.rmdirSync(mount); } catch {} }
  }
}

module.exports = { extractDmg };
