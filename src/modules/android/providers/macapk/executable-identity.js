const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Writable = require("../../../shared/writable-input");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function embeddedPlist(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x100000c)
    throw new Error("The Mac.apk application executable is not compatible with Apple Silicon.");
  const count = bytes.readUInt32LE(16), end = 32 + bytes.readUInt32LE(20);
  if (count > 4096 || end > bytes.length) throw new Error("The Mac.apk application executable is invalid.");
  const name = offset => bytes.subarray(offset, offset + 16).toString("ascii").split("\0")[0];
  for (let offset = 32, index = 0; index < count; index++) {
    if (offset + 8 > end) break;
    const type = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) break;
    if (type === 0x19 && size >= 72) {
      const sections = bytes.readUInt32LE(offset + 64);
      if (72 + sections * 80 > size) break;
      for (let index = 0; index < sections; index++) {
        const section = offset + 72 + index * 80;
        if (name(section) !== "__info_plist" || name(section + 16) !== "__TEXT") continue;
        const length = Number(bytes.readBigUInt64LE(section + 40)), start = bytes.readUInt32LE(section + 48);
        if (length < 256 || length > 65536 || start + length > bytes.length)
          throw new Error("The Mac.apk application identity section is invalid.");
        return { offset: start, size: length, lengthOffset: section + 40 };
      }
    }
    offset += size;
  }
  throw new Error("The Mac.apk application executable has no supported application identity.");
}
function sharedLink(source, destination) {
  try { if (fs.lstatSync(destination).isSymbolicLink() && fs.readlinkSync(destination) === source) return; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = destination + ".link-" + crypto.randomBytes(8).toString("hex");
  try { fs.symlinkSync(source, temporary); fs.renameSync(temporary, destination); }
  finally { fs.rmSync(temporary, { force: true }); }
}
async function prepareExecutable({ runtime, app, label, identifier, signal }) {
  const resources = path.join(app, "Contents/Resources"), executable = path.join(resources, "macapk-runtime"), receipt = path.join(resources, "executable-identity.json");
  for (const entry of fs.readdirSync(path.join(runtime.contents, "Resources"))) {
    if (["macapk-runtime", "icon.png", "icon-source.json", "dock-icon.png", "dock-icon.json", "executable-identity.json"].includes(entry)) continue;
    sharedLink(path.join(runtime.contents, "Resources", entry), path.join(resources, entry));
  }
  for (const name of ["lib", "bin"]) sharedLink(path.join(runtime.contents, name), path.join(app, "Contents", name));
  const original = fs.readFileSync(runtime.executable), section = embeddedPlist(original);
  const identity = { CFBundleIdentifier: identifier, CFBundleName: label, CFBundleDisplayName: label, CFBundleShortVersionString: "1.0", CFBundleVersion: "1" };
  const source = digest(original), configuration = digest(JSON.stringify([2, identity]));
  try {
    const stat = fs.lstatSync(executable), marker = fs.lstatSync(receipt);
    if (stat.isFile() && !stat.isSymbolicLink() && marker.isFile() && !marker.isSymbolicLink() && marker.size < 4096) {
      const previous = JSON.parse(fs.readFileSync(receipt, "utf8"));
      if (previous.schemaVersion === 2 && previous.source === source && previous.configuration === configuration && previous.adapted === digest(fs.readFileSync(executable))) return executable;
    }
  } catch {}
  const staging = fs.mkdtempSync(path.join(resources, ".identity-"));
  try {
    const json = path.join(staging, "identity.json"), plist = path.join(staging, "identity.plist"), binary = path.join(staging, "macapk-runtime");
    fs.writeFileSync(json, JSON.stringify(identity));
    await execute("/usr/bin/plutil", ["-convert", "binary1", "-o", plist, "--", json], { signal, timeout: 10000 });
    const encoded = fs.readFileSync(plist);
    if (encoded.length > section.size) throw new Error("The Android application name is too long for this Mac.apk version.");
    // Clone only the native entry. Its dependency tree remains shared. The
    // fixed-size section write changes a few APFS blocks rather than copying
    // the managed runtime's libraries, JRE or framework.
    fs.copyFileSync(runtime.executable, binary, fs.constants.COPYFILE_FICLONE || 0);
    const patch = Buffer.alloc(section.size); encoded.copy(patch);
    const descriptor = fs.openSync(binary, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      fs.writeSync(descriptor, patch, 0, patch.length, section.offset);
      // Binary property lists locate their trailer at the declared section
      // end. Retain the original on-disk allocation while publishing the
      // precise payload length, leaving following sections and offsets intact.
      const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(encoded.length));
      fs.writeSync(descriptor, length, 0, length.length, section.lengthOffset);
    } finally { fs.closeSync(descriptor); }
    const entitlements = path.join(staging, "entitlements.plist"), entitlementJson = path.join(staging, "entitlements.json");
    const originalEntitlements = await execute("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", runtime.executable], { signal, timeout: 10000, maxBuffer: 64 * 1024 });
    fs.writeFileSync(entitlements, originalEntitlements.stdout);
    await execute("/usr/bin/plutil", ["-convert", "json", "-o", entitlementJson, "--", entitlements], { signal, timeout: 10000 });
    const values = JSON.parse(fs.readFileSync(entitlementJson, "utf8"));
    // The launcher supplies its declared graphics adapters after confinement.
    // Keep the supplier's JIT/x18 settings and hardened-runtime flags, while
    // allowing that explicitly constructed DYLD environment to take effect.
    values["com.apple.security.cs.allow-dyld-environment-variables"] = true;
    fs.writeFileSync(entitlementJson, JSON.stringify(values));
    await execute("/usr/bin/plutil", ["-convert", "xml1", "-o", entitlements, "--", entitlementJson], { signal, timeout: 10000 });
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--preserve-metadata=flags", "--entitlements", entitlements, "--identifier", identifier, binary], { signal, timeout: 30000, maxBuffer: 64 * 1024 });
    await execute("/usr/bin/codesign", ["--verify", "--strict", binary], { signal, timeout: 10000, maxBuffer: 64 * 1024 });
    const adapted = digest(fs.readFileSync(binary));
    fs.renameSync(binary, executable);
    Writable.atomicWrite(receipt, JSON.stringify({ schemaVersion: 2, source, configuration, adapted }) + "\n", { root: resources });
    return executable;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { prepareExecutable, embeddedPlist };
