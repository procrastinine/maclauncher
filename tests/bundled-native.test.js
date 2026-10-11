const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const B = require("../src/modules/shared/runtime/bundled-native");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bundled-native-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, "resources", "native-runtimes"), directory = path.join(resourceRoot, "test-native", "arm64");
  const revision = "a".repeat(40), version = "1.0.0", payload = path.join(directory, "files");
  fs.mkdirSync(path.join(payload, "bin"), { recursive: true });
  fs.mkdirSync(path.join(payload, "licenses"));
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, "bin", "runner"), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "licenses", "LICENSE"), "License notice", { mode: 0o644 });
  const manifest = { schemaVersion: 1, managerId: "test-native", version, upstreamRevision: revision,
    platform: "darwin", arch: "arm64", minimumMacOS: "13.0", executableRelative: "bin/runner",
    provenance: { sourceRevision: revision, verifiedBuild: false },
    notices: [{ name: "Runtime", license: "MIT", sourceUrl: "https://example.org/source", path: "licenses/LICENSE" }],
    dependencies: [{ file: "bin/runner", links: ["/usr/lib/libSystem.B.dylib"] }],
    files: [{ path: "bin/runner", size: executable.length, sha256: B.digest(executable), mode: 0o755, architectures: ["arm64"] },
      { path: "licenses/LICENSE", size: 14, sha256: B.digest(Buffer.from("License notice")), mode: 0o644 }] };
  const writeManifest = () => fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  writeManifest();
  let signatures = 0;
  const bundle = B.createBundledNativeRuntime({ managerId: "test-native", resourceRoot, platform: "darwin", arch: "arm64",
    dependencies: { systemVersion: async () => "13.6", verifySignatures: async () => { signatures++; } } });
  const userDataDir = path.join(root, "userdata"), installDir = path.join(userDataDir, "runtimes", "test-native", version);
  const manager = { core: { catalog: [{ version, upstreamRevision: revision }], getInstallDir: () => installDir,
    resolveInstalled: () => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(installDir, "runtime.json"), "utf8"));
        return bundle.verifyInstalled({ installDir, record, pin: { upstreamRevision: revision } }) ? { ...record, runtimePath: path.join(installDir, record.executableRelative) } : null;
      } catch { return null; }
    } } };
  return { root, resourceRoot, directory, revision, version, payload, manifest, writeManifest, bundle, userDataDir, installDir, manager, signatures: () => signatures };
}

function directBundle(f, dependencies = {}) {
  let signatures = 0;
  const bundle = B.createBundledNativeRuntime({ managerId: "test-native", resourceRoot: f.resourceRoot,
    platform: "darwin", arch: f.manifest.arch, dependencies: { hostArch: "arm64", systemVersionSync: () => "13.6",
      verifySignaturesSync: () => { signatures++; }, ...dependencies } });
  return { bundle, signatures: () => signatures };
}

function directManager(f, bundle, options = {}) {
  return createPinnedNativeManager({ id: "test-native", label: "Fixture", recommendedVersion: f.version,
    catalog: [{ version: f.version, upstreamRevision: f.revision, nativeAbi: { event: "typed" } }],
    bundledRuntime: bundle, bundledExecution: "direct", ...options });
}

test("remote release display retains the actual included identity without seeding unused factory pins", async t => {
  const f = fixture(t), { bundle } = directBundle(f);
  const before = fs.readFileSync(path.join(f.directory, "manifest.json"));
  let fetches = 0;
  const runtime = directManager(f, bundle, {
    catalog: [{ version: f.version, upstreamRevision: f.revision }, { version: "unused", upstreamRevision: "c".repeat(40) }],
    discoverCatalog: async () => { fetches++; return [{ version: "2.0.0", upstreamRevision: "b".repeat(40) }]; }
  });
  const initial = runtime.getState({ userDataDir: f.userDataDir });
  assert.deepEqual(initial.catalog.versions, [f.version]);
  assert.deepEqual(initial.catalog.includedVersions, [f.version]);
  assert.equal(initial.installed[0].upstreamRevision, f.revision); assert.equal(fetches, 0);
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: f.userDataDir })).versions, ["2.0.0", f.version]);
  assert.equal(runtime.resolveSelection({}, {}, f.userDataDir).install.upstreamRevision, f.revision);
  assert.equal(runtime.core.catalog.find(pin => pin.version === "unused").upstreamRevision, "c".repeat(40));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "manifest.json")), before);
  assert.equal(fs.existsSync(runtime.core.getInstallDir({ userDataDir: f.userDataDir, version: f.version })), false);
});

