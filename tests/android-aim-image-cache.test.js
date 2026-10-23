const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { imageIdentity, directoryForImage } = require("../src/modules/android/providers/aim/image-cache");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("AIM image preparations follow the image closure rather than the host build", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-aim-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { version: "host-1", root: path.join(root, "runtime"), manifest: { files: [] } };
  function file(name, contents) {
    const target = path.join(runtime.root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
    runtime.manifest.files = [...runtime.manifest.files.filter(row => row.path !== name), { path: name, sha256: sha(contents) }];
  }
  file("image/overlay.toml", 'schema = 1\n[[add]]\npath = "/vendor/file"\nsource = "image/file"\n[[include]]\nsource = "target/overlay.toml"\n');
  file("target/overlay.toml", "schema = 1\n[[replace]]\npath = '/system/file'\nsource = 'target/file' # generated source\n");
  file("image/file", "image input"); file("target/file", "generated input"); file("bin/host", "old host");
  const image = { sha256: "1".repeat(64), version: "android-16" }, identity = imageIdentity(runtime, image);
  const userData = path.join(root, "data"), fresh = directoryForImage(userData, runtime, image);
  assert.equal(fresh, path.join(userData, "android/runtimes/aim/images", identity));
  assert.equal(fs.existsSync(userData), false, "Read-only location lookup creates no state");
  file("bin/host", "new host"); runtime.version = "host-2";
  assert.equal(imageIdentity(runtime, image), identity, "An independently versioned host does not rebuild an unchanged image");
  const legacy = path.join(userData, "android/runtimes/aim/host-1"), dmg = path.join(legacy, "system.dmg");
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(dmg, "retained image");
  const aliases = [{ identity, versions: ["host-1"] }];
  assert.equal(directoryForImage(userData, runtime, image, aliases), legacy);
  assert.equal(fs.readFileSync(dmg, "utf8"), "retained image", "A compatible location is reused without moving or rewriting it");
  assert.equal(directoryForImage(userData, runtime, image, []), fresh, "Unknown legacy generations are never scanned");
  file("target/file", "changed generated input");
  assert.notEqual(imageIdentity(runtime, image), identity);
  assert.notEqual(directoryForImage(userData, runtime, image, aliases), legacy, "Changed overlays do not reuse a known compatible derived image");
  assert.notEqual(imageIdentity(runtime, { ...image, sha256: "2".repeat(64) }), imageIdentity(runtime, image));
  fs.appendFileSync(path.join(runtime.root, "image/overlay.toml"), "# tampered\n");
  assert.throws(() => imageIdentity(runtime, image), /changed/);
});

test("AIM image cache rejects aliased directories and incomplete source inventories", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-aim-image-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, "runtime"), contents = 'schema = 1\n[[add]]\nsource = "missing"\n';
  fs.mkdirSync(path.join(payload, "image"), { recursive: true }); fs.writeFileSync(path.join(payload, "image/overlay.toml"), contents);
  const runtime = { root: payload, manifest: { files: [{ path: "image/overlay.toml", sha256: sha(contents) }] } }, image = { sha256: "1".repeat(64) };
  assert.throws(() => imageIdentity(runtime, image), /incomplete/);
  runtime.manifest.files.push({ path: "missing", sha256: sha("input") });
  const userData = path.join(root, "data"); fs.mkdirSync(userData); fs.symlinkSync(payload, path.join(userData, "android"));
  assert.throws(() => directoryForImage(userData, runtime, image), /aliases/);
});
