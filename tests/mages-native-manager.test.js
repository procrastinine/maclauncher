const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Managers = require("../src/modules/mages/native/manager");
// An earlier Impacto Mac package, as its manifest describes it.
const Packages = require("./fixtures/mages-windows-versions.json");
const Adapter = require("../src/modules/mages/native/adapter");
const Bundled = require("../src/modules/shared/runtime/bundled-native");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Impacto starts without Mac package rows and identifies its Builds catalog", t => {
  const root = temporary(t);
  const historical = path.join(root, "bundles", "impacto", "0.10.8.810", "arm64");
  fs.mkdirSync(historical, { recursive: true }); fs.writeFileSync(path.join(historical, "manifest.json"), "not a reviewed Windows package");
  const unavailable = () => { throw new Error("Unexpected startup network request"); };
  const manager = Managers.createManager({ resourceRoot: path.join(root, "bundles"), dependencies: { github: {
    fetchGithubReleases: unavailable, fetchGithubTags: unavailable, resolveGithubTagCommit: unavailable } } });
  const state = manager.getState({ userDataDir: path.join(root, "user") });
  assert.equal(state.catalog.recommendedVersion, null);
  assert.deepEqual(state.catalog.versions, []);
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.deepEqual(state.catalog.installableVersions, []);
  assert.deepEqual(state.catalog.buildableVersions, []);
  assert.equal(manager.resolveSelection({}, {}, path.join(root, "user")).version, null);
  assert.equal(manager.distributionRequired, false);
  assert.deepEqual(manager.core.catalog, []);
  assert.equal(state.catalog.sourceUrl, "https://procrastinine.github.io/maclauncher-builds/#impacto");
  assert.deepEqual(state.catalog.sources.map(source => source.id), ["builds"]);
  assert.equal(manager.core.normalizeVersion("0.0.1.89"), "0.0.1.89");
  for (const pin of Packages) assert.equal(Adapter.hash(Managers.profileFor(pin.profileSha256)), pin.profileSha256);
});

test("explicit Impacto refresh queries only Builds and keeps unavailable source identities internal", async t => {
 let calls=0;t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"),"fetchProjectCatalog",async()=>{calls++;return{packages:[]}});
 const manager=Managers.createManager({dependencies:{github:{fetchGithubReleases:()=>assert.fail("Windows releases are not Mac downloads"),fetchGithubTags:()=>assert.fail("No source tag history query")}}});
 const state=await manager.refreshCatalog({force:true});assert.equal(calls,1);assert.deepEqual(state.versions,[]);assert.deepEqual(state.installableVersions,[]);
});

test("a sealed app resource does not replace the managed Impacto Windows V9 download",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
    t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"), "fetchProjectCatalog", async () => ({ packages: [] }));
    const root = fs.realpathSync(temporary(t)), resourceRoot = path.join(root, "bundles");
    const pin = Packages.find(row => row.version === "0.10.8.810-windows-v9");
    const directory = path.join(resourceRoot, "impacto", pin.version, "arm64");
    const executableRelative = "Impacto.app/Contents/MacOS/Impacto";
    const executable = Buffer.alloc(32);
    executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
    const payload = path.join(directory, "files"), notice = Buffer.from("Synthetic test notice");
    fs.mkdirSync(path.dirname(path.join(payload, executableRelative)), { recursive: true });
    fs.mkdirSync(path.join(payload, "licenses"));
    fs.writeFileSync(path.join(payload, executableRelative), executable, { mode: 0o755 });
    fs.writeFileSync(path.join(payload, "licenses", "LICENSE"), notice, { mode: 0o644 });
    const manifest = { schemaVersion: 1, managerId: "impacto", version: pin.version,
      upstreamRevision: pin.upstreamRevision, platform: "darwin", arch: "arm64", minimumMacOS: "13.0", executableRelative,
      provenance: { sourceRevision: pin.upstreamRevision, verifiedBuild: false },
      notices: [{ name: "Synthetic fixture", license: "Test", sourceUrl: Managers.SOURCE_URL, path: "licenses/LICENSE" }],
      dependencies: [{ file: executableRelative, links: ["/usr/lib/libSystem.B.dylib"] }],
      files: [{ path: executableRelative, size: executable.length, mode: 0o755, architectures: ["arm64"], sha256: Bundled.digest(executable) },
        { path: "licenses/LICENSE", size: notice.length, mode: 0o644, sha256: Bundled.digest(notice) }] };
    const manifestPath = path.join(directory, "manifest.json"), bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(manifestPath, bytes);
    let queries = 0;
    const manager = Managers.createManager({ resourceRoot, dependencies: {
      bundled: { hostArch: "arm64", systemVersionSync: () => "13.6", verifySignaturesSync: () => {} },
      github: { fetchGithubReleases: async () => {
        queries++; return [{ tag_name: "0.11.0.1" }, { tag_name: "0.10.8.810" }, { tag_name: "0.11.0.1" }];
      }, fetchGithubTags: async () => [
        { name: "0.11.0.1", commit: { sha: "f".repeat(40) } },
        { name: "0.10.8.810", commit: { sha: pin.upstreamRevision } }
      ], resolveGithubTagCommit: () => assert.fail("Pinned tag revisions must remain sufficient") }
    } });
    const userDataDir = path.join(root, "user"), initial = manager.getState({ userDataDir });
    assert.equal(queries, 0); assert.equal(initial.catalog.status, "idle");
    assert.deepEqual(initial.catalog.versions, []);
    assert.deepEqual(initial.catalog.includedVersions, []);
    assert.equal(initial.catalog.recommendedVersion, null);
    assert.deepEqual(initial.installed, []);
    assert.equal(fs.existsSync(userDataDir), false);
    await manager.refreshCatalog({ userDataDir, force: true });
    const refreshed = manager.getState({ userDataDir }), selected = manager.resolveSelection({}, {}, userDataDir);
    assert.deepEqual(refreshed.catalog.versions, []);
    assert.deepEqual(refreshed.catalog.includedVersions, []);
    assert.equal(refreshed.catalog.recommendedVersion, null); assert.equal(queries, 0);
    assert.deepEqual(refreshed.catalog.installableVersions, []);
    assert.equal(selected.version, null); assert.equal(selected.ready, false);
    assert.equal(selected.selectionRequired, true);
    assert.equal(selected.install, null);
    assert.deepEqual(fs.readFileSync(manifestPath), bytes);
    assert.deepEqual(fs.readFileSync(path.join(payload, executableRelative)), executable);
    assert.equal(fs.existsSync(manager.core.getInstallDir({ userDataDir, version: pin.version })), false);
  });