test("direct included resources preserve exact seals, assets and environment without runtime copies", t => {
  const f = fixture(t), file = path.join(f.payload, "python", "lib", "stdlib.py");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from("# immutable stdlib\n"); fs.writeFileSync(file, bytes, { mode: 0o644 });
  f.manifest.files.push({ path: "python/lib/stdlib.py", size: bytes.length, sha256: B.digest(bytes), mode: 0o644 });
  f.manifest.environmentRelative = { PYTHONHOME: "python" }; f.manifest.runtimeFiles = { font: "licenses/LICENSE" }; f.writeManifest();
  const before = fs.readFileSync(path.join(f.directory, "manifest.json")), { bundle, signatures } = directBundle(f);
  const runtime = bundle.resolveRuntime({ version: f.version, upstreamRevision: f.revision });
  assert.equal(runtime.runtimePath, path.join(f.payload, "bin/runner"));
  assert.equal(runtime.installDir, f.directory); assert.equal(runtime.version, f.version); assert.equal(runtime.upstreamRevision, f.revision);
  assert.equal(runtime.bundledExecution, "direct"); assert.equal(runtime.readOnly, true); assert.equal(runtime.removable, false);
  assert.equal(signatures(), 1); assert.equal(fs.existsSync(f.userDataDir), false);
  assert.equal(B.bundledManifestPath(runtime), path.join(f.directory, "manifest.json"));
  assert.deepEqual(B.resolveInstalledEnvironment(runtime), { PYTHONHOME: path.join(f.payload, "python") });
  assert.equal(B.resolveInstalledAsset(runtime, "font"), path.join(f.payload, "licenses/LICENSE"));
  assert.equal(bundle.verifyInstalled({ installDir: f.directory, record: runtime, pin: { upstreamRevision: f.revision } }), true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "manifest.json")), before);
  assert.throws(() => bundle.resolveRuntime({ version: f.version, upstreamRevision: "b".repeat(40) }), /source pin/);
});

test("direct execution rejects auxiliary corruption and signatures before creating any user data", t => {
  const f = fixture(t), { bundle, signatures } = directBundle(f);
  assert.ok(bundle.resolveRuntime({ version: f.version, upstreamRevision: f.revision, verification: "status" }));
  assert.equal(signatures(), 0, "display must not perform signature subprocesses");
  fs.writeFileSync(path.join(f.payload, "licenses/LICENSE"), "changed notice");
  assert.throws(() => bundle.resolveRuntime({ version: f.version, upstreamRevision: f.revision }), /checksum/);
  assert.equal(signatures(), 0, "damaged closure must fail before signature/execution");
  fs.writeFileSync(path.join(f.payload, "licenses/LICENSE"), "License notice");
  const rejected = directBundle(f, { verifySignaturesSync: () => { throw new Error("Invalid native signature"); } }).bundle;
  assert.throws(() => rejected.resolveRuntime({ version: f.version, upstreamRevision: f.revision }), /Invalid native signature/);
  assert.equal(fs.existsSync(f.userDataDir), false);
});

test("signature proof reuses unchanged verified native bytes and invalidates on metadata changes or Reload", t => {
  const f = fixture(t), { bundle, signatures } = directBundle(f), options = { version: f.version, upstreamRevision: f.revision };
  bundle.resolveRuntime(options); bundle.resolveRuntime(options); assert.equal(signatures(), 1);
  const file = path.join(f.payload, "bin/runner"), original = fs.readFileSync(file), stat = fs.statSync(file);
  const changed = Buffer.from(original); changed[24] = 1; fs.writeFileSync(file, changed); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.throws(() => bundle.resolveRuntime(options), /checksum/); assert.equal(signatures(), 1);
  fs.writeFileSync(file, original); fs.utimesSync(file, stat.atime, stat.mtime);
  bundle.resolveRuntime(options); assert.equal(signatures(), 2, "restored mtime does not conceal changed native identity");
  bundle.clearCache(); bundle.resolveRuntime(options); assert.equal(signatures(), 3);
});

