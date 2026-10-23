const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Writable = require("./writable-input");
const DockIcon = require("./dock-icon");
const { readJsonObject, writeJsonAtomic } = require("../../core/json-files");
const run = promisify(execFile), pending = new Map();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const xml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
function bundleName(title, fallback = "Application") {
  let name = String(title || fallback).normalize("NFC").replace(/[\x00-\x1f\x7f/:]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  // Finder and Dock may use the bundle filename as well as its display name.
  // Leave room for the suffix within the filesystem's byte-length limit.
  while (Buffer.byteLength(name) > 180) name = Array.from(name).slice(0, -1).join("");
  return (name.trim() || fallback) + ".app";
}
function icns(png, label = "Application") {
  if (png.length < 24 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a" || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256)
    throw new Error(label + " application icons must be 256-pixel PNG images.");
  const output = Buffer.alloc(16 + png.length);
  output.write("icns"); output.writeUInt32BE(output.length, 4);
  output.write("ic08", 8); output.writeUInt32BE(png.length + 8, 12); png.copy(output, 16);
  return output;
}
function plist(title, identifier, fingerprint, icon, executableName, showInDock = false, original = {}) {
  const fields = { ...original, CFBundleExecutable: executableName, CFBundleIdentifier: identifier, CFBundleName: title,
    CFBundleDisplayName: title, CFBundlePackageType: "APPL", CFBundleVersion: original.CFBundleVersion ?? String(parseInt(fingerprint.slice(0, 8), 16)),
    ...(icon ? { CFBundleIconFile: "Application.icns" } : {}) };
  delete fields.LSUIElement; delete fields.NSHighResolutionCapable;
  const encode = value => typeof value === "boolean" ? value ? "<true/>" : "<false/>" :
    typeof value === "number" && Number.isFinite(value) ? `<${Number.isInteger(value) ? "integer" : "real"}>${value}</${Number.isInteger(value) ? "integer" : "real"}>` :
    Array.isArray(value) ? "<array>" + value.map(encode).join("") + "</array>" :
    value && typeof value === "object" ? "<dict>" + Object.entries(value).map(([key, child]) => `<key>${xml(key)}</key>${encode(child)}`).join("") + "</dict>" : `<string>${xml(value)}</string>`;
  return '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
    Object.entries(fields).map(([key, value]) => `<key>${xml(key)}</key>${encode(value)}`).join("") +
    '<key>LSUIElement</key>' + (showInDock ? '<false/>' : '<true/>') + '<key>NSHighResolutionCapable</key>' + (original.NSHighResolutionCapable === false ? '<false/>' : '<true/>') + '</dict></plist>';
}

/** One signed Mac application entry. Runtime libraries remain
 * with their original supplier; only explicitly requested links are installed. */
async function prepare({ executablePath: sourcePath, executableName: requestedExecutableName, links = {}, resourceLinks = {}, nativeLinks = {}, directory, title, iconFile, iconHelper, showInDock = false, signal,
  identifier: requestedIdentifier, identifierPrefix = "com.maclauncher.application.", nameFallback = "Application", applicationLabel = "Application", originalInfo = {}, cloneOnly = false }, execute = run) {
  const previous = pending.get(directory) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    const executable = await fs.promises.realpath(sourcePath), sourceName = path.basename(executable);
    const executableName = requestedExecutableName ?? sourceName;
    if (typeof executableName !== "string" || !executableName || executableName === "." || executableName === ".." ||
        executableName !== path.basename(executableName) || executableName.includes("\0") || Buffer.byteLength(executableName) > 255)
      throw new Error("Application executable names must be filenames up to 255 bytes.");
    for (const name of [...Object.keys(links), ...Object.keys(resourceLinks), ...Object.keys(nativeLinks)]) if (!name || name !== path.basename(name) || name === "." || name === ".." || name.includes("\0"))
      throw new Error("Application runtime links must be filenames.");
    if (Object.hasOwn(nativeLinks, executableName) || iconFile && Object.hasOwn(resourceLinks, "Application.icns"))
      throw new Error("Application resources conflict with the owned executable or icon.");
    const stat = await fs.promises.stat(executable), png = iconFile ? await fs.promises.readFile(iconFile) : null;
    const basis = { layout: 4, executable, links, executableIdentity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs], title,
      icon: png ? hash(png) : null, iconHandler: png && iconHelper ? hash(await fs.promises.readFile(iconHelper)) : null,
      ...(png ? { iconStyle: DockIcon.style } : {}),
      ...(showInDock ? { showInDock: true } : {}), ...(executableName !== sourceName ? { executableName } : {}),
      ...(Object.keys(resourceLinks).length ? { resourceLinks } : {}), ...(Object.keys(nativeLinks).length ? { nativeLinks } : {}),
      ...(requestedIdentifier ? { identifier: requestedIdentifier } : {}), ...(Object.keys(originalInfo).length ? { originalInfo } : {}), ...(cloneOnly ? { cloneOnly: true } : {}) };
    const fingerprint = hash(JSON.stringify(basis)), app = path.join(directory, bundleName(title, nameFallback));
    const identifier = requestedIdentifier || identifierPrefix + hash(path.resolve(directory)).slice(0, 24);
    const executablePath = path.join(app, "Contents/MacOS", executableName), receipt = path.join(directory, "application.json");
    const applyIcon = async () => {
      if (!png || !iconHelper) return true;
      try {
        // Assign the prepared icon directly; IconServices would otherwise add
        // a second background around the generated application artwork.
        await execute(iconHelper, [app], { signal, timeout: 10000, maxBuffer: 65536 });
        return true;
      } catch (error) {
        signal?.throwIfAborted();
        console.warn(applicationLabel + " application icon could not be updated: " + error.message);
        return false;
      }
    };
    const previousReceipt = readJsonObject(receipt);
    if (previousReceipt?.fingerprint === fingerprint && fs.existsSync(executablePath)) {
      if (previousReceipt.iconApplied === false) writeJsonAtomic(receipt, { ...previousReceipt, iconApplied: await applyIcon() });
      return { executablePath, app, identifier };
    }
    Writable.assertOwnDirectory(path.dirname(directory), directory);
    const temporary = await fs.promises.mkdtemp(path.join(directory, ".application-"));
    try {
      const staged = path.join(temporary, bundleName(title, nameFallback)), contents = path.join(staged, "Contents");
      await fs.promises.mkdir(path.join(contents, "MacOS"), { recursive: true });
      await fs.promises.mkdir(path.join(contents, "Resources"));
      const destination = path.join(contents, "MacOS", executableName);
      if (cloneOnly) await require("./runtime/clone-file").prepareClones([[executable, destination]], signal);
      else await fs.promises.copyFile(executable, destination, fs.constants.COPYFILE_FICLONE);
      await fs.promises.chmod(path.join(contents, "MacOS", executableName), 0o755);
      for (const [name, source] of Object.entries(links)) {
        if (fs.existsSync(source)) await fs.promises.symlink(source, path.join(contents, name));
      }
      for (const [base, entries] of [["Resources", resourceLinks], ["MacOS", nativeLinks]]) for (const [name, source] of Object.entries(entries))
        await fs.promises.symlink(source, path.join(contents, base, name));
      if (png) await fs.promises.writeFile(path.join(contents, "Resources/Application.icns"), icns(await DockIcon.render(iconFile, { signal }), applicationLabel));
      await fs.promises.writeFile(path.join(contents, "Info.plist"), plist(title, identifier, fingerprint, Boolean(png), executableName, showInDock, originalInfo));
      // Only the owned entry is re-signed. Linked supplier code is unchanged.
      await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--preserve-metadata=entitlements,flags,runtime", staged],
        { signal, timeout: 30000, maxBuffer: 65536 });
      signal?.throwIfAborted();
      await fs.promises.rm(app, { recursive: true, force: true });
      await fs.promises.rename(staged, app);
      writeJsonAtomic(receipt, { fingerprint, basis, iconApplied: await applyIcon() });
      const previousName = previousReceipt?.basis?.layout === 1 ? "Application.app" :
        previousReceipt?.basis?.layout >= 2 ? bundleName(previousReceipt.basis.title, nameFallback) : null;
      if (previousName && previousName !== path.basename(app)) await fs.promises.rm(path.join(directory, previousName), { recursive: true, force: true });
      return { executablePath, app, identifier };
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
  });
  pending.set(directory, operation);
  try { return await operation; } finally { if (pending.get(directory) === operation) pending.delete(directory); }
}
async function isolation(application) {
  let cache;
  try { cache = await require("./runtime/metal-cache").prepare({ identifier: application.identifier }); }
  catch (error) { console.warn("Native shader cache is unavailable: " + error.message); }
  return { readDirectories: [application.app], writeDirectories: cache?.writeDirectories || [],
    machServices: cache?.machServices || [], fileExtensions: { ...cache?.fileExtensions, read: [application.app] } };
}
module.exports = { prepare, isolation, bundleName, icns, plist };
