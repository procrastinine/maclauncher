const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const AppBundle = require("./app-bundle");

const CPU_NAMES = new Map([[0x01000007, "x86_64"], [0x0100000c, "arm64"]]);

function readAt(fd, size, offset) {
  const data = Buffer.alloc(size);
  if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("Truncated Mach-O runtime.");
  return data;
}

function readExecutableHeader(fd, offset, size, allowLibrary) {
  if (size < 32) throw new Error("Truncated Mach-O runtime.");
  const data = readAt(fd, 32, offset);
  const magic = data.readUInt32BE(0);
  const little = magic === 0xcffaedfe;
  if (!little && magic !== 0xfeedfacf) throw new Error("Runtime must be a 64-bit macOS Mach-O executable.");
  const read = position => little ? data.readUInt32LE(position) : data.readUInt32BE(position);
  if (read(12) !== 2 && !(allowLibrary && [6, 8].includes(read(12)))) throw new Error("Mach-O runtime is not an executable.");
  const architecture = CPU_NAMES.get(read(4));
  if (!architecture) throw new Error("Runtime uses an unsupported macOS CPU architecture.");
  if (read(20) > size - 32) throw new Error("Truncated Mach-O load commands.");
  return { cpu: read(4), architecture };
}

// Parse bounded headers without invoking file/lipo or executing the selected file.
function readMachOArchitectures(executablePath, { allowLibrary = false } = {}) {
  const stat = fs.statSync(executablePath);
  if (!stat.isFile() || stat.size < 32) throw new Error("Runtime must be a macOS Mach-O executable.");
  const fd = fs.openSync(executablePath, "r");
  try {
    const header = readAt(fd, 8, 0);
    const magic = header.readUInt32BE(0);
    const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
    const fat32 = magic === 0xcafebabe || magic === 0xbebafeca;
    if (!fat64 && !fat32) return [readExecutableHeader(fd, 0, stat.size, allowLibrary).architecture];
    const little = magic === 0xbfbafeca || magic === 0xbebafeca;
    const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
    const stride = fat64 ? 32 : 20;
    if (count < 1 || count > 32 || 8 + count * stride > stat.size) throw new Error("Invalid universal Mach-O header.");
    const table = readAt(fd, count * stride, 8);
    const architectures = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * stride;
      const read32 = position => little ? table.readUInt32LE(start + position) : table.readUInt32BE(start + position);
      const read64 = position => Number(little ? table.readBigUInt64LE(start + position) : table.readBigUInt64BE(start + position));
      const offset = fat64 ? read64(8) : read32(8);
      const size = fat64 ? read64(16) : read32(12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + count * stride || size < 32 || offset > stat.size - size) {
        throw new Error("Invalid universal Mach-O slice.");
      }
      const slice = readExecutableHeader(fd, offset, size, allowLibrary);
      if (slice.cpu !== read32(0)) throw new Error("Universal Mach-O slice architecture mismatch.");
      architectures.push(slice.architecture);
    }
    return Array.from(new Set(architectures));
  } finally {
    fs.closeSync(fd);
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function resolveLocalRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256, preferredExecutable, allowLibrary = false, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "darwin") throw new Error("This runtime requires a native macOS host.");
  if (typeof runtimeVersion !== "string" || !runtimeVersion.trim() || typeof upstreamRevision !== "string" || !upstreamRevision.trim()) {
    throw new Error("Choose an explicit runtime version and pinned upstream revision.");
  }
  if (typeof runtimePath !== "string" || !runtimePath.trim()) throw new Error("Choose a macOS runtime executable or .app in Runtime Settings.");
  const selected = runtimePath.trim();
  if (!path.isAbsolute(selected) || selected.includes("\0")) throw new Error("Runtime path must be an absolute local path.");
  let executablePath = selected;
  let stat;
  try {
    stat = fs.statSync(selected);
    if (stat.isDirectory() && selected.toLowerCase().endsWith(".app")) {
      executablePath = AppBundle.resolveAppBundleExecutablePath(selected, preferredExecutable);
      if (!executablePath) throw new Error("Runtime app bundle has no executable.");
      stat = fs.statSync(executablePath);
    }
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Selected macOS runtime was not found.");
    throw error;
  }
  if (!stat.isFile()) throw new Error("Choose a macOS runtime executable or .app.");
  if (!(stat.mode & 0o111)) throw new Error("Selected runtime does not have executable permission.");
  fs.accessSync(executablePath, fs.constants.X_OK);
  const architectures = readMachOArchitectures(executablePath, { allowLibrary });
  const nativeArch = arch === "x64" ? "x86_64" : arch;
  const needsRosetta = nativeArch === "arm64" && !architectures.includes("arm64") && architectures.includes("x86_64");
  if (!architectures.includes(nativeArch) && !needsRosetta) throw new Error(`Runtime does not support this Mac's ${arch} CPU.`);
  const sha256 = hashFile(executablePath);
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error("Runtime checksum changed; register the selected version again before launching.");
  return { executablePath, architectures, needsRosetta, runtimeVersion: runtimeVersion.trim(), upstreamRevision: upstreamRevision.trim(), sha256 };
}

function getLocalRuntimeStatus(options) {
  try {
    return { ready: true, ...resolveLocalRuntime(options), reason: null };
  } catch (error) {
    return { ready: false, executablePath: null, architectures: [], needsRosetta: false, reason: error.message };
  }
}

async function launchLocalRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256, preferredExecutable, args = [], cwd, context, focusOnLaunch = false }) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Runtime arguments must be a list of strings without NUL bytes.");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error("Runtime working directory must be an existing absolute directory.");
  }
  if (typeof context?.spawnDetachedChecked !== "function") throw new Error("Native process launcher is unavailable.");
  const runtime = resolveLocalRuntime({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256, preferredExecutable });
  context.logger?.info?.(`[runtime] native ${runtime.executablePath}`);
  const launchedAt = Date.now();
  const child = await context.spawnDetachedChecked(runtime.executablePath, args, { cwd }, runtime.needsRosetta);
  if (focusOnLaunch) {
    // This is opt-in for games, never native command-line tools. Registration
    // and activation occur independently of the launch/launcher response.
    void require("./native-focus").focusOwnedNativeGame(child, { executablePath: runtime.executablePath, launchedAt, logger: context.logger });
  }
  return child;
}

module.exports = { readMachOArchitectures, hashFile, resolveLocalRuntime, getLocalRuntimeStatus, launchLocalRuntime };
