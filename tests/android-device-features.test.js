const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("./helpers/android-java");
const { node, binaryXml, zip } = require("./helpers/android-packages");

// Android's original TypedArray parser consumes the compiled attribute IDs.
function compiledManifest(tree) {
  const xml = binaryXml(tree), count = xml.readUInt32LE(16), poolSize = xml.readUInt32LE(12);
  const poolHeader = xml.readUInt16LE(10), data = 8 + xml.readUInt32LE(28);
  const ids = { name: 16842755, minSdkVersion: 16843276, targetSdkVersion: 16843376,
    requiredFeature: 16844116, requiredNotFeature: 16844117, hasCode: 16842764 };
  const map = Buffer.alloc(8 + count * 4); map.writeUInt16LE(0x180); map.writeUInt16LE(8, 2); map.writeUInt32LE(map.length, 4);
  for (let index = 0; index < count; index++) {
    let at = data + xml.readUInt32LE(8 + poolHeader + index * 4);
    const length = () => { const first = xml[at++]; return first & 128 ? ((first & 127) << 8) | xml[at++] : first; };
    length(); const bytes = length(), name = xml.subarray(at, at + bytes).toString("utf8");
    map.writeUInt32LE(ids[name] || 0, 8 + index * 4);
  }
  for (let at = 8 + poolSize; at < xml.length; at += xml.readUInt32LE(at + 4)) {
    if (xml.readUInt16LE(at) !== 0x102) continue;
    const extension = at + xml.readUInt16LE(at + 2), attributes = extension + xml.readUInt16LE(extension + 8);
    for (let index = 0; index < xml.readUInt16LE(extension + 12); index++) {
      const attribute = attributes + index * 20;
      if (xml[attribute + 15] === 3) xml.writeUInt32LE(xml.readUInt32LE(attribute + 16), attribute + 8);
    }
  }
  const result = Buffer.concat([xml.subarray(0, 8 + poolSize), map, xml.subarray(8 + poolSize)]);
  result.writeUInt32LE(result.length, 4); return result;
}

test("original package parser preserves permissions selected by actual device features", { timeout: 30000 }, async t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, home = process.env.JAVA_HOME;
  if (process.platform !== "darwin" || !runtime || !home) return t.skip("Requires the complete Android runtime and Java 21");
  const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-device-features-")));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const permission = (name, condition) => node("uses-permission", { name: "org.example." + name, ...condition });
  const manifest = node("manifest", { ":package": "org.example.featurepolicy" }, [
    node("uses-sdk", { minSdkVersion: 21, targetSdkVersion: 36 }),
    permission("AUDIO_PRESENT", { requiredFeature: "android.hardware.audio.output" }),
    permission("AUDIO_ABSENT", { requiredNotFeature: "android.hardware.audio.output" }),
    permission("WATCH_PRESENT", { requiredFeature: "android.hardware.type.watch" }),
    permission("WATCH_ABSENT", { requiredNotFeature: "android.hardware.type.watch" }),
    node("application", { hasCode: false })
  ]);
  const apk = path.join(output, "features.apk"); fs.writeFileSync(apk, zip([["AndroidManifest.xml", compiledManifest(manifest)]], { method: 0 }));
  const javaRoot = process.env.ANDROID_SHARED_JAVA_ROOT || runtime;
  const cp = [output, ...["android-host.jar", "android-framework.jar"].map(name => path.resolve(javaRoot, name))].join(path.delimiter);
  const identity = await require("../src/modules/android/process-channel").processNamespace(output, 1);
  const run = (command, args) => {
    const result = spawnSync(path.join(home, "bin", command), args, { encoding: "utf8", timeout: 20000,
      env: { ...process.env, ...identity.environment, TMPDIR: output }, maxBuffer: 2 << 20 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
  };
  const source = "src/modules/android/native/java/maclauncher/android/framework/";
  const adapters = process.env.ANDROID_SHARED_JAVA_ROOT ? [] : [source + "HostActivityManager.java", source + "PackageParsing.java"];
  run("javac", ["--release", "21", "-cp", cp, "-d", output, ...adapters,
    "tests/fixtures/android-framework-services/DeviceFeaturePermissionsProbe.java", "tests/fixtures/android-window-session/RuntimeFixture.java"]);
  assert.match(run("java", ["-Xverify:all", "-cp", cp, "maclauncher.android.framework.DeviceFeaturePermissionsProbe", path.resolve(runtime), output, apk]),
    /PASS original parser conditional permissions share device feature owner/);
});
