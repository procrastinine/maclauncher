const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { createProjectBuildManager } = require("../src/modules/shared/runtime/project-build-manager");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const projectId = "sample-runtime", runtimeId = "sample-engine", repository = "ExampleOwner/runtime-builds";
const catalogResponse = rows => ({ status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId, updatePolicy: "manual", packages: rows })) });
function hostedRecord(version, { manifestSha256 = "a".repeat(64), sourceSha256 = "b".repeat(64), archive = Buffer.from(version) } = {}) {
  const tag = `${projectId}/v${version}/${process.arch}`, filename = `${projectId}-${version}-${process.arch}.tar.gz`;
  return { schemaVersion: 2, id: projectId, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: "13.0",
    manifestRelative: "runtime.json", manifestSha256, sourceSha256, updatePolicy: "manual", tag,
    asset: { filename, bytes: archive.length, sha256: sha(archive), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
}

test("revisions of one upstream version install side by side, keep a user default and stay usable after Refresh drops them",
  { skip: process.platform !== "darwin" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builds-multi-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "main.c"), executable = path.join(root, "native");
  fs.writeFileSync(source, "int main(void){return 0;}\n"); execFileSync("clang", [source, "-o", executable]);
  const packages = new Map();
  function packageFor(version) {
    const directory = path.join(root, "package-" + version); fs.mkdirSync(directory);
    const files = [["native", fs.readFileSync(executable), 0o755], ["source.tar.gz", Buffer.from("owned source " + version), 0o644]];
    for (const [name, bytes, mode] of files) { fs.writeFileSync(path.join(directory, name), bytes, { mode }); fs.chmodSync(path.join(directory, name), mode); }
    const manifest = { schemaVersion: 1, version, minimumMacOS: "13.0", files: files.map(([name, bytes, mode]) =>
      ({ path: name, size: bytes.length, mode, sha256: sha(bytes), ...(name === "native" ? { architectures: [process.arch === "x64" ? "x86_64" : "arm64"] } : {}) })) };
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(directory, "runtime.json"), bytes, { mode: 0o644 });
    const archive = Buffer.from("local archive " + version);
    const record = hostedRecord(version, { manifestSha256: sha(bytes), sourceSha256: manifest.files[1].sha256, archive });
    const wrapper = { ...record, sourceRelative: "source.tar.gz", files: [...manifest.files, { path: "runtime.json", size: bytes.length, mode: 0o644, sha256: sha(bytes) }] };
    packages.set(version, { directory, record, archive, wrapper }); return record;
  }
  const first = packageFor("0.41.0-MCLv1"), second = packageFor("0.41.0-MCLv2"), tenth = packageFor("0.41.0-MCLv10");
  let rows = [tenth, second, first], fetches = 0;
  const manager = createProjectBuildManager({ projectId, runtimeId, label: "Sample runtime", repository,
    manifestRelative: "runtime.json", sourceRelative: "source.tar.gz", executableRelative: "native", validateManifest: () => {},
    verifyPayload: selected => Bundled.verifyPayload(selected.root, selected.declaration),
    dependencies: { systemVersionSync: () => "26.0", fetchUrlBuffer: async () => { fetches++; return catalogResponse(rows); },
      downloadToFile: async (url, destination) => fs.writeFileSync(destination, [...packages.values()].find(item => item.record.asset.url === url).archive),
      extractArchive: async (archive, destination) => { const item = [...packages.values()].find(item => fs.readFileSync(archive).equals(item.archive));
        fs.writeFileSync(path.join(destination, "runtime-package.json"), JSON.stringify(item.wrapper));
        fs.cpSync(item.directory, path.join(destination, "files"), { recursive: true }); } } });
  const userDataDir = path.join(root, "data");
  let runtimeSettings = {};
  const action = (name, version) => runRuntimeManagerAction({ manager, action: name, payload: { version }, userDataDir,
    readSettings: () => runtimeSettings, saveSettings: next => { runtimeSettings = next; } });
  const select = (entry, settings = { runtimes: { [projectId]: runtimeSettings } }) => manager.resolveSelection(entry, settings, userDataDir);
  assert.equal(manager.getState({ userDataDir }).sections[0].supportsDefault, true, "Runtimes offers Set default as for other multi-version runtimes");
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.installableVersions, [tenth.version, second.version, first.version],
    "Every published revision is offered in publisher order");
  const one = await action("install", first.version), two = await action("install", second.version);
  assert.notEqual(one.installDir, two.installDir, "Each revision has its own installation directory");
  assert.deepEqual(manager.getState({ userDataDir }).installed.filter(row => row.ready).map(row => row.version).sort(), [first.version, second.version],
    "Installing a newer revision leaves the earlier one installed");
  assert.equal(runtimeSettings.defaultVersion, first.version, "The committed first-install default is retained");
  assert.equal(select(null).version, first.version, "A later install does not silently change the default");
  assert.equal(manager.resolveSelection(null, { runtimes: { [projectId]: { defaultVersion: null } } }, userDataDir).selectionRequired, true);
  assert.equal(manager.resolveSelection(null, { runtimes: { [projectId]: runtimeSettings } }, userDataDir,
    { recommended: () => second.version }).version, second.version, "A game recommendation precedes the global default");
  assert.equal(manager.resolveSelection({ runtimeData: { [runtimeId]: { version: first.version } } },
    { runtimes: { [projectId]: runtimeSettings } }, userDataDir, { recommendedVersion: second.version }).version, first.version);
  const incompatible = manager.resolveSelection(null, { runtimes: { [projectId]: runtimeSettings } }, userDataDir,
    { version: second.version, compatible: pin => pin.version === first.version });
  assert.equal(incompatible.version, second.version); assert.equal(incompatible.ready, false);
  assert.match(incompatible.reason, /incompatible runtime profile/);
  await action("setDefault", second.version);
  assert.equal(select(null).version, second.version);
  const pinnedGame = { runtimeData: { [runtimeId]: { version: first.version } } };
  assert.equal(select(pinnedGame).version, first.version, "A per-game choice overrides the user's default");
  assert.equal(select(pinnedGame).ready, true);
  rows = [tenth];
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.installableVersions, [tenth.version]);
  assert.equal(select(null).version, second.version, "Refresh keeps the default");
  assert.equal(select(null).ready, true, "A revision withdrawn from the catalog stays usable through its installation");
  assert.equal(select(pinnedGame).ready, true);
  await action("uninstall", first.version);
  assert.equal(select(null).ready, true, "Removing one revision leaves the others");
  assert.equal(select(pinnedGame).ready, false, "The removed revision stays the game's choice until changed");
  assert.equal(fetches, 2, "Only explicit Refresh reads the catalog");
});

