const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Application = require("../../application");
const Writable = require("../../../shared/writable-input");
const GameData = require("../../../shared/game-data");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function png(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 24 || stat.size > 16 * 1024 * 1024) return false;
    const bytes = fs.readFileSync(file);
    return bytes.toString("hex", 0, 8) === "89504e470d0a1a0a" && bytes.readUInt32BE(16) === 256 && bytes.readUInt32BE(20) === 256;
  } catch { return false; }
}
function resolveIcon(storage) {
  try {
    const file = fs.readlinkSync(path.join(storage.runtimeRoot, "application-icon.png"));
    const userDataDir = path.resolve(storage.gameRoot, "../../..");
    const expected = path.join(GameData.resolveGameIconsDir(userDataDir, path.basename(storage.gameRoot)), "android.png");
    return file === expected && png(file) ? file : null;
  } catch { return null; }
}
function sharedLink(source, target) {
  try { if (fs.lstatSync(target).isSymbolicLink() && fs.readlinkSync(target) === source) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = target + ".link-" + crypto.randomUUID();
  try { fs.symlinkSync(source, temporary); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

async function prepareIdentity({ entry, context, storage, packageSet, runtime, prepared, descriptor, policy }) {
  context.signal?.throwIfAborted();
  const title = String(entry.name || packageSet.metadata.label || packageSet.metadata.packageName || "Android game").replace(/[\x00-\x1f\x7f]/g, " ").trim() || "Android game";
  const icons = GameData.resolveGameIconsDir(context.userDataDir, entry.gameId);
  Writable.assertOwnDirectory(context.userDataDir, icons);
  const icon = path.join(icons, "android.png"), marker = path.join(icons, "aim-icon.json");
  let custom = entry.iconSource !== "module" && entry.iconSource !== "module-default" && entry.iconPath !== icon && path.isAbsolute(entry.iconPath || "") ? entry.iconPath : null;
  let customIdentity = null;
  if (custom) {
    try { const stat = fs.statSync(custom); if (!stat.isFile()) custom = null; else customIdentity = [custom, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { custom = null; }
  }
  const key = digest(JSON.stringify([packageSet.key, runtime.version, customIdentity]));
  let previous;
  try { previous = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (previous?.key !== key || !png(icon)) {
    const stage = fs.mkdtempSync(path.join(storage.temporary, "aim-icon-")), rendered = path.join(stage, "icon.png");
    try {
      if (custom) await execute("/usr/bin/sips", ["-s", "format", "png", "-z", "256", "256", custom, "--out", rendered], { signal: context.signal, timeout: 15000, maxBuffer: 65536 });
      else {
        const framework = path.join(prepared.image, "system/framework/framework-res.apk");
        const input = packageSet.base.file;
        const rendering = { ...descriptor, command: path.join(runtime.bin, "aim-apps"),
          args: ["icon", input, "--framework", framework, "--out", rendered, "--size", "256"],
          readFiles: [...(descriptor.readFiles || []), input, framework] };
        const isolated = await require("../../policy").prepareIsolation(rendering, storage, policy, { signal: context.signal });
        await execute(isolated.command, isolated.args, { env: isolated.environment, cwd: storage.root, signal: context.signal, timeout: 30000, maxBuffer: 65536 });
      }
      if (!png(rendered)) throw new Error("The Android application icon could not be rendered.");
      Writable.atomicCopy(rendered, icon, { root: icons });
      Writable.atomicWrite(marker, JSON.stringify({ key }) + "\n", { root: icons });
    } catch (error) {
      context.signal?.throwIfAborted();
      context.logger?.warn?.("The Android application icon could not be prepared.");
      context.logger?.debug?.("Application icon renderer: " + error.message);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  // The library and providers share the rendered artwork. The bundle stores
  // only its small ICNS container, while its runtime binaries remain shared.
  const iconLink = path.join(storage.runtimeRoot, "application-icon.png");
  if (png(icon)) {
    sharedLink(icon, iconLink);
  }
  const application = await Application.prepare({ executablePath: path.join(runtime.bin, "aim-display"),
    directory: path.join(storage.runtimeRoot, "application"), title,
    executableName: Application.bundleName(title).slice(0, -4), showInDock: true,
    iconFile: png(icon) ? icon : null, signal: context.signal });
  return { ...application, title, icon: png(icon) ? icon : null };
}
module.exports = { prepareIdentity, resolveIcon };