test("included resources enforce actual macOS floors and retain genuine Intel/Rosetta identity", t => {
  const f = fixture(t); f.manifest.minimumMacOS = "27.0"; f.writeManifest();
  assert.throws(() => directBundle(f).bundle.resolveRuntime({ version: f.version, upstreamRevision: f.revision }), /requires macOS 27.0/);
  f.manifest.minimumMacOS = "13.0"; f.manifest.arch = "x64"; f.manifest.files[0].architectures = ["x86_64"];
  const bytes = fs.readFileSync(path.join(f.payload, "bin/runner")); bytes.writeUInt32LE(0x01000007, 4);
  fs.writeFileSync(path.join(f.payload, "bin/runner"), bytes); f.manifest.files[0].sha256 = B.digest(bytes); f.writeManifest();
  const intel = path.join(f.resourceRoot, "test-native", "x64"); fs.renameSync(f.directory, intel);
  const runtime = directBundle(f).bundle.resolveRuntime({ version: f.version, upstreamRevision: f.revision });
  assert.deepEqual(runtime.architectures, ["x86_64"]); assert.equal(runtime.needsRosetta, true);
  assert.equal(runtime.binarySha256, B.digest(bytes)); assert.equal(runtime.version, f.version);
});

test("shared direct managers expose Included versions, require no install and protect resource removal", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), { bundle } = directBundle(f), manager = directManager(f, bundle);
  const before = B.fileInventory(f.payload), selected = manager.resolveSelection({}, {}, f.userDataDir);
  assert.equal(selected.ready, true); assert.equal(selected.install.bundledExecution, "direct");
  const state = manager.getState({ userDataDir: f.userDataDir });
  assert.equal(state.installed.length, 1); assert.equal(state.installed[0].removable, false);
  assert.equal(state.catalog.versionRequirements[f.version].included, true); assert.equal(state.catalog.versionRequirements[f.version].available, true);
  assert.equal(state.catalog.versionRequirements[f.version].installLabel, "Included");
  assert.equal(state.catalog.installableVersions.includes(f.version), false);
  assert.equal(fs.existsSync(f.userDataDir), false);
  const installed = await manager.installRuntime({ userDataDir: f.userDataDir, version: f.version });
  assert.equal(installed.runtimePath, selected.install.runtimePath); assert.equal(fs.existsSync(f.installDir), false);
  assert.throws(() => manager.uninstallRuntime({ userDataDir: f.userDataDir, version: f.version }), /included in the app/);
  assert.deepEqual(B.fileInventory(f.payload), before); assert.ok(bundle.verifyInstalled({ installDir: f.directory, record: installed, pin: { upstreamRevision: f.revision } }));
  assert.throws(() => createPinnedNativeManager({ id: "bad-direct", catalog: [{ version: "1", upstreamRevision: "a" }], bundledExecution: "direct" }), /included runtime cannot be resolved/);
});

test("registered exact versions win over Included resources, including damaged registrations", { skip: process.platform !== "darwin" }, t => {
  const f = fixture(t), { bundle } = directBundle(f), manager = directManager(f, bundle);
  const local = path.join(f.root, "registered-runner"); fs.copyFileSync(path.join(f.payload, "bin/runner"), local); fs.chmodSync(local, 0o755);
  manager.core.registerLocal({ userDataDir: f.userDataDir, version: f.version, runtimePath: local });
  let selection = manager.resolveSelection({}, {}, f.userDataDir);
  assert.equal(selection.install.source, "local"); assert.equal(selection.install.runtimePath, local);
  assert.equal(manager.getState({ userDataDir: f.userDataDir }).catalog.versionRequirements[f.version].included, false);
  assert.equal(manager.resolveSelection({ runtimeData: { "test-native": { version: "9.9.9" } } }, {}, f.userDataDir).ready, false);
  fs.writeFileSync(local, "changed registered executable"); selection = manager.resolveSelection({}, {}, f.userDataDir);
  assert.equal(selection.ready, false, "a changed registration must not silently use the Included resource");
  manager.uninstallRuntime({ userDataDir: f.userDataDir, version: f.version });
  assert.equal(fs.readFileSync(local, "utf8"), "changed registered executable");
  selection = manager.resolveSelection({}, {}, f.userDataDir); assert.equal(selection.install.bundledExecution, "direct");
});

