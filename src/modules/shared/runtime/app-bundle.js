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

function readInfoPlist(appPath) {
  const infoPath = plistPath(appPath);
  if (!existsFile(infoPath)) return null;

  try {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], {
      encoding: "utf8"
    });
    if (result.status === 0 && result.stdout) {
      const parsed = JSON.parse(result.stdout);
      return parsed && typeof parsed === "object" ? parsed : null;
    }
  } catch {}

  try {
    const raw = fs.readFileSync(infoPath);
    if (!raw || raw.length < 16) return null;
    const header = raw.subarray(0, 6).toString("utf8");
    if (header === "bplist") return null;
    const text = raw.toString("utf8");
    return {
      CFBundleExecutable:
        text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim() ||
        null,
      CFBundleShortVersionString:
        text
          .match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
          ?.trim() || null
    };
  } catch {
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