test("module-pinned Builds revisions are listed together and offer a user default", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builds-multi-version-pinned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const revision = "1".repeat(40), versions = ["MCLv1-1028-kag3-1", "MCLv1-1001"];
  const manager = createPinnedNativeManager({ id: projectId, label: "Sample engine", projectBuilds: { projectId, repository },
    catalog: versions.map(version => ({ version, upstreamRevision: revision, localBuild: false })),
    dependencies: { systemVersionSync: () => "26.0", projectBuilds: { fetchUrlBuffer: async () => catalogResponse(versions.map(version => hostedRecord(version))) } } });
  const userDataDir = path.join(root, "data");
  assert.equal(manager.getState({ userDataDir }).sections[0].supportsDefault, true);
  await manager.refreshCatalog({ userDataDir, force: true });
  const state = manager.getState({ userDataDir });
  assert.deepEqual(state.catalog.installableVersions, versions, "Both revisions of one upstream revision are installable");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, versions[0], "The committed catalog fallback is retained");
  const chosen = manager.resolveSelection(null, { runtimes: { [projectId]: manager.applySettingsUpdate("setDefault", { version: versions[1] }, {}) } }, userDataDir);
  assert.equal(chosen.version, versions[1]); assert.equal(chosen.requiresDownload, true);
});