test("direct display stays inexpensive and preserves full-verification failures until explicit Reload", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t), { bundle, signatures } = directBundle(f), manager = directManager(f, bundle);
  const notice = path.join(f.payload, "licenses/LICENSE"), originalOpen = fs.openSync; let reads = 0;
  fs.openSync = (file, ...args) => { if (file === notice) reads++; return originalOpen(file, ...args); };
  t.after(() => { fs.openSync = originalOpen; });
  for (let index = 0; index < 20; index++) assert.equal(manager.getState({ userDataDir: f.userDataDir }).installed[0].ready, true);
  assert.equal(reads, 0); assert.equal(signatures(), 0);
  const stat = fs.statSync(notice); fs.writeFileSync(notice, "changed notice"); fs.utimesSync(notice, stat.atime, stat.mtime);
  assert.equal(manager.resolveSelection({}, {}, f.userDataDir).ready, false);
  assert.equal(manager.getState({ userDataDir: f.userDataDir }).installed[0].ready, false);
  await assert.rejects(manager.installRuntime({ userDataDir: f.userDataDir, version: f.version }), /checksum/);
  assert.equal(fs.existsSync(f.userDataDir), false);
  fs.writeFileSync(notice, "License notice"); await manager.refreshCatalog({ userDataDir: f.userDataDir, force: true });
  assert.equal(manager.resolveSelection({}, {}, f.userDataDir).ready, true);
});

test("a packaged runtime installs without a checkout and verifies every copied file", async t => {
  const f = fixture(t);
  assert.equal(f.bundle.resolve({ version: f.version, upstreamRevision: f.revision }).source, "bundled");
  const installed = await f.bundle.install(f);
  assert.equal(installed.source, "bundled");
  assert.equal(f.signatures(), 1);
  assert.ok(installed.runtimePath.startsWith(f.userDataDir + path.sep));
  assert.equal(fs.existsSync(path.join(f.installDir, "source")), false);
  fs.writeFileSync(path.join(f.installDir, "files", "licenses", "LICENSE"), "changed notice");
  assert.equal(f.manager.core.resolveInstalled(), null);
});

test("bundled resources retain legacy lookup while resolving and installing multiple exact versions", async t => {
  const f = fixture(t), secondVersion = "1.1.0", secondRevision = "b".repeat(40);
  const second = path.join(f.resourceRoot, "test-native", secondVersion, "arm64"); fs.cpSync(f.directory, second, { recursive: true });
  fs.writeFileSync(path.join(second, "manifest.json"), JSON.stringify({ ...f.manifest, version: secondVersion, upstreamRevision: secondRevision, provenance: { sourceRevision: secondRevision } }));
  assert.equal(f.bundle.resolve({ version: f.version, upstreamRevision: f.revision }).directory, f.directory);
  assert.equal(f.bundle.resolve({ version: secondVersion, upstreamRevision: secondRevision }).directory, second);
  assert.equal(f.bundle.resolve({ version: "1.2.0", upstreamRevision: secondRevision }), null);
  assert.throws(() => f.bundle.resolve({ version: "../1.1.0" }), /safe explicit/);
  const pins = [{ version: f.version, upstreamRevision: f.revision }, { version: secondVersion, upstreamRevision: secondRevision }];
  const manager = { core: { catalog: pins, getInstallDir: ({ version }) => path.join(f.userDataDir, "runtimes", "test-native", version), resolveInstalled: ({ version }) => {
    const installDir = path.join(f.userDataDir, "runtimes", "test-native", version); let record; try { record = JSON.parse(fs.readFileSync(path.join(installDir, "runtime.json"))); } catch { return null; }
    return f.bundle.verifyInstalled({ installDir, record, pin: pins.find(pin => pin.version === version) }) ? record : null;
  } } };
  const one = await f.bundle.install({ manager, version: f.version, userDataDir: f.userDataDir });
  const two = await f.bundle.install({ manager, version: secondVersion, userDataDir: f.userDataDir });
  assert.equal(one.version, f.version); assert.equal(two.version, secondVersion);
  assert.ok(manager.core.resolveInstalled({ version: f.version }));
  const changed = { ...f.manifest, version: f.version, upstreamRevision: secondRevision, provenance: { sourceRevision: secondRevision } };
  fs.writeFileSync(path.join(second, "manifest.json"), JSON.stringify(changed));
  assert.throws(() => f.bundle.resolve({ version: secondVersion, upstreamRevision: secondRevision }), /different version/);
});

