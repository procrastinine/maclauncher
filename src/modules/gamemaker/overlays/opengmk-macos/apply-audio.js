const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REVISION = "1ae3cdce620acdaa7996315c05a98a0f12ed8745";
const SOURCE_SHA256 = "78ea114057135516af51270bce24db32b3eab18b83c12aba9d2aadff1df0d778";
const OVERLAY_VERSION = "maclauncher-coreaudio-build-1";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function applyAudioOverlay({ sourceDir, destination }) {
  if (!path.isAbsolute(sourceDir || "") || !path.isAbsolute(destination || "")) throw Error("Audio overlay paths must be absolute.");
  const source = fs.realpathSync(sourceDir), target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep) || fs.existsSync(target)) throw Error("Copy the audio source into a new owned directory.");
  const buildFile = path.join(source, "build.rs"), stat = fs.lstatSync(buildFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || digest(fs.readFileSync(buildFile)) !== SOURCE_SHA256) throw Error("Pinned libsoundio build source changed.");
  const build = fs.readFileSync(buildFile, "utf8");
  if (!build.includes("    if cfg!(unix) {")) throw Error("Pinned libsoundio build context changed.");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.cpSync(source, target, { recursive: true, filter: file => !path.relative(source, file).split(path.sep).includes(".git") });
    fs.writeFileSync(path.join(target, "build.rs"), build.replace("    if cfg!(unix) {", '    if target.contains("linux") {'));
    const record = { schemaVersion: 1, upstreamRevision: REVISION, upstreamVersion: "libsoundio-sys0.3.0",
      overlayVersion: OVERLAY_VERSION, sourceSha256: SOURCE_SHA256, backend: "CoreAudio", externalFilesModified: false };
    fs.writeFileSync(path.join(target, "maclauncher-overlay.json"), JSON.stringify(record, null, 2) + "\n");
    return { sourceDir: target, ...record };
  } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
}
module.exports = { REVISION, SOURCE_SHA256, OVERLAY_VERSION, applyAudioOverlay };
