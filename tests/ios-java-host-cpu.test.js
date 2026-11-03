const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Host = require("../src/modules/shared/runtime/host-capabilities");
const Ios = require("../src/modules/ios/prepare");
const Java = require("../src/modules/java/runtime/java-runtime");
const Steam = require("../src/modules/java/runtime/steamworks/runtime");
const Consumer = require("../src/modules/java/runtime/steamworks/consumer");

function rosettaLauncher(t) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { ...descriptor, value: "x64" });
  t.after(() => Object.defineProperty(process, "arch", descriptor));
  const host = { platform: "darwin", launcherArch: "x64", hardwareArch: "arm64", translated: true, rosettaAvailable: true };
  t.mock.method(Host, "getHostCapabilities", () => host);
  assert.equal(process.arch, "x64");
  return host;
}
function cachedIos(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ios-host-cpu-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.ipa"), root = path.join(directory, "cache"), framework = path.join(directory, "PlayTools.framework");
  fs.writeFileSync(source, "cached original IPA");fs.mkdirSync(framework);fs.writeFileSync(path.join(framework, "PlayTools"), "cached PlayTools");
  const prepared = path.join(root, "prepared"), app = "Owned.app", executable = path.join(app, "Owned");
  fs.mkdirSync(path.join(prepared, app), { recursive: true });fs.writeFileSync(path.join(prepared, executable), "cached converted executable");
  const identity = file => { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].map(String).join(":"); };
  const frameworkHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(framework, "PlayTools"))).digest("hex");
  fs.writeFileSync(path.join(root, "prepared.json"), JSON.stringify({ version: 3, source, sourceIdentity: identity(source), toolsHash: frameworkHash,
    dependencyIdentity: "[]", app, executable, bundleId: "org.example.owned", files: [[executable, identity(path.join(prepared, executable))]] }));
  return { options: { source, root, framework, frameworkHash }, executablePath: path.join(prepared, executable), appRoot: path.join(prepared, app) };
}

test("PlayCover reuses a prepared ARM app from an Intel launcher on Apple Silicon", async t => {
  const host = rosettaLauncher(t), fixture = cachedIos(t);
  assert.equal(host.hardwareArch, "arm64");
  const prepared = await Ios.prepare(fixture.options);
  assert.equal(prepared.executablePath, fixture.executablePath);
  assert.equal(prepared.appRoot, fixture.appRoot);
  assert.equal(prepared.bundleId, "org.example.owned");
  host.hardwareArch = "x64";host.translated = false;
  await assert.rejects(Ios.prepare(fixture.options), /requires an Apple Silicon Mac/);
  assert.equal(fs.readFileSync(fixture.executablePath, "utf8"), "cached converted executable");
});

test("Java retains an Intel launcher default while deriving Rosetta and runnable alternatives from hardware", t => {
  const host = rosettaLauncher(t), choose = Java.__test.chooseVariantForHost;
  assert.equal(Java.defaultVariantForHost(), "x64", "Hardware must not silently change the launcher's runtime default");
  const options = { availableVariants: new Set(["arm64", "x64"]), preferredVariant: null };
  assert.deepEqual(choose(options), { variant: "x64", requiresRosetta: true, mode: "rosetta" });
  assert.deepEqual(choose({ ...options, preferredVariant: "arm64" }), { variant: "arm64", requiresRosetta: false, mode: "native" });
  host.hardwareArch = "x64";host.translated = false;
  assert.deepEqual(choose(options), { variant: "x64", requiresRosetta: false, mode: "native" });
  assert.equal(choose({ ...options, preferredVariant: "arm64" }).variant, "x64", "An Intel Mac cannot use an ARM preference");
});

test("Java Steam admits a selected ARM JVM under Rosetta without changing JNI or default CPU policy", t => {
  const host = rosettaLauncher(t), pin = { architectures: ["arm64", "x86_64"] };
  t.mock.method(Consumer, "requirement", () => ({ pin }));
  assert.equal(Steam.requiredVariant({}), "x64");
  assert.equal(Steam.requiredVariant({}, { explicitVariant: "arm64" }), "arm64");
  assert.equal(Steam.requiredVariant({}, { preferredVariant: "arm64" }), "arm64");
  pin.architectures = ["arm64"];
  assert.equal(Steam.requiredVariant({}), "arm64", "An ARM-only bridge can use the hardware's native JVM");
  pin.architectures = ["x86_64"];
  assert.equal(Steam.requiredVariant({}), "x64");
  assert.throws(() => Steam.requiredVariant({}, { explicitVariant: "arm64" }), { code: "JAVA_STEAM_CPU_MISMATCH" });
  pin.architectures = ["arm64", "x86_64"];host.hardwareArch = "x64";host.translated = false;
  assert.throws(() => Steam.requiredVariant({}, { explicitVariant: "arm64" }), { code: "JAVA_STEAM_CPU_UNAVAILABLE" });
  assert.equal(Steam.requiredVariant({}, { preferredVariant: "arm64" }), "x64");
  pin.architectures = ["arm64"];
  assert.throws(() => Steam.requiredVariant({}), { code: "JAVA_STEAM_CPU_UNAVAILABLE" });
});
