const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Reader = require("../src/modules/android/tools/apk-metadata");

// A resources-only layout prevents a development runtime or Java installation
// from supplying an omitted import dependency.
test("Included APK reader works from packaged resources and rejects changed helper bytes", async t => {
  if (process.platform !== "darwin") return t.skip("Requires macOS native APK resource decoding");
  const pin = require("../src/modules/android/distribution-included.json").find(item => item.id === "android-apk-metadata");
  if (!pin) return t.skip("Requires the included APK reader payload");
  const original = Reader.resolve();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-apk-delivery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resourceRoot = path.join(directory, "MacLauncher.app", "Contents", "Resources");
  const target = path.join(resourceRoot, "native-runtimes", pin.directoryRelative);
  for (const item of pin.files) {
    const file = path.join(target, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(original.root, item.path), file, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(file, item.mode);
  }
  const reader = Reader.createReader({ declaration: pin, resourceRoot });
  assert.equal(reader.resolve().root, target);
  const outputDirectory = path.join(directory, "output"); fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const parentExitListeners = process.listenerCount("exit");
  let child;
  const value = await reader.inspect({
    sourceApks: [path.join(__dirname, "fixtures/android-package-metadata/metadata.apk")],
    locale: "fr-FR", outputDirectory,
    context: { onToolProcessSpawn(process, options) {
      assert.equal(options.stopOnLauncherExit, true); child = process;
    } },
  });
  assert.equal(value.label, "Jeu Métadonnées");
  assert.equal(value.packageName, "org.maclauncher.metadata.fixture");
  assert.equal(child.exitCode, 0, "The helper closes before borrowed inputs can be released");
  assert.equal(process.listenerCount("exit"), parentExitListeners, "Completed readers release their parent-exit owner");
  assert.equal(fs.readFileSync(value.iconFile).readUInt32BE(16), 256);
  assert.deepEqual(fs.readdirSync(path.join(resourceRoot, "native-runtimes")), ["android-apk-metadata"]);
  const cancellation = new AbortController(), cancelledOutput = path.join(directory, "cancelled");
  fs.mkdirSync(cancelledOutput, { mode: 0o700 });
  let cancelledChild;
  await assert.rejects(reader.inspect({ sourceApks: [path.join(__dirname, "fixtures/android-package-metadata/metadata.apk")],
    locale: "en-US", outputDirectory: cancelledOutput, context: { signal: cancellation.signal,
      onToolProcessSpawn(process) { cancelledChild = process; cancellation.abort(new Error("Cancelled package import")); } } }), /Cancelled package import/);
  assert.equal(cancelledChild.signalCode, "SIGKILL", "Cancellation settles after the real helper closes");
  assert.deepEqual(fs.readdirSync(cancelledOutput), []);
  assert.equal(process.listenerCount("exit"), parentExitListeners);
  const executable = reader.resolve().executable, originalBytes = fs.readFileSync(original.executable);
  const changed = fs.readFileSync(executable); changed[changed.length - 1] ^= 1;
  fs.writeFileSync(executable, changed);
  assert.throws(() => reader.resolve(), /checksum or permissions changed/);
  await assert.rejects(reader.inspect({ sourceApks: [path.join(__dirname, "fixtures/android-package-metadata/metadata.apk")],
    locale: "en-US", outputDirectory, context: { onToolProcessSpawn() { assert.fail("A changed reader cannot execute"); } } }), /checksum or permissions changed/);
  assert.deepEqual(fs.readFileSync(original.executable), originalBytes, "The installed helper was not modified by the check");
});