test("wrong pins and damaged payloads fail before publication and leave existing files alone", async t => {
  const f = fixture(t);
  assert.throws(() => f.bundle.resolve({ version: f.version, upstreamRevision: "b".repeat(40) }), /source pin/);
  fs.writeFileSync(path.join(f.payload, "bin", "runner"), "bad");
  await assert.rejects(f.bundle.install(f), /checksum/);
  assert.equal(fs.existsSync(f.installDir), false);
});

test("traversal, missing dependencies and symlinked bundle files are rejected", async t => {
  const f = fixture(t);
  f.manifest.dependencies[0].links.push("@loader_path/../../outside.dylib");
  f.writeManifest();
  assert.throws(() => f.bundle.resolve({ version: f.version, upstreamRevision: f.revision }), /Unsafe|missing/);
  f.manifest.dependencies[0].links.pop();
  f.manifest.files[1].path = "../LICENSE";
  f.writeManifest();
  assert.throws(() => f.bundle.resolve({ version: f.version, upstreamRevision: f.revision }), /Unsafe/);
  f.manifest.files[1].path = "licenses/LICENSE";
  f.writeManifest();
  fs.rmSync(path.join(f.payload, "licenses", "LICENSE"));
  fs.symlinkSync(path.join(f.payload, "bin", "runner"), path.join(f.payload, "licenses", "LICENSE"));
  await assert.rejects(f.bundle.install(f), /symlink/);
  assert.equal(fs.existsSync(f.installDir), false);
});

test("macOS floors and signature failures prevent installation and clean staging", async t => {
  const f = fixture(t);
  f.manifest.minimumMacOS = "27.0"; f.writeManifest();
  await assert.rejects(f.bundle.install(f), /requires macOS 27/);
  f.manifest.minimumMacOS = "13.0"; f.writeManifest();
  const bundle = B.createBundledNativeRuntime({ managerId: "test-native", resourceRoot: f.resourceRoot, platform: "darwin", arch: "arm64",
    dependencies: { systemVersion: async () => "13.6", verifySignatures: async () => { throw new Error("Invalid signature"); } } });
  await assert.rejects(bundle.install(f), /Invalid signature/);
  assert.equal(fs.existsSync(f.installDir), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.installDir)), []);
});

test("cancellation preserves the existing source package and missing manifests are not silently rebuilt", async t => {
  const f = fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.bundle.install({ ...f, signal: controller.signal }), /abort/i);
  assert.equal(fs.existsSync(f.installDir), false);
  fs.rmSync(path.join(f.directory, "manifest.json"));
  assert.throws(() => f.bundle.resolve({ version: f.version, upstreamRevision: f.revision }), /manifest is missing/);
});

test("embedded Python paths stay scoped to verified payload directories", async t => {
  const f = fixture(t), file = path.join(f.payload, "python", "lib", "stdlib.py");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from("# embedded Python\n");
  fs.writeFileSync(file, bytes, { mode: 0o644 });
  f.manifest.files.push({ path: "python/lib/stdlib.py", size: bytes.length, sha256: B.digest(bytes), mode: 0o644 });
  f.manifest.environmentRelative = { PYTHONHOME: "python" }; f.writeManifest();
  const installed = await f.bundle.install(f);
  assert.deepEqual(B.resolveInstalledEnvironment({ ...installed, installDir: f.installDir }), { PYTHONHOME: path.join(f.installDir, "files", "python") });
  const recordPath = path.join(f.installDir, "runtime.json"), record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.environmentRelative.PYTHONHOME = "../unrelated";
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(f.manager.core.resolveInstalled(), null);
  assert.throws(() => B.resolveInstalledEnvironment({ ...record, installDir: f.installDir }), /Unsafe/);
});

