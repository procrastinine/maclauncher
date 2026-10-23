const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REVISION = "ef715f65981f6c96f7f889258ff43b63cb472626";
const OVERLAY_VERSION = "maclauncher-appkit-4";
const SOURCE_HASHES = Object.freeze({
  "Cargo.toml": "f5cccfa39ddbe172084077a5ff7edbaf00bf91eac45abd70b25596e355b103f0",
  "src/platform.rs": "2f7ebc79bd49eed19754820b7c67e2c5e2597515490c63d10708ba4b2604bcaf",
  "src/connection.rs": "3a6bdda9c9bbe8ec6a0673f27b929ef5a0b6d5a8b28a7b9586ca16ff717072a1",
  "src/window.rs": "f18489a4c233572d8154ab7c3bd51117f605b9126b567c9be3f555bf5eab4983",
  "src/input.rs": "e3423cab21917cae8dfe1b8e64107ffe2c774f5e72626ab039f121de954432ba",
  "src/event.rs": "71405e1848a5b6eb22535804ff3905d7fc06f84ba3acaa5c3bff2bc07dc14b7f",
  "src/window/builder.rs": "387c1ae43ee192fc85e0bdf135d03f77b0e5fbb00a5d3cbbab4f6c8602262c94",
  "src/window/decoration.rs": "4887490b5f1306dd7757b52d0a4ca484dd2c57e8538b99daf4856b9607bbb318",
  "src/lib.rs": "a201373cb50d0b2a5ccb6f10e958077bdf55be9e876c340a8e814e1fa4d3a580"
});
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function replaceOnce(text, original, replacement, file) {
  if (!text.includes(original) || text.indexOf(original) !== text.lastIndexOf(original)) throw Error(`Pinned ramen ${file} patch context changed.`);
  return text.replace(original, replacement);
}
function applyRamenOverlay({ sourceDir, destination }) {
  if (!path.isAbsolute(sourceDir || "") || !path.isAbsolute(destination || "")) throw Error("Ramen source and owned overlay destinations must be absolute.");
  const source = fs.realpathSync(sourceDir), target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep)) throw Error("Copy ramen into an owned staging directory; upstream and Cargo cache are read-only.");
  let existingParent = path.dirname(target);
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  const resolvedTarget = path.join(fs.realpathSync(existingParent), path.relative(existingParent, target));
  if (resolvedTarget === source || resolvedTarget.startsWith(source + path.sep) ||
    resolvedTarget.includes(`${path.sep}.cargo${path.sep}`) || resolvedTarget.includes(`${path.sep}src${path.sep}external${path.sep}`)) {
    throw Error("Copy ramen into an owned staging directory; upstream and Cargo cache are read-only.");
  }
  if (fs.existsSync(target)) throw Error("Ramen overlay destination must be a new staging directory.");
  for (const [file, expected] of Object.entries(SOURCE_HASHES)) {
    const location = path.join(source, file), stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || digest(fs.readFileSync(location)) !== expected) {
      throw Error(`Ramen ${REVISION} identity check failed for ${file}; no source was patched.`);
    }
  }
  const overlay = path.join(__dirname, "ramen");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.cpSync(source, target, { recursive: true, dereference: false,
      filter: file => !path.relative(source, file).split(path.sep).includes(".git") });
    const edit = (file, transform) => fs.writeFileSync(path.join(target, file), transform(fs.readFileSync(path.join(target, file), "utf8")));
    edit("Cargo.toml", text => text + '\n[target.\'cfg(target_os = "macos")\'.build-dependencies]\ncc = "=1.2.60"\n');
    edit("src/platform.rs", text => text + '\n#[cfg(target_os = "macos")]\npub mod macos;\n#[cfg(target_os = "macos")]\npub(crate) use macos as imp;\n');
    edit("src/connection.rs", text => text.replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]'));
    edit("src/window/builder.rs", text => text.replaceAll("#[cfg(unix)]", '#[cfg(target_os = "linux")]'));
    edit("src/window.rs", text => {
      text = replaceOnce(text, "#[cfg(windows)]", '#[cfg(any(target_os = "windows", target_os = "macos"))]', "cursor dispatch");
      text = replaceOnce(text, "#[cfg(not(windows))]", '#[cfg(not(any(target_os = "windows", target_os = "macos")))]', "cursor fallback");
      return text + '\nimpl Window {\n    /// Borrowed NSView pointer for renderer attachment on the main thread.\n    #[cfg(target_os = "macos")]\n    pub fn nsview(&self) -> *mut std::ffi::c_void { self.0.nsview() }\n    /// Borrowed NSWindow pointer; it remains valid until this window is dropped.\n    #[cfg(target_os = "macos")]\n    pub fn nswindow(&self) -> *mut std::ffi::c_void { self.0.nswindow() }\n}\n';
    });
    fs.cpSync(overlay, target, { recursive: true });
    const overlayFiles = ["build.rs", "src/platform/macos.rs", "src/platform/macos/window.m"];
    const overlayHashes = Object.fromEntries(overlayFiles.map(file => [file, digest(fs.readFileSync(path.join(overlay, file)))]));
    const record = { schemaVersion: 1, dependency: "ramen", upstreamVersion: "0.0.3", upstreamRevision: REVISION,
      overlayVersion: OVERLAY_VERSION, sourceHashes: SOURCE_HASHES, overlayHashes, buildDependency: "cc=1.2.60",
      backend: "AppKit", externalFilesModified: false };
    fs.writeFileSync(path.join(target, "maclauncher-overlay.json"), JSON.stringify(record, null, 2) + "\n");
    return { sourceDir: target, ...record };
  } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
}
module.exports = { REVISION, OVERLAY_VERSION, SOURCE_HASHES, applyRamenOverlay };
