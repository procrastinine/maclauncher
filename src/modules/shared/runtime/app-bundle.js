const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function plistPath(appPath) {
  return path.join(String(appPath || ""), "Contents", "Info.plist");
}

const MAX_PLIST_BYTES = 1024 * 1024;

function readBundleBytes(filePath, detection, maximum) {
  let fd;
  try {
    const stat = detection?.stat ? detection.stat(filePath) : fs.statSync(filePath);
    if (!stat?.isFile() || stat.size > maximum) return null;
    if (detection?.readBytes) return detection.readBytes(filePath, 0, stat.size);
    fd = fs.openSync(filePath, "r");
    const data = Buffer.alloc(stat.size);
    return data.subarray(0, fs.readSync(fd, data, 0, data.length, 0));
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readInfoPlist(appPath, { detection } = {}) {
  const infoPath = plistPath(appPath);
  const raw = readBundleBytes(infoPath, detection, MAX_PLIST_BYTES);
  if (!raw || raw.length < 16) return null;

  try {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: raw, encoding: "utf8", timeout: 1000, maxBuffer: 2 * MAX_PLIST_BYTES
    });
    if (result.status === 0 && result.stdout) {
      const parsed = JSON.parse(result.stdout);
      return parsed && typeof parsed === "object" ? parsed : null;
    }
    if (process.platform === "darwin") return null;
  } catch {}

  try {
    const header = raw.subarray(0, 6).toString("utf8");
    if (header === "bplist") return null;
    const text = raw.toString("utf8");
    const fields = ["CFBundleExecutable", "CFBundlePackageType", "CFBundleShortVersionString", "CFBundleVersion", "CFBundleName", "CFBundleDisplayName", "CFBundleIdentifier", "CFBundleIconFile"];
    return Object.fromEntries(fields.map(key => [key, text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]?.trim() || null]));
  } catch {
    return null;
  }
}

