const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const B = require("../src/modules/shared/runtime/bundled-native");
const { createOnsyuriBundled, validateVersionProvenance } = require("../src/modules/shared/onsyuri/runtime/onsyuri-bundled");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "onsyuri-bundled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = { version: "0.9.1-macos-v1", upstreamRevision: "a".repeat(40), sourceUrl: "https://github.com/YuriSizuku/OnscripterYuri", localBuild: false }, resourceRoot = path.join(root, "resources"), directory = path.join(resourceRoot, "onsyuri", pin.version, "arm64");
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

test("app resources never become an installed Onsyuri runtime", t => {
  const f = fixture(t);
  assert.equal(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }), null);
  assert.equal(f.provider.install, undefined);
  assert.equal(f.provider.available, undefined);
  assert.equal(fs.existsSync(f.userDataDir), false);
  assert.equal(f.provider.isResourcePath(f.directory), true);
});

test("an existing exact Onsyuri registration wins and damaged copies never fall back to included bytes", async t => {
  const f = fixture(t);
  const getInstallDir = () => path.join(f.userDataDir, "runtimes", "onsyuri", "mac", f.pin.version, "arm64");
  const copiedProvider = B.createBundledNativeRuntime({ managerId: "onsyuri", resourceRoot: f.resourceRoot, arch: "arm64", platform: "darwin",
    dependencies: { systemVersion: async () => "14.6", verifySignatures: async () => {} } });
  const copied = await copiedProvider.install({ userDataDir: f.userDataDir, version: f.pin.version,
    manager: { core: { catalog: [f.pin], getInstallDir,
      resolveInstalled: () => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }) } } });
  assert.equal(copied.installDir, getInstallDir());
  assert.notEqual(copied.installDir, f.directory); assert.equal(copied.bundledExecution, undefined);
  assert.equal(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }).installDir, copied.installDir);
  fs.writeFileSync(path.join(copied.installDir, "files", "LICENSE"), "changed");
  assert.equal(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }), null);
  assert.throws(() => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64", verification: "status" }), /changed|checksum/);
  assert.equal(fs.readFileSync(path.join(f.directory, "files", "LICENSE"), "utf8"), "GPL-2.0 notice");
  fs.rmSync(copied.installDir, { recursive: true }); f.provider.clearCache();
  assert.equal(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "arm64" }), null);
});

test("legacy Onsyuri selection validates architecture without creating an installation", t => {
  const f = fixture(t);
  assert.equal(f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "x64" }), null);
  assert.throws(() => f.provider.resolve({ userDataDir: f.userDataDir, version: f.pin.version, variant: "../../arm64" }), /Apple Silicon or Intel/);
  assert.equal(fs.existsSync(f.userDataDir), false);
});

test("installed source provenance is bound to its receipt without a launcher version table", () => {
  const provenance = { sourceRevision: "a".repeat(40), verifiedBuild: true, sourceTreeSha256: "b".repeat(64), overlaySha256: "c".repeat(64),
    sourceScope: { kind: "primary-tree", omittedSubmodules: ["deps/lua"] }, omittedSubmodules: [{ path: "deps/lua", revision: "d".repeat(40) }] };
  const record = { upstreamRevision: provenance.sourceRevision, minimumMacOS: "13.0", provenanceVerified: true, buildProvenance: provenance };
  const manifest = { upstreamRevision: provenance.sourceRevision, minimumMacOS: "13.0", provenance: structuredClone(provenance) };
  validateVersionProvenance(manifest, record);
  for (const mutate of [row => { row.provenance.verifiedBuild = false; }, row => { row.provenance.sourceTreeSha256 = "e".repeat(64); },
    row => { row.provenance.overlaySha256 = "f".repeat(64); }, row => { row.provenance.sourceScope.omittedSubmodules.pop(); },
    row => { row.provenance.omittedSubmodules[0].revision = "e".repeat(40); }, row => { row.upstreamRevision = "f".repeat(40); }, row => { row.minimumMacOS = "14.0"; }]) {
    const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateVersionProvenance(changed, record), /source profile differs/);
  }
  const publisher = { upstreamRevision: "e".repeat(40), provenanceVerified: false, buildProvenance: { verifiedBuild: false } };
  assert.doesNotThrow(() => validateVersionProvenance({ upstreamRevision: publisher.upstreamRevision, provenance: { verifiedBuild: false } }, publisher));
});
