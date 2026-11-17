const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { node, activity, manifest, binaryXml, zip } = require("./helpers/android-packages");
const Package = require("../src/modules/android/package-set");
const { withApk } = require("../src/modules/android/apk");

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

// A resource table holding only its global string pool, in UTF-8.
function resourceTable(strings) {
  const data = Buffer.concat(strings.map(text => { const bytes = Buffer.from(text); return Buffer.concat([Buffer.from([text.length, bytes.length]), bytes, Buffer.from([0])]); }));
  const offsets = Buffer.alloc(strings.length * 4); let at = 0;
  strings.forEach((text, index) => { offsets.writeUInt32LE(at, index * 4); at += Buffer.byteLength(text) + 3; });
  const pool = Buffer.alloc(28); pool.writeUInt16LE(1, 0); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(28 + offsets.length + data.length, 4);
  pool.writeUInt32LE(strings.length, 8); pool.writeUInt32LE(0x100, 16); pool.writeUInt32LE(28 + offsets.length, 20);
  const table = Buffer.alloc(12); table.writeUInt16LE(2, 0); table.writeUInt16LE(12, 2); table.writeUInt32LE(12 + pool.readUInt32LE(4), 4);
  return Buffer.concat([table, pool, offsets, data]);
}

test("archive inspection writes only what it reads from stored APKs and still rejects damaged entries", async t => {
  const root = folder(t), asset = Buffer.alloc(4 * 1024 * 1024);
  for (let at = 0; at < asset.length; at += 4096) asset[at] = (at >>> 12) & 0xff;
  const apk = zip([["AndroidManifest.xml", binaryXml(manifest())], ["assets/large.bin", asset]], { method: 0 });
  const direct = path.join(root, "base.apk"), archive = path.join(root, "game.xapk");
  fs.writeFileSync(direct, apk); fs.writeFileSync(archive, zip([["base.apk", apk]], { method: 0 }));
  const expected = Package.inspectFiles([direct]), inspected = await Package.inspectInput(archive);
  assert.deepEqual(inspected.metadata, expected.metadata);
  assert.deepEqual(inspected.selected.map(item => item.metadata), expected.selected.map(item => item.metadata));

  const sparseRoot = path.join(root, "sparse"), plainRoot = path.join(root, "plain");
  fs.mkdirSync(sparseRoot); fs.mkdirSync(plainRoot);
  const [sparse] = await Package.unpack(archive, sparseRoot, undefined, { method: "sparse" });
  assert.equal(fs.statSync(sparse.file).size, apk.length);
  assert.equal(fs.readFileSync(sparse.file).includes(asset.subarray(4096, 4096 * 4)), false, "the stored asset bytes are not written");
  assert.deepEqual(Package.inspectFiles([sparse.file]).metadata, expected.metadata);
  const [plain] = await Package.unpack(archive, plainRoot, undefined, { method: "plain" });
  assert.deepEqual(fs.readFileSync(plain.file), apk);

  const icon = Buffer.alloc(70000, 0x5a), table = resourceTable(["Example", "res/mipmap/icon.png"]);
  const resourceApk = zip([["AndroidManifest.xml", binaryXml(manifest())], ["assets/large.bin", asset],
    ["res/mipmap/icon.png", icon], ["resources.arsc", table]], { method: 0 });
  const resourceArchive = path.join(root, "resources.xapk"), resourceRoot = path.join(root, "resources");
  fs.writeFileSync(resourceArchive, zip([["base.apk", resourceApk]], { method: 0 })); fs.mkdirSync(resourceRoot);
  const [resources] = await Package.unpack(resourceArchive, resourceRoot, undefined, { method: "resources" });
  const written = fs.readFileSync(resources.file);
  assert.equal(written.length, resourceApk.length);
  assert.ok(written.includes(icon) && written.includes(table), "the resource table and the files it names are written");
  assert.equal(written.includes(asset.subarray(4096, 4096 * 4)), false, "other entries are not written");
  assert.equal(withApk(resources.file, apk => apk.read("res/mipmap/icon.png")).equals(icon), true);

  // An unchanged archive's APKs are verified once per process.
  Package.clearVerified();
  const reads = t.mock.method(fs, "read"), onceRoot = path.join(root, "once"), againRoot = path.join(root, "again");
  fs.mkdirSync(onceRoot); fs.mkdirSync(againRoot);
  await Package.unpack(archive, onceRoot, undefined, { method: "sparse" });
  const verifiedReads = reads.mock.callCount();
  await Package.unpack(archive, againRoot, undefined, { method: "resources" });
  assert.ok(verifiedReads > 0); assert.equal(reads.mock.callCount(), verifiedReads, "the second read does not stream the APK again");
  reads.mock.restore();

  const damaged = fs.readFileSync(archive); damaged[damaged.length >>> 1] ^= 0xff; fs.writeFileSync(archive, damaged);
  await assert.rejects(Package.inspectInput(archive), /checksum/);
  const damagedRoot = path.join(root, "damaged"); fs.mkdirSync(damagedRoot);
  await assert.rejects(Package.unpack(archive, damagedRoot, undefined, { method: "sparse" }), /checksum/);
  assert.deepEqual(fs.readdirSync(damagedRoot), [], "a rejected entry leaves no partial APK");
});