test("version lists order revisions by their numbers", async () => {
  const { build } = require("vite");
  const bundle = await build({ configFile: false, logLevel: "silent", build: { write: false,
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/runtime-inspector-model.ts"),
    rollupOptions: { output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, "runtime-inspector-model.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  const { runtimeInspectorVersions } = compiled.exports, list = versions => runtimeInspectorVersions({ catalog: { versions }, installed: [] });
  assert.deepEqual(list(["0.41.0-MCLv2", "0.41.0-MCLv10", "0.41.0-MCLv1"]), ["0.41.0-MCLv10", "0.41.0-MCLv2", "0.41.0-MCLv1"]);
  assert.deepEqual(list(["1.9-MCLv1", "1.12-MCLv1"]), ["1.12-MCLv1", "1.9-MCLv1"]);
  assert.deepEqual(list(["MCLv1-1001", "MCLv1-1028-kag3-1"]), ["MCLv1-1028-kag3-1", "MCLv1-1001"]);
  assert.deepEqual(list(["4.2.2", "4.10.0", "4.3.0"]), ["4.10.0", "4.3.0", "4.2.2"]);
});

test("every named catalog record is listed; records this launcher cannot use show their reason", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builds-mixed-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"), revision = "2".repeat(40);
  const later = { ...hostedRecord("0.41.0-MCLv5"), schemaVersion: 3, futureLayout: true }; delete later.asset;
  const damaged = hostedRecord("0.41.0-MCLv4"); damaged.asset = { ...damaged.asset, sha256: "not-a-checksum" };
  const otherCpu = { ...hostedRecord("0.41.0-MCLv8"), arch: "riscv64", launcherArchitectures: ["riscv64"] };
  const rows = [later, { ...hostedRecord("0.41.0-MCLv3"), launcherContract: 2 }, damaged, otherCpu,
    { ...hostedRecord("0.41.0-MCLv2"), manifestRelative: "package.json" }, { ...hostedRecord("0.41.0-MCLv1"), launcherContract: 1, futureCapability: "x" },
    { version: "../escape" }, null];
  const reasons = {
    "0.41.0-MCLv5": "Requires a newer MacLauncher.", "0.41.0-MCLv3": "Requires a newer MacLauncher.",
    "0.41.0-MCLv4": "The runtime download does not match its project, version, architecture or repository.",
    "0.41.0-MCLv8": "Requires a newer MacLauncher.", "0.41.0-MCLv2": "Requires a newer MacLauncher." };
  const fetchUrlBuffer = async () => catalogResponse(rows);
  const project = createProjectBuildManager({ projectId, runtimeId, label: "Sample runtime", repository, manifestRelative: "runtime.json",
    sourceRelative: "source.tar.gz", executableRelative: "native", validateManifest: () => {}, verifyPayload: () => {},
    dependencies: { systemVersionSync: () => "26.0", fetchUrlBuffer } });
  // Only the older records without `source` use a launcher entry, and only for
  // their source revision. A later record describes itself.
  const native = createPinnedNativeManager({ id: projectId, label: "Sample engine", projectBuilds: { projectId, repository },
    catalog: [{ version: "0.41.0-MCLv1", upstreamRevision: revision, localBuild: false },
      { version: "0.41.0-MCLv2", upstreamRevision: revision, localBuild: false, sourceArtifact: { sha256: "c".repeat(64) } }],
    dependencies: { systemVersionSync: () => "26.0", projectBuilds: { fetchUrlBuffer: async () => catalogResponse([...rows,
      { ...hostedRecord("0.41.0-MCLv6"), source: { repository: "ExampleOwner/runtime-source", revision: "3".repeat(40) },
        capabilities: { decodedFrameAPI: 1, nativeAbi: { sdlEventLoop: "dynamic" } } }, hostedRecord("0.41.0-MCLv7")]) } } });
  const nativeReasons = { ...reasons, "0.41.0-MCLv7": "This version does not identify its source revision." };
  delete nativeReasons["0.41.0-MCLv2"];
  for (const [manager, expected, installable] of [[project, reasons, ["0.41.0-MCLv1"]],
    [native, nativeReasons, ["0.41.0-MCLv2", "0.41.0-MCLv1", "0.41.0-MCLv6"]]]) {
    await manager.refreshCatalog({ userDataDir, force: true });
    const { catalog } = manager.getState({ userDataDir }), builds = catalog.sources.find(source => source.id === "builds");
    assert.deepEqual(catalog.installableVersions, installable, "Only usable records are installable");
    assert.deepEqual([...builds.versions].sort(), [...installable, ...Object.keys(expected)].sort(), "Every named record is listed");
    for (const [version, reason] of Object.entries(expected)) {
      assert.equal(catalog.versionRequirements[version].installReason, reason);
      assert.equal(catalog.versionRequirements[version].requiresDownload, true, "Runtimes keeps the row visible");
    }
    if (process.platform === "darwin")
      await assert.rejects(runRuntimeManagerAction({ manager, action: "install", payload: { version: "0.41.0-MCLv3" }, userDataDir,
        readSettings: () => ({}), saveSettings: () => {} }), /Requires a newer MacLauncher/);
    const selected = manager.resolveSelection({ runtimeData: { [runtimeId]: { version: "0.41.0-MCLv5" }, [projectId]: { version: "0.41.0-MCLv5" } } }, {}, userDataDir);
    assert.equal(selected.ready, false);
    assert.equal(selected.reason, "Requires a newer MacLauncher.", "A game set to that version reports why");
  }
  const later6 = native.core.listCatalog({ userDataDir }).find(entry => entry.version === "0.41.0-MCLv6");
  assert.equal(later6.upstreamRevision, "3".repeat(40), "The record's source names its revision");
  assert.equal(later6.decodedFrameAPI, 1, "Record capabilities reach the entry modules read");
  assert.deepEqual(later6.nativeAbi, { sdlEventLoop: "dynamic" });
});

