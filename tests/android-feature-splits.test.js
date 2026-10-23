const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { node, activity, manifest, binaryXml, zip } = require("./helpers/android-packages");
const Package = require("../src/modules/android/package-set");

function manifests() {
  const base = manifest([node("activity", { name: ".Base", exported: false })],
    { name: ".BaseApplication", process: ":shared", permission: "org.example.ACCESS", hasCode: false });
  const alias = activity(".FeatureAlias", { targetActivity: ".Base", exported: true }); alias.name = "activity-alias";
  const feature = manifest([activity(".Feature", { exported: true }), alias,
    node("provider", { name: ".FeatureProvider", authorities: "org.example.feature" }),
    node("service", { name: ".FeatureService", exported: false }),
    node("receiver", { name: ".FeatureReceiver", exported: false }, [node("intent-filter", {}, [node("action", { name: "org.example.FEATURE" })])]),
    node("meta-data", { name: "duplicate", value: "alpha" })],
    { name: ".IgnoredApplication", enabled: false, process: ":ignored", permission: "org.example.IGNORED", hasCode: false },
    { ":split": "feature.alpha", isFeatureSplit: true });
  feature.children[0].attrs.targetSdkVersion = 16;
  feature.children.push(node("uses-split", { name: "feature.zeta" }));
  const dependency = manifest([node("meta-data", { name: "duplicate", value: "zeta" })], { hasCode: false },
    { ":split": "feature.zeta", isFeatureSplit: true });
  return [base, feature, dependency];
}
function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-feature-splits-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function write(root, trees, compile = binaryXml) {
  return trees.map((tree, index) => {
    const file = path.join(root, index ? "feature-" + index + ".apk" : "base.apk");
    fs.writeFileSync(file, zip([["AndroidManifest.xml", compile(tree)]], { method: 0 })); return file;
  });
}
function checkMetadata(metadata) {
  assert.deepEqual(metadata.launchers.map(item => item.activity), ["org.example.game.Feature", "org.example.game.Base"]);
  assert.equal(metadata.applicationClass, "org.example.game.BaseApplication");
  assert.equal(metadata.targetSdk, 36);
  assert.equal(metadata.applicationProcessName, "org.example.game:shared");
  assert.deepEqual(metadata.applicationProcesses, ["org.example.game:shared"]);
  assert.equal(metadata.launcherProcesses["org.example.game.FeatureAlias"], "org.example.game:shared");
  assert.equal(metadata.applicationMetadata.duplicate.value, "zeta", "Metadata follows Android's split name order, not dependency traversal");
  for (const key of ["applicationProviders", "applicationServices", "applicationReceivers"]) {
    assert.equal(metadata[key].length, 1);
    assert.equal(metadata[key][0].processName, "org.example.game:shared");
    assert.equal(metadata[key][0].enabled, true, "A feature application's enabled attribute does not replace base defaults");
    assert.equal(metadata[key][0].exported, false);
  }
  assert.equal(metadata.applicationProviders[0].readPermission, "org.example.ACCESS");
  assert.equal(metadata.applicationServices[0].permission, "org.example.ACCESS");
  assert.equal(metadata.applicationReceivers[0].permission, "org.example.ACCESS");
  assert.equal(metadata.applicationActivities.find(item => item.name.endsWith(".Feature")).permission, "org.example.ACCESS");
  assert.deepEqual(metadata.limitations, []);
}

test("feature components inherit base defaults and retain isolated split declarations", t => {
  const root = folder(t), trees = manifests(), files = write(root, trees);
  const inspected = Package.inspectFiles(files);
  assert.deepEqual(inspected.selected.map(item => item.metadata.split), [null, "feature.zeta", "feature.alpha"]);
  checkMetadata(inspected.metadata);
  const isolated = manifests(); isolated[0].attrs.isolatedSplits = true;
  const isolatedPackage = Package.inspectFiles(write(root, isolated));
  assert.equal(isolatedPackage.metadata.isolatedSplits, true);
  assert.deepEqual(isolatedPackage.selected.map(item => item.metadata.split), [null, "feature.zeta", "feature.alpha"]);
  checkMetadata(isolatedPackage.metadata);
  const disabled = manifests(); disabled[0].children.find(item => item.name === "application").attrs.enabled = false;
  const disabledMetadata = Package.inspectFiles(write(root, disabled)).metadata;
  assert.deepEqual(disabledMetadata.launchers, []);
  assert.equal(disabledMetadata.applicationProviders[0].enabled, false);
  const missing = manifests(); missing[1].children.at(-1).attrs.name = "absent";
  assert.throws(() => Package.inspectFiles(write(root, missing)), /required Android split APK is missing/);
  const unknown = manifests();
  unknown[0].children.find(item => item.name === "application").children.push(node("meta-data", { name: "baseOnly", value: "base" }));
  unknown[1].children.find(item => item.name === "application").children.push(node("meta-data", { name: "unsupported", value: { type: 5, data: 1 } }));
  const unknownMetadata = Package.inspectFiles(write(root, unknown)).metadata;
  assert.equal(unknownMetadata.applicationMetadataInspected, false);
  assert.equal(Object.hasOwn(unknownMetadata, "applicationMetadata"), false, "An uninspected cluster does not retain partial base metadata");
});

