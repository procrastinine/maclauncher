// Processed screenshots. The game's frame capture writes raw processed pixels;
// the launcher encodes PNG and moves that one image into a
// visible folder and removes everything the capture staged, so no copy stays
// behind in application data.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { cloneOrCopySync } = require("../copy-file");
const CaptureFile = require("./capture-file"), crypto = require("node:crypto");

const DEFAULT_FOLDER = path.join(os.homedir(), "Pictures", "MacLauncher");

function folder(settings) {
  const chosen = settings?.graphicsScreenshotFolder;
  return typeof chosen === "string" && path.isAbsolute(chosen) && !chosen.includes("\0") ? chosen : DEFAULT_FOLDER;
}

const two = value => String(value).padStart(2, "0");
// Title and local time, in the form macOS uses for screenshots. Characters a
// file name cannot hold become spaces; the title is limited to 96 characters.
function baseName(title, date = new Date()) {
  const clean = String(title || "").replace(/[\x00-\x1f\x7f/:\\]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 96).trim() || "Screenshot";
  return `${clean} ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} at ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}

// The first free name: "<base>.png", then "<base> 2.png" and so on.
function fileName(title, date, exists = name => false) {
  const base = baseName(title, date);
  for (let index = 1; index < 1000; index++) {
    const name = base + (index > 1 ? ` ${index}` : "") + ".png";
    if (!exists(name)) return name;
  }
  throw new Error("Too many screenshots share this name.");
}

// The files a capture with this prefix stages in the launch directory.
function staged(prefix) {
  const directory = path.dirname(prefix), base = path.basename(prefix);
  let names = [];
  try { names = fs.readdirSync(directory); } catch { return []; }
  return names.filter(name => ["-before.png", "-after.png", "-before.rgba", "-after.rgba", "-neural-input.rgba", "-neural-input.png"].some(suffix => name === base + suffix) || name.startsWith(base + ".capture-"))
    .map(name => path.join(directory, name));
}

function cleanup(prefix) {
  for (const file of staged(prefix)) try { fs.unlinkSync(file); } catch {}
}

// A runtime that moves the capture channel, such as into a sandbox's writable
// folder, records the moved channel in the launch record beside the original
// prefix. The launcher then reads where captures are actually staged.
function relocate(original, channel) {
  try {
    const file = path.join(path.dirname(original), "launch.json"), launch = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!launch?.screenshotCapture || ![channel?.prefix, channel?.trigger].every(value => typeof value === "string" && path.isAbsolute(value))) return false;
    cleanup(channel.prefix);
    require("../writable-input").atomicWrite(file, JSON.stringify({...launch, screenshotCapture: {prefix: channel.prefix, trigger: channel.trigger}}));
    return true;
  } catch { return false; }
}

function request(trigger) {
  fs.writeFileSync(trigger, "", {flag: "w"});
}

// The final raw file is published by rename after its GPU readback completes.
// Diagnostic callers can convert both images explicitly through this helper.
function convert(prefix) {
  const converted = [];
  for (const suffix of ["-before", "-after", "-neural-input"]) {
    const source = prefix + suffix + ".rgba", output = prefix + suffix + ".png";
    try { fs.lstatSync(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const frame = CaptureFile.read(source), temporary = prefix + ".capture-" + crypto.randomUUID() + ".png";
    try {
      fs.writeFileSync(temporary, CaptureFile.png(frame), {flag: "wx", mode: 0o600});
      fs.utimesSync(temporary, frame.atime, frame.mtime);
      fs.renameSync(temporary, output); fs.unlinkSync(source); converted.push(output);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  return converted;
}

// Moves the processed image of a completed capture into the screenshot folder
// and clears the staged pair. Returns the saved path.
function save({prefix, title, settings, date = new Date()}) {
  const after = prefix + "-after.png";
  try {
    convert(prefix);
    const target = folder(settings);
    fs.mkdirSync(target, {recursive: true});
    const name = fileName(title, date, candidate => fs.existsSync(path.join(target, candidate)));
    const destination = path.join(target, name);
    try { fs.renameSync(after, destination); }
    catch (error) {
      if (error.code !== "EXDEV") throw error;
      cloneOrCopySync(after, destination, { exclusive: true });
    }
    return destination;
  } finally { cleanup(prefix); }
}

// Waits for the capture of one request: a processed image written after the
// request time. Resolves null when none arrives in time; staged files are
// removed either way by `save` or `cleanup`.
async function wait(prefix, requestedAt, {timeout = 5000, interval = 100, signal} = {}) {
  const after = prefix + "-after.png", until = Date.now() + timeout;
  while (Date.now() < until) {
    signal?.throwIfAborted();
    try { if (fs.statSync(after).mtimeMs >= requestedAt - 1000) return after; } catch {}
    try {
      if (fs.statSync(prefix + "-after.rgba").mtimeMs >= requestedAt - 1000) {
        convert(prefix);
        return after;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

module.exports = { DEFAULT_FOLDER, folder, baseName, fileName, staged, cleanup, relocate, request, convert, save, wait };
