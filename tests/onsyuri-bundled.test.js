const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const B = require("../src/modules/shared/runtime/bundled-native");
const { createOnsyuriBundled, CATALOG, validateVersionProvenance } = require("../src/modules/shared/onsyuri/runtime/onsyuri-bundled");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "onsyuri-bundled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = CATALOG.find(row => row.version === "0.7.7beta"), resourceRoot = path.join(root, "resources"), directory = path.join(resourceRoot, "onsyuri", pin.version, "arm64");
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.mkdirSync(path.join(directory, "files", "bin"), { recursive: true });
  fs.writeFileSync(path.join(directory, "files", "bin", "onsyuri"), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "files", "LICENSE"), "GPL-2.0 notice", { mode: 0o644 });
  const manifest = { schemaVersion: 1, managerId: "onsyuri", version: pin.version, upstreamRevision: pin.upstreamRevision,
    platform: "darwin", arch: "arm64", minimumMacOS: "14.0", executableRelative: "bin/onsyuri",
    provenance: { sourceRevision: pin.upstreamRevision, sourceKind: "official-release", verifiedBuild: false },
    notices: [{ name: "Onsyuri", license: "GPL-2.0", sourceUrl: pin.sourceUrl, path: "LICENSE" }],
    dependencies: [{ file: "bin/onsyuri", links: ["/usr/lib/libSystem.B.dylib"] }],
    files: [{ path: "bin/onsyuri", size: 32, sha256: B.digest(executable), mode: 0o755, architectures: ["arm64"] },
      { path: "LICENSE", size: 14, sha256: B.digest(Buffer.from("GPL-2.0 notice")), mode: 0o644 }] };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const provider = createOnsyuriBundled({ resourceRoot, platform: "darwin", dependencies: {
    systemVersion: async () => "14.6", systemVersionSync: () => "14.6", verifySignatures: async () => {}, verifySignaturesSync: () => {} } });
  return { root, pin, provider, resourceRoot, directory, userDataDir: path.join(root, "userdata") };
}

test("bundled Onsyuri executes offline in place without creating a runtime copy", async t => {
  const f = fixture(t);
  assert.equal(f.provider.available({ version: "0.7.7", variant: "arm64" }), null);
  const installed = await f.provider.install({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" });
  assert.equal(installed.source, "bundled");
  assert.equal(installed.provenanceVerified, false);
  assert.equal(installed.installDir, f.directory); assert.equal(installed.bundledExecution, "direct");
  assert.equal(installed.readOnly, true); assert.equal(installed.removable, false); assert.equal(fs.existsSync(f.userDataDir), false);
  assert.ok(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }));
  fs.writeFileSync(path.join(installed.installDir, "files", "LICENSE"), "changed");
  assert.throws(() => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }), /checksum/);
  assert.throws(() => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64", verification: "status" }), /checksum/);
  fs.writeFileSync(path.join(installed.installDir, "files", "LICENSE"), "GPL-2.0 notice");
  assert.throws(() => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64", verification: "status" }), /checksum/);
  f.provider.clearCache();
  assert.ok(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }));
  assert.equal(f.provider.isResourcePath(installed.installDir), true);
});

test("an existing exact Onsyuri registration wins and damaged copies never fall back to included bytes", async t => {
  const f = fixture(t);
  const getInstallDir = () => path.join(f.userDataDir, "runtimes", "onsyuri", "mac", f.pin.version, "arm64");
  const copiedProvider = B.createBundledNativeRuntime({ managerId: "onsyuri", resourceRoot: f.resourceRoot, arch: "arm64", platform: "darwin",
    dependencies: { systemVersion: async () => "14.6", verifySignatures: async () => {} } });
  const copied = await copiedProvider.install({ userDataDir: f.userDataDir, version: f.pin.version,
    manager: { core: { catalog: f.provider.catalog, getInstallDir,
      resolveInstalled: () => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }) } } });
  assert.equal(copied.installDir, getInstallDir());
  assert.notEqual(copied.installDir, f.directory); assert.equal(copied.bundledExecution, undefined);
  fs.writeFileSync(path.join(copied.installDir, "files", "LICENSE"), "changed");
  assert.equal(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }), null);
  assert.throws(() => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64", verification: "status" }), /changed|checksum/);
  assert.equal(fs.readFileSync(path.join(f.directory, "files", "LICENSE"), "utf8"), "GPL-2.0 notice");
  fs.rmSync(copied.installDir, { recursive: true }); f.provider.clearCache();
  const direct = f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" });
  assert.equal(direct.installDir, f.directory); assert.equal(direct.readOnly, true);
});

test("Onsyuri refuses damaged selected packages and a different architecture", async t => {
  const f = fixture(t);
  assert.equal(f.provider.available({ version: f.pin.version, variant: "x64" }), null);
  assert.throws(() => f.provider.available({ version: f.pin.version, variant: "../../arm64" }), /Apple Silicon or Intel/);
  fs.writeFileSync(path.join(f.directory, "manifest.json"), "{}");
  await assert.rejects(f.provider.install({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }), /different version|Invalid/);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "runtimes")), false);
});

test("portable source identity binds the complete primary scope, overlay and CPU while preserving stock metadata", () => {
  const pin = CATALOG[0], manifest = { minimumMacOS: "13.0", arch: "arm64", provenance: { verifiedBuild: true,
    sourceTreeSha256: pin.sourceTreeSha256, overlaySha256: pin.overlaySha256,
    sourceScope: structuredClone(pin.sourceScope), omittedSubmodules: structuredClone(pin.omittedSubmodules) } };
  validateVersionProvenance(manifest, pin);
  for (const mutate of [row => { row.provenance.verifiedBuild = false; }, row => { row.provenance.sourceTreeSha256 = "a".repeat(64); },
    row => { row.provenance.overlaySha256 = "b".repeat(64); }, row => { row.provenance.sourceScope.omittedSubmodules.pop(); },
    row => { row.provenance.omittedSubmodules[0].revision = "c".repeat(40); }, row => { row.arch = "x64"; }, row => { row.minimumMacOS = "14.0"; }]) {
    const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateVersionProvenance(changed, pin), /source profile differs/);
  }
  const stock = CATALOG.find(row => row.version === "0.7.7beta");
  assert.equal(stock.localBuild, false); assert.equal(stock.upstreamRevision, "08f744b31cc1907b66a15f0402e62321a131ed81");
  assert.doesNotThrow(() => validateVersionProvenance({ provenance: { verifiedBuild: false } }, stock));
});

test("stock release versions outside the included catalog can use normal download management", async t => {
  const f = fixture(t);
  assert.equal(await f.provider.install({ userDataDir: f.userDataDir, version: "0.7.5", variant: "arm64" }), null);
  assert.equal(fs.existsSync(f.userDataDir), false);
});