// Supply original framework attribute IDs to the generated binary XML, just as
// aapt does. This fixture contains no application bytecode or external assets.
function compiledManifest(tree, ids) {
  let xml = binaryXml(tree), poolSize = xml.readUInt32LE(12);
  const padding = (4 - poolSize % 4) % 4;
  if (padding) {
    xml = Buffer.concat([xml.subarray(0, 8 + poolSize), Buffer.alloc(padding), xml.subarray(8 + poolSize)]);
    poolSize += padding; xml.writeUInt32LE(poolSize, 12); xml.writeUInt32LE(xml.length, 4);
  }
  const count = xml.readUInt32LE(16);
  const poolHeader = xml.readUInt16LE(10), data = 8 + xml.readUInt32LE(28);
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
    const count = xml.readUInt16LE(extension + 12), sorted = [];
    for (let index = 0; index < count; index++) {
      const attribute = attributes + index * 20;
      if (xml[attribute + 15] === 3) xml.writeUInt32LE(xml.readUInt32LE(attribute + 16), attribute + 8);
      sorted.push(Buffer.from(xml.subarray(attribute, attribute + 20)));
    }
    // Android's styleable reader merges attributes in resource-ID order.
    sorted.sort((a, b) => map.readUInt32LE(8 + a.readUInt32LE(4) * 4) - map.readUInt32LE(8 + b.readUInt32LE(4) * 4));
    sorted.forEach((attribute, index) => attribute.copy(xml, attributes + index * 20));
  }
  const result = Buffer.concat([xml.subarray(0, 8 + poolSize), map, xml.subarray(8 + poolSize)]);
  result.writeUInt32LE(result.length, 4); return result;
}

test("signed feature APK cluster retains original Android component and split semantics", { timeout: 60000 }, async t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, home = process.env.JAVA_HOME;
  if (process.platform !== "darwin" || !runtime || !home) return t.skip("Requires the complete Android runtime and Java 21");
  const root = folder(t), classes = path.join(root, "classes"), apksig = path.resolve("src/modules/android/native/tools/apksig.jar");
  const cp = [classes, apksig, ...["android-host.jar", "android-framework.jar", "converter-overlay.jar", "dex2jvm.jar"].map(name => path.resolve(runtime, name))].join(path.delimiter);
  const identity = await require("../src/modules/android/process-channel").processNamespace(root, 1);
  const { spawnSync } = require("./helpers/android-java");
  const run = (tool, args, ok = true) => {
    const result = spawnSync(path.join(home, "bin", tool), args, { env: { ...process.env, ...identity.environment, TMPDIR: root },
      encoding: "utf8", timeout: 25000, maxBuffer: 4 << 20 });
    assert.ifError(result.error); assert.equal(result.signal, null, result.stdout + result.stderr);
    if (ok) assert.equal(result.status, 0, result.stdout + result.stderr); else assert.notEqual(result.status, 0);
    return result.stdout;
  };
  run("javac", ["--release", "21", "-cp", cp, "-d", classes,
    "tests/fixtures/android-framework-services/FeatureSplitProbe.java", "tests/fixtures/android-framework-services/SignApkSet.java",
    "tests/fixtures/android-window-session/RuntimeFixture.java"]);
  const ids = Object.fromEntries(run("java", ["-cp", cp, "maclauncher.android.framework.FeatureSplitProbe", "attributes"])
    .trim().split("\n").map(line => { const [name, value] = line.split("="); return [name, Number(value)]; }));
  const inputs = write(root, manifests(), tree => compiledManifest(tree, ids));
  run("keytool", ["-genkeypair", "-alias", "owned", "-keystore", path.join(root, "key.p12"), "-storetype", "PKCS12",
    "-storepass", "test-only-password", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1", "-dname", "CN=Owned APK test", "-noprompt"]);
  const signed = inputs.map((_, index) => path.join(root, "signed-" + index + ".apk"));
  run("java", ["-cp", cp, "SignApkSet", path.join(root, "key.p12"), ...inputs.flatMap((file, index) => [file, signed[index]])]);
  const report = path.join(root, "verified.tsv");
  run("java", ["-cp", cp, "io.github.kksimp.dex2jvm.VerifyApkSet", report, ...signed]);
  const lines = fs.readFileSync(report, "utf8").trim().split("\n").map(line => line.split("\t"));
  assert.equal(lines.length, 3); assert.equal(new Set(lines.map(line => line[2])).size, 1);
  const records = signed.map((file, index) => ({ file, metadata: require("../src/modules/android/apk").inspectApk(file), signers: lines[index][2].split(",") }));
  checkMetadata(Package.plan(records, { verified: true }).metadata);
  assert.match(run("java", ["-Xverify:all", "-cp", cp, "maclauncher.android.framework.FeatureSplitProbe", runtime, root, ...signed]),
    /PASS original signed feature split components and base inheritance/);
  assert.throws(() => Package.plan(records.map((record, index) => index ? { ...record, signers: ["b".repeat(64)] } : record), { verified: true }), /different signing certificates/);
});