test("runtime assets resolve to the copied installation and record tampering makes it unavailable", async t => {
  const f = fixture(t);
  f.manifest.runtimeFiles = { fontGothic: "licenses/LICENSE" }; f.writeManifest();
  const installed = await f.bundle.install(f);
  assert.equal(B.resolveInstalledAsset({ ...installed, installDir: f.installDir }, "fontGothic"), path.join(f.installDir, "files", "licenses", "LICENSE"));
  assert.equal(B.resolveInstalledAsset(installed, "unknownAsset"), null);
  const recordPath = path.join(f.installDir, "runtime.json"), record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.runtimeFiles.fontGothic = "../outside-font";
  fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(f.manager.core.resolveInstalled(), null);
  assert.throws(() => B.resolveInstalledAsset({ ...record, installDir: f.installDir }, "fontGothic"), /Unsafe/);
});

test("display checks avoid payload reads while full execution validation catches auxiliary corruption", async t => {
  const f = fixture(t), installed = await f.bundle.install(f);
  const options = { installDir: f.installDir, record: installed, pin: { upstreamRevision: f.revision } };
  const notice = path.join(f.installDir, "files", "licenses", "LICENSE");
  const open = fs.openSync;
  let auxiliaryReads = 0;
  fs.openSync = (file, ...args) => { if (file === notice) auxiliaryReads++; return open(file, ...args); };
  t.after(() => { fs.openSync = open; });
  for (let i = 0; i < 20; i++) assert.equal(f.bundle.verifyInstalled({ ...options, verification: "status" }), true);
  assert.equal(auxiliaryReads, 0, "repeated display broadcasts must not read the auxiliary closure");
  const original = fs.readFileSync(notice), stat = fs.statSync(notice);
  fs.writeFileSync(notice, Buffer.alloc(original.length, 0x78));
  fs.utimesSync(notice, stat.atime, stat.mtime);
  assert.equal(f.bundle.verifyInstalled({ ...options, verification: "status" }), true);
  assert.equal(f.bundle.verifyInstalled(options), false, "Play must reject corruption even after a warm display and restored mtime");
  assert.ok(auxiliaryReads > 0);
});

test("cached manifest display checks invalidate on changed bytes or symlink substitution", async t => {
  const f = fixture(t), installed = await f.bundle.install(f);
  const options = { installDir: f.installDir, record: installed, pin: { upstreamRevision: f.revision }, verification: "status" };
  assert.equal(f.bundle.verifyInstalled(options), true);
  const manifestFile = path.join(f.installDir, "bundle-manifest.json"), stat = fs.statSync(manifestFile);
  const bytes = fs.readFileSync(manifestFile), modified = Buffer.from(bytes);
  const revisionOffset = modified.indexOf(f.revision);
  modified[revisionOffset] = 0x62;
  fs.writeFileSync(manifestFile, modified);
  fs.utimesSync(manifestFile, stat.atime, stat.mtime);
  assert.equal(f.bundle.verifyInstalled(options), false);
  fs.writeFileSync(manifestFile, bytes);
  assert.equal(f.bundle.verifyInstalled(options), true);
  const outside = path.join(f.root, "manifest-backup.json"); fs.renameSync(manifestFile, outside); fs.symlinkSync(outside, manifestFile);
  assert.equal(f.bundle.verifyInstalled(options), false);
  f.bundle.resolve({ version: f.version, upstreamRevision: f.revision });
  const resourceManifest = path.join(f.directory, "manifest.json"), resourceBackup = path.join(f.root, "resource-backup.json");
  fs.renameSync(resourceManifest, resourceBackup); fs.symlinkSync(resourceBackup, resourceManifest);
  assert.throws(() => f.bundle.resolve({ version: f.version, upstreamRevision: f.revision }), /regular|unreadable/);
});