// Publisher bundles can omit the .app suffix. Identify those by their declared
// application entry, without scanning resources or accepting an arbitrary folder.
function inspectApplicationBundle(appPath, { detection } = {}) {
  try {
    const stat = value => detection?.stat ? detection.stat(value) : fs.statSync(value);
    if (!stat(appPath)?.isDirectory()) return null;
    const root = fs.realpathSync(appPath);
    if (!isContained(root, fs.realpathSync(plistPath(appPath)))) return null;
    const plist = readInfoPlist(appPath, { detection });
    const name = normalizeExecutableName(plist?.CFBundleExecutable);
    if (plist?.CFBundlePackageType !== "APPL" || !name) return null;
    const executablePath = path.join(appPath, "Contents", "MacOS", name);
    const executable = stat(executablePath);
    if (!executable?.isFile() || !(executable.mode & 0o111)) return null;
    if (!isContained(root, fs.realpathSync(executablePath))) return null;
    // Only the executable prefix is needed; binaries and publisher scripts stay
    // read-only. No executable or interpreter is run during identification.
    let prefix;
    if (detection?.readBytes) prefix = detection.readBytes(executablePath, 0, 4);
    else {
      let fd;
      try { fd = fs.openSync(executablePath, "r"); prefix = Buffer.alloc(4); prefix = prefix.subarray(0, fs.readSync(fd, prefix, 0, 4, 0)); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    const magic = prefix?.length >= 4 ? prefix.readUInt32BE(0) : 0;
    if (prefix?.subarray(0, 2).toString("ascii") !== "#!" && ![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return null;
    return { plist, executablePath };
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  }
}

function readAppBundleExecutableName(appPath) {
  const plist = readInfoPlist(appPath);
  return normalizeExecutableName(plist?.CFBundleExecutable);
}

function normalizeExecutableName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  // CFBundleExecutable is a filename in Contents/MacOS, not a relative path.
  return name && name !== "." && name !== ".." && !name.includes("\0") && path.basename(name) === name
    ? name
    : null;
}

function readAppBundleVersion(appPath) {
  const plist = readInfoPlist(appPath);
  return typeof plist?.CFBundleShortVersionString === "string" &&
    plist.CFBundleShortVersionString.trim()
    ? plist.CFBundleShortVersionString.trim()
    : null;
}

function resolveAppBundleExecutablePath(appPath, preferredName) {
  if (!appPath) return null;

  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (!existsDir(macosDir)) return null;

  const preferredExecutableName = normalizeExecutableName(preferredName);
  if (preferredExecutableName) {
    const preferred = path.join(macosDir, preferredExecutableName);
    if (existsFile(preferred)) return preferred;
  }

  const fromPlist = readAppBundleExecutableName(appPath);
  if (fromPlist) {
    const direct = path.join(macosDir, fromPlist);
    if (existsFile(direct)) return direct;
  }

  const bundleName = path.basename(appPath, ".app");
  if (bundleName) {
    const direct = path.join(macosDir, bundleName);
    if (existsFile(direct)) return direct;
  }

  try {
    const entries = fs.readdirSync(macosDir, { withFileTypes: true });
    const file = entries.find(entry => entry.isFile());
    return file ? path.join(macosDir, file.name) : null;
  } catch {
    return null;
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validateAppBundle(appPath, { executablePath, allowContainedAbsoluteSymlinks = false } = {}) {
  const requestedRoot = path.resolve(String(appPath || ""));
  if (!appPath || !existsDir(requestedRoot) || !fs.lstatSync(requestedRoot).isDirectory()) {
    throw new Error("App bundle directory is missing or is a symlink.");
  }
  const root = fs.realpathSync(requestedRoot);
  if (!existsFile(plistPath(root))) throw new Error("App bundle Contents/Info.plist is missing.");
  const executable = executablePath || resolveAppBundleExecutablePath(root);
  if (!executable || !existsFile(executable)) throw new Error("App bundle executable is missing.");
  const requestedExecutable = path.resolve(executable);
  const executableInRoot = isContained(requestedRoot, requestedExecutable)
    ? path.join(root, path.relative(requestedRoot, requestedExecutable))
    : requestedExecutable;
  const executableRelative = path.relative(root, executableInRoot);
  const resolvedExecutable = fs.realpathSync(executable);
  if (!isContained(path.join(root, "Contents", "MacOS"), path.join(root, executableRelative)) ||
      !isContained(root, resolvedExecutable)) {
    throw new Error("App bundle executable escapes Contents/MacOS or the bundle.");
  }
  if (!(fs.statSync(executable).mode & 0o111)) throw new Error("App bundle executable has no execute permission.");

  const symlinks = [];
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relativePath = path.relative(root, full);
      if (entry.name === "_CodeSignature" && !existsFile(path.join(full, "CodeResources"))) {
        throw new Error(`App bundle signature resources are missing: ${relativePath}/CodeResources`);
      }
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        let resolvedTarget;
        try {
          resolvedTarget = fs.realpathSync(full);
        } catch {
          throw new Error(`App bundle symlink is broken or cyclic: ${relativePath}`);
        }
        if (!isContained(root, resolvedTarget) ||
            (!path.isAbsolute(target) && !isContained(root, path.resolve(directory, target)))) {
          throw new Error(`App bundle symlink escapes the bundle: ${relativePath}`);
        }
        if (path.isAbsolute(target) && !allowContainedAbsoluteSymlinks) {
          throw new Error(`App bundle symlink uses an absolute target: ${relativePath}`);
        }
        let normalizedTarget = target;
        if (path.isAbsolute(target)) {
          // Keep alias chains when possible, accounting for macOS's /var -> /private/var alias.
          const targetInRoot = isContained(root, target)
            ? target
            : isContained(requestedRoot, target)
              ? path.join(root, path.relative(requestedRoot, target))
              : resolvedTarget;
          normalizedTarget = path.relative(directory, targetInRoot) || ".";
        }
        symlinks.push({ relativePath, target, normalizedTarget });
      } else if (entry.isDirectory()) {
        directories.push(full);
      } else if (!entry.isFile()) {
        throw new Error(`App bundle contains an unsupported file type: ${relativePath}`);
      }
    }
  }
  return { appPath: root, executableRelative, symlinks };
}

function appBundleStatus(appPath, options) {
  try {
    validateAppBundle(appPath, options);
    return { ready: true, reason: null };
  } catch (error) {
    return { ready: false, reason: String(error?.message || error) };
  }
}

function appBundleLaunchCommand(appPath, args, { executablePath, preferredName } = {}) {
  const executable = executablePath || resolveAppBundleExecutablePath(appPath, preferredName);
  const inspected = validateAppBundle(appPath, { executablePath: executable });
  // Executing inside the bundle retains its macOS identity and tracks the game PID itself.
  return { command: path.join(path.resolve(appPath), inspected.executableRelative), args: Array.from(args || []) };
}

function resolveProspectivePath(filePath) {
  const missing = [];
  let existing = filePath;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function copyAppBundle(sourceAppPath, destAppPath) {
  // Validate before creating or replacing anything at the destination. Source bundles are read-only.
  const source = validateAppBundle(sourceAppPath, { allowContainedAbsoluteSymlinks: true });
  const destination = path.resolve(destAppPath);
  const resolvedDestination = resolveProspectivePath(destination);
  if (isContained(source.appPath, resolvedDestination) || isContained(resolvedDestination, source.appPath)) {
    throw new Error("App bundle source and destination overlap.");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), ".maclauncher-app-"));
  const staged = path.join(temporary, "payload.app");
  const previous = path.join(temporary, "previous.app");
  let keepTemporary = false;
  try {
    fs.cpSync(source.appPath, staged, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true
    });
    for (const link of source.symlinks) {
      if (link.target === link.normalizedTarget) continue;
      const copiedLink = path.join(staged, link.relativePath);
      fs.unlinkSync(copiedLink);
      fs.symlinkSync(link.normalizedTarget, copiedLink);
    }
    validateAppBundle(staged, { executablePath: path.join(staged, source.executableRelative) });
    let replaced = false;
    try {
      fs.lstatSync(destination);
      fs.renameSync(destination, previous);
      replaced = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      fs.renameSync(staged, destination);
    } catch (error) {
      if (replaced) {
        try {
          fs.renameSync(previous, destination);
        } catch (restoreError) {
          keepTemporary = true;
          throw new Error(`App bundle publication failed; previous bundle retained at ${previous}.`, {
            cause: restoreError
          });
        }
      }
      throw error;
    }
    return { appPath: destination, executablePath: path.join(destination, source.executableRelative) };
  } finally {
    if (!keepTemporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  readInfoPlist,
  inspectApplicationBundle,
  readAppBundleExecutableName,
  readAppBundleVersion,
  resolveAppBundleExecutablePath,
  validateAppBundle,
  appBundleStatus,
  appBundleLaunchCommand,
  copyAppBundle,
  __test: {
    plistPath,
    existsDir,
    existsFile
  }
};
