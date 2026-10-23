const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("./writable-input");
const Icons = require("../../core/icon-utils");
const { runIconCommand } = require("../../core/icon-extraction");
const { readJsonObject, writeJsonAtomic } = require("../../core/json-files");

// A separate display derivative keeps imported/library artwork unchanged.
const style = "macos-rounded-v1", marker = Buffer.from("MacLauncherDock\0" + style);
const pending = new Map();
function prepared(png) {
  if (!Buffer.isBuffer(png) || png.toString("hex", 0, 8) !== "89504e470d0a1a0a") return false;
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset), end = offset + size + 12;
    if (end > png.length) return false;
    if (png.toString("ascii", offset + 4, offset + 8) === "tEXt" && png.subarray(offset + 8, end - 4).equals(marker)) return true;
    offset = end;
  }
  return false;
}
function mark(png) {
  const chunk = Buffer.alloc(marker.length + 12);
  chunk.writeUInt32BE(marker.length); chunk.write("tEXt", 4); marker.copy(chunk, 8);
  chunk.writeUInt32BE(Icons.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
async function render(source, { signal, runCommand = runIconCommand } = {}) {
  signal?.throwIfAborted();
  const stat = await fs.promises.stat(source);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("The game icon is too large to prepare.");
  const original = await fs.promises.readFile(source);
  if (prepared(original)) return original;
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "maclauncher-dock-icon-"));
  try {
    const output = path.join(temporary, "icon.png");
    await runCommand("/usr/bin/osascript", ["-l", "JavaScript", path.join(__dirname, "dock-icon.jxa"), source, output],
      { signal, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 65536 });
    const png = await fs.promises.readFile(output);
    if (!Icons.isSupportedImageBuffer(png) || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256)
      throw new Error("The game Dock icon could not be prepared.");
    return mark(png);
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
async function prepare(source, directory, options = {}) {
  const target = path.join(directory, "dock-icon.png"), receipt = path.join(directory, "dock-icon.json");
  const previous = pending.get(target) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    options.signal?.throwIfAborted();
    const bytes = await fs.promises.readFile(source);
    const identity = crypto.createHash("sha256").update(style).update(bytes).digest("hex");
    if (readJsonObject(receipt)?.identity === identity && fs.existsSync(target)) return target;
    const png = await render(source, options);
    Writable.atomicWrite(target, png, { root: directory });
    writeJsonAtomic(receipt, { identity, style });
    return target;
  });
  pending.set(target, operation);
  try { return await operation; } finally { if (pending.get(target) === operation) pending.delete(target); }
}
module.exports = { style, prepared, render, prepare };
