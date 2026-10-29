const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { writeZipArchive } = require("./helpers/zip-fixture");
const Fixtures = require("./helpers/android-packages");
const Runtime = require("../src/modules/android/runtime");
const Android = require("../src/modules/android/main");
const Packages = require("../src/modules/android/package-set");
const Signatures = require("../src/modules/android/tools/apk-signature");
const Google = require("../src/modules/android/providers/macapk/google-accounts");
const binary = require("../src/modules/android/tools/apksig/binary.json");
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-independent-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("uncached package inspection retains x86 and both ARM ABIs without any game runtime", async t => {
  const root = temporary(t), userDataDir = path.join(root, "empty-profile");
  fs.mkdirSync(userDataDir);
  for (const name of ["runtimeRoot", "resolveSelected", "resolveSelectedForLaunch", "resolveForLaunch"])
    t.mock.method(Runtime, name, () => assert.fail("Package inspection must not resolve an Android game runtime"));
  const manifest = Fixtures.binaryXml(Fixtures.manifest());
  for (const architectures of [["x86_64"], ["arm64-v8a", "armeabi-v7a", "x86_64"]]) {
    const file = path.join(root, architectures.length === 1 ? "x86.apk" : "all.apk");
    writeZipArchive(file, [{ name: "AndroidManifest.xml", data: manifest }, { name: "classes.dex", data: "dex\n035\0" },
      ...architectures.map(abi => ({ name: "lib/" + abi + "/liboriginal.so", data: "Original library bytes" }))]);
    for (const runtimeId of ["klepton", "macapk", "aim"]) {
      const result = await Android.actions.inspectGame({ gameId: "inspection", gamePath: file, runtimeId }, {}, { userDataDir, runtimeId });
      assert.ok(result.packageName); assert.deepEqual(result.architectures, [...architectures].sort());
      assert.equal(result.nativeAbi, null); assert.equal(result.architectureLabel, [...architectures].sort().join(", "));
    }
    if (architectures.length === 1) assert.throws(() => Packages.inspectFiles([file]), /compatible ARM/);
    else assert.equal(Packages.inspectFiles([file]).metadata.nativeAbi, "arm64-v8a", "Installation still selects one supported ABI");
  }
  const input = path.join(root, "splits"); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, "base.apk"), Fixtures.zip([["AndroidManifest.xml", manifest], ["classes.dex", Buffer.from("dex\n035\0")]]));
  for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"]) fs.writeFileSync(path.join(input, abi + ".apk"), Fixtures.zip([
    ["AndroidManifest.xml", Fixtures.binaryXml(Fixtures.manifest([], { hasCode: false }, { ":split": "config." + abi }))],
    ["lib/" + abi + "/liboriginal.so", Buffer.from("Original bytes")]]));
  const archive = path.join(root, "original.xapk");
  writeZipArchive(archive, fs.readdirSync(input).map(name => ({ name, data: fs.readFileSync(path.join(input, name)) })));
  const archived = await Android.actions.inspectGame({ gameId: "inspection", gamePath: archive, runtimeId: "aim" }, {}, { userDataDir });
  assert.deepEqual(archived.architectures, ["arm64-v8a", "armeabi-v7a", "x86_64"]);
  const noVersion = await Android.actions.inspectGame({ gameId: "inspection", gamePath: path.join(__dirname, "fixtures/android-package-metadata/metadata.apk") }, {}, { userDataDir });
  assert.equal(noVersion.versionCode, null, "Read-only inspection preserves an absent version without installer normalization");
  assert.deepEqual(fs.readdirSync(userDataDir), [], "Inspection installs no runtime, cache or profile service");
});

test("included APK signer is independent and ASAR resources become a verified physical Java input", t => {
  const root = temporary(t), userDataDir = path.join(root, "empty-profile"); fs.mkdirSync(userDataDir);
  t.mock.method(Runtime, "runtimeRoot", () => assert.fail("Mac.apk signature verification must not resolve MacLauncher Android"));
  t.mock.method(require("../src/modules/android/included-files"), "file", () => assert.fail("Stock apksig must not resolve a custom Builds helper"));
  const source = Google.signatureVerifier();
  assert.equal(source, path.resolve(__dirname, "../src/modules/android/tools/apksig/apksig.jar"));
  assert.equal(sha(source), binary.files[0].sha256);
  assert.equal(source, Signatures.resolve());
  const packaged = path.join(root, "MacLauncher.app/Contents/Resources/app.asar/src/modules/android/tools/apksig");
  fs.mkdirSync(packaged, { recursive: true }); fs.copyFileSync(source, path.join(packaged, "apksig.jar"));
  const resolve = Signatures.createResolver(packaged), materialized = resolve(userDataDir);
  assert.ok(materialized.startsWith(path.join(userDataDir, "internal-tools/apksig") + path.sep));
  assert.ok(!materialized.split(path.sep).some(part => part.endsWith(".asar")));
  assert.equal(fs.lstatSync(materialized).isFile(), true); assert.equal(sha(materialized), binary.files[0].sha256);
  const original = fs.statSync(materialized); assert.equal(resolve(userDataDir), materialized);
  assert.equal(fs.statSync(materialized).ino, original.ino, "Warm verification reuses the same physical helper");
  assert.deepEqual(fs.readdirSync(userDataDir), ["internal-tools"]);
  fs.writeFileSync(materialized, "changed"); assert.throws(() => resolve(userDataDir), /changed on disk/);
  assert.throws(() => resolve(), /private launcher storage/);
});
