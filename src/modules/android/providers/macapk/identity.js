const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { promisify } = require("node:util"), execute = promisify(require("node:child_process").execFile);
const Writable = require("../../../shared/writable-input");
const DockIcon = require("../../../shared/dock-icon");
const xml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
const text = value => String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 180);
function regularIcon(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024 * 1024; }
  catch { return false; }
}
function resolveIcon(storage) {
  try {
    const directory = path.join(storage.runtimeRoot, "application"), marker = path.join(directory, "current.json"), stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const record = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (typeof record.application !== "string" || path.basename(record.application) !== record.application || !record.application.endsWith(".app")) return null;
    const app = path.join(directory, record.application);
    Writable.assertOwnDirectory(storage.runtimeRoot, path.join(app, "Contents/Resources"), { create: false });
    const icon = path.join(app, "Contents/Resources/icon.png"); return regularIcon(icon) ? icon : null;
  } catch { return null; }
}

async function prepareIdentity({ entry, context, storage, packageSet, runtime, descriptor, policy, policyJar }) {
  const label = text(entry.name) || text(packageSet?.metadata?.label) || text(packageSet?.metadata?.packageName) || "Android game";
  const name = label.replace(/[/:]/g, "-").replace(/\.apk/gi, " apk").replace(/^\.+/, "").trim() || "Android game";
  const directory = path.join(storage.runtimeRoot, "application"), app = path.join(directory, name + ".app");
  const macos = path.join(app, "Contents/MacOS"), resources = path.join(app, "Contents/Resources");
  Writable.assertOwnDirectory(storage.runtimeRoot, macos); Writable.assertOwnDirectory(storage.runtimeRoot, resources);
  let source = entry.iconSource !== "module-default" && entry.iconSource !== "module" && entry.iconPath;
  if (source && path.isAbsolute(source)) {
    try { const stat = fs.statSync(source); if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) source = null; }
    catch { source = null; }
  } else source = null;
  const icon = path.join(resources, "icon.png"), key = JSON.stringify([packageSet?.key || "", descriptor.runtime?.version,
    source ? crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex") : null]);
  const marker = path.join(resources, "icon-source.json");
  let current = false;
  try { current = fs.readFileSync(marker, "utf8") === key && regularIcon(icon); } catch {}
  if (!current) {
    if (source) Writable.atomicCopy(source, icon, { root: resources });
    else if (packageSet?.base?.file) {
      // Only the publisher's framework resource classes execute here. The
      // APK is an input to its icon renderer, never an application classpath.
      const preparation = { ...descriptor, command: runtime.java,
        args: ["-Djava.awt.headless=true", "-Duser.home=" + storage.home, "-Djava.io.tmpdir=" + storage.temporary,
          "-cp", [policyJar, runtime.framework, runtime.loader].join(path.delimiter),
          "com.maclauncher.android.macapk.IconPreparation", packageSet.base.file, resources],
        env: { ...descriptor.env, MACAPK_LOG_LEVEL: "7", MACAPK_FOLLOW_SYSTEM_APPEARANCE: "0" } };
      const isolated = await require("../../policy").prepareIsolation(preparation, storage, policy, { signal: context.signal });
      try { await execute(isolated.command, isolated.args, { env: isolated.environment, cwd: storage.androidRoot,
        signal: context.signal, timeout: 30000, maxBuffer: 64 * 1024 }); }
      catch (error) { if (context.signal?.aborted) throw error; context.logger?.warn?.("The Android package icon could not be prepared."); }
    }
    if (regularIcon(icon)) Writable.atomicWrite(marker, key, { root: resources });
  }
  const identifier = "org.maclauncher.android.macapk.g" + crypto.createHash("sha256").update(String(entry.gameId || storage.runtimeRoot)).digest("hex").slice(0, 24);
  const executable = await require("./executable-identity").prepareExecutable({ runtime, app, label, identifier, signal: context.signal });
  const command = path.join(macos, name), temporary = path.join(macos, ".link-" + crypto.randomBytes(8).toString("hex"));
  try { fs.symlinkSync(executable, temporary); fs.renameSync(temporary, command); }
  finally { fs.rmSync(temporary, { force: true }); }
  let dockIcon = null;
  if (regularIcon(icon)) {
    try { dockIcon = await DockIcon.prepare(icon, resources, { signal: context.signal }); }
    catch (error) { context.signal?.throwIfAborted(); context.logger?.debug?.("Application Dock icon: " + error.message); }
  }
  const fields = { CFBundleName: label, CFBundleDisplayName: label, CFBundleExecutable: name,
    CFBundleIdentifier: identifier, CFBundlePackageType: "APPL",
    CFBundleVersion: dockIcon ? String(parseInt(crypto.createHash("sha256").update(fs.readFileSync(dockIcon)).digest("hex").slice(0,8),16)) : "1",
    CFBundleInfoDictionaryVersion: "6.0",
    ...(dockIcon ? { CFBundleIconFile: path.basename(dockIcon) } : regularIcon(icon) ? { CFBundleIconFile: "icon.png" } : {}) };
  Writable.atomicWrite(path.join(app, "Contents/Info.plist"), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>' + Object.entries(fields).map(([key, value]) => '<key>' + key + '</key><string>' + xml(value) + '</string>').join("") + '</dict></plist>\n', { root: app });
  Writable.atomicWrite(path.join(directory, "current.json"), JSON.stringify({ application: path.basename(app) }) + "\n", { root: directory });
  return { app, command, label, identifier, icon: dockIcon || (regularIcon(icon) ? icon : null) };
}
module.exports = { prepareIdentity, resolveIcon };
