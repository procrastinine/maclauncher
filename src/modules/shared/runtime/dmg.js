const fs = require("node:fs");
const Guards = require("./guards");
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

// An image with a licence agreement, such as Apple's Game Porting Toolkit
// evaluation environment, carries an LPic resource in its UDIF trailer.
// `diskutil image attach` waits for that agreement without returning, so such
// an image is attached with hdiutil.
function hasLicenceAgreement(image) {
  let fd;
  try {
    fd = fs.openSync(image, "r");
    const size = fs.fstatSync(fd).size, trailer = Buffer.alloc(512);
    if (size < 512 || fs.readSync(fd, trailer, 0, 512, size - 512) !== 512 || trailer.toString("latin1", 0, 4) !== "koly") return false;
    const offset = Number(trailer.readBigUInt64BE(216)), length = Number(trailer.readBigUInt64BE(224));
    if (!length || length > 16 * 1024 * 1024 || offset + length > size) return false;
    const xml = Buffer.alloc(length);
    fs.readSync(fd, xml, 0, length, offset);
    return xml.includes("<key>LPic</key>");
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Runs `use(volume)` while the image is attached read-only, then detaches it.
async function withMountedDmg(archivePath, signal, { run = execute } = {}, use) {
  throwIfAborted(signal);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-runtime-mount-"));
  let attached = false, tool = null;
  try {
    for (const name of hasLicenceAgreement(archivePath) ? ["hdiutil"] : ["diskutil", "hdiutil"]) {
      tool = name;
      try {
        const [command, args] = TOOLS[name].attach(archivePath, mount);
        await run(command, args, { signal, timeout: 60000, maxBuffer: Guards.limit(64 * 1024) });
        break;
      } catch (error) {
        if (name === "hdiutil" || signal?.aborted) throw error;
        if (mounted(mount)) break;
      }
    }
    attached = true;
    throwIfAborted(signal);
    const result = await use(mount);
    throwIfAborted(signal);
    return result;
  } finally {
    // An interrupted attach can already have mounted the image. Cleanup must
    // also run after cancellation, without inheriting the cancelled signal.
    let detached = false;
    if (tool) {
      try {
        const [command, args] = TOOLS[tool].detach(mount);
        await run(command, args, { timeout: 30000, maxBuffer: Guards.limit(64 * 1024) });
        detached = true;
      } catch (error) { if (attached) throw error; }
    }
    if (detached) fs.rmSync(mount, { recursive: true, force: true });
    else { try { fs.rmdirSync(mount); } catch {} }
  }
}

// A volume's visible files are copied; its Applications link and hidden
// layout files stay behind.
async function copyVolume(volume, destination, signal, { run = execute } = {}) {
  for (const item of fs.readdirSync(volume, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
    await run("/usr/bin/ditto", [path.join(volume, item.name), path.join(destination, item.name)], { signal, timeout: 600000, maxBuffer: Guards.limit(64 * 1024) });
  }
}

// Without a payload name, the volume's visible files are copied.
async function extractDmg(archivePath, destination, signal, { payloadName, project = "Runtime", run = execute, copy = copyAppBundle } = {}) {
  if (!archivePath.endsWith(".dmg")) throw new Error(`${project} requires a macOS disk image.`);
  if (payloadName !== undefined && (typeof payloadName !== "string" || !payloadName || path.basename(payloadName) !== payloadName || [".", ".."].includes(payloadName)))
    throw new Error("Invalid disk image payload name.");
  return withMountedDmg(archivePath, signal, { run }, async mount => {
    if (!payloadName) return copyVolume(mount, destination, signal, { run });
    // A publisher may move the payload into a folder on the volume.
    const source = locatePackaged(mount, payloadName);
    if (!source) throw new Error(`The ${project} disk image does not contain ${payloadName}.`);
    copy(source, path.join(destination, payloadName));
  });
}

module.exports = { extractDmg, withMountedDmg, copyVolume, hasLicenceAgreement };
