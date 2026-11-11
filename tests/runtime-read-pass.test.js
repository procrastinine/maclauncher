const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createProjectBuildManager } = require("../src/modules/shared/runtime/project-build-manager");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const ReadPass = require("../src/modules/shared/runtime/read-pass");
const Translators = require("../src/modules/shared/runtime/wine-translators");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const projectId = "sample-translator", runtimeId = "sample-translator", repository = "ExampleOwner/runtime-builds";

test("a read pass computes each owner's value once and ends with its outermost call", () => {
  const owner = {}, other = {};
  let computed = 0;
  const value = () => ReadPass.remember(owner, "key", () => ++computed);
  assert.equal(value(), 1); assert.equal(value(), 2, "outside a pass every call computes");
  ReadPass.within(() => {
    assert.equal(value(), 3); assert.equal(value(), 3);
    assert.equal(ReadPass.within(() => value()), 3, "a nested call joins the open pass");
    assert.equal(ReadPass.remember(other, "key", () => "other"), "other", "owners keep separate values");
    ReadPass.forget();
    assert.equal(value(), 4, "a write inside the pass makes earlier reads stale");
  });
  assert.equal(ReadPass.active(), false);
  assert.equal(value(), 5);
  assert.throws(() => ReadPass.within(() => { ReadPass.remember(owner, "failed", () => { throw new Error("unreadable"); }); }), /unreadable/);
  assert.equal(ReadPass.active(), false, "a failure ends the pass");
});

// Selecting a game reads every installed translator build: the manager's
// state, then each version's selection. With many installed builds of one
// manager, each build's files are read a bounded number of times, however
// many builds there are.
test("a translator inventory reads each installed build a bounded number of times", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-pass-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "main.c"), executable = path.join(root, "native");
  fs.writeFileSync(source, "int main(void){return 0;}\n"); execFileSync("clang", ["-mmacosx-version-min=13.0", source, "-o", executable]);
  const packages = new Map();
  function packageFor(version) {
    const directory = path.join(root, "package-" + version); fs.mkdirSync(directory);
    const files = [["native", fs.readFileSync(executable), 0o755], ["source.tar.gz", Buffer.from("owned source " + version), 0o644]];
    for (const [name, bytes, mode] of files) { fs.writeFileSync(path.join(directory, name), bytes, { mode }); fs.chmodSync(path.join(directory, name), mode); }
    const manifest = { schemaVersion: 1, version, minimumMacOS: "13.0", files: files.map(([name, bytes, mode]) =>
      ({ path: name, size: bytes.length, mode, sha256: sha(bytes), ...(name === "native" ? { architectures: [process.arch === "x64" ? "x86_64" : "arm64"] } : {}) })) };
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(directory, "runtime.json"), bytes, { mode: 0o644 });
    const archive = Buffer.from("local archive " + version);
    const tag = `${projectId}/v${version}/${process.arch}`, filename = `${projectId}-${version}-${process.arch}.tar.gz`;
    const record = { schemaVersion: 2, id: projectId, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: "13.0",
      manifestRelative: "runtime.json", manifestSha256: sha(bytes), sourceSha256: manifest.files[1].sha256, updatePolicy: "manual", tag,
      asset: { filename, bytes: archive.length, sha256: sha(archive), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
    const wrapper = { ...record, sourceRelative: "source.tar.gz", files: [...manifest.files, { path: "runtime.json", size: bytes.length, mode: 0o644, sha256: sha(bytes) }] };
    packages.set(version, { directory, record, archive, wrapper }); return record;
  }
  const versions = Array.from({ length: 8 }, (_, index) => `1.0.0-MCLv${index + 1}`), rows = versions.map(packageFor).reverse();
  const created = createProjectBuildManager({ projectId, runtimeId, label: "Sample translator", repository,
    manifestRelative: "runtime.json", sourceRelative: "source.tar.gz", executableRelative: "native", validateManifest: () => {},
    verifyPayload: selected => Bundled.verifyPayload(selected.root, selected.declaration),
    dependencies: { systemVersionSync: () => "26.0",
      fetchUrlBuffer: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId, updatePolicy: "manual", packages: rows })) }),
      downloadToFile: async (url, destination) => fs.writeFileSync(destination, [...packages.values()].find(item => item.record.asset.url === url).archive),
      extractArchive: async (archive, destination) => { const item = [...packages.values()].find(item => fs.readFileSync(archive).equals(item.archive));
        fs.writeFileSync(path.join(destination, "runtime-package.json"), JSON.stringify(item.wrapper));
        fs.cpSync(item.directory, path.join(destination, "files"), { recursive: true }); } } });
  const manager = Object.assign(created, { translatorEngine: "dxvk" });
  const userDataDir = path.join(root, "data");
  let runtimeSettings = {};
  await manager.refreshCatalog({ userDataDir, force: true });
  for (const version of versions) await runRuntimeManagerAction({ manager, action: "install", payload: { version }, userDataDir,
    readSettings: () => runtimeSettings, saveSettings: next => { runtimeSettings = next; } });

  const runtimes = path.join(userDataDir, "runtimes") + path.sep, reads = new Map(), read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (typeof file === "string" && file.startsWith(runtimes) && path.basename(file) === "runtime.json") reads.set(file, (reads.get(file) || 0) + 1);
    return read.call(this, file, ...args);
  });
  const settings = { runtimes: { [projectId]: runtimeSettings } };
  const describe = (_root, { version }) => ({ engine: "dxvk", component: "d3d-renderer", version, files: [], apis: [] });
  const choices = Translators.managedTranslators({ userDataDir, settings }, "crossover", [manager], undefined, describe);
  assert.deepEqual(choices.map(choice => choice.runtimeVersion).sort(), [...versions].sort(), "every installed build is a choice");
  const registrations = [...reads].filter(([file]) => path.basename(path.dirname(file)) !== "payload");
  assert.equal(registrations.length, versions.length, "each build's registration is read");
  const most = Math.max(...registrations.map(([, count]) => count));
  assert.ok(most <= 2, `one inventory read a build's registration ${most} times for ${versions.length} installed builds`);
  const total = [...reads.values()].reduce((sum, count) => sum + count, 0);
  assert.ok(total <= 4 * versions.length, `one inventory made ${total} metadata reads for ${versions.length} installed builds`);

  reads.clear();
  const state = manager.getState({ userDataDir, settings: runtimeSettings });
  assert.deepEqual(state.installed.filter(row => row.ready).map(row => row.version).sort(), [...versions].sort());
  const stateMost = Math.max(...[...reads].filter(([file]) => path.basename(path.dirname(file)) !== "payload").map(([, count]) => count));
  assert.ok(stateMost <= 2, `the manager state read a build's registration ${stateMost} times`);

  // A later call reads again, so an installation made between them is seen.
  reads.clear();
  manager.getState({ userDataDir, settings: runtimeSettings });
  assert.ok(reads.size >= versions.length, "a new pass reads the installed builds again");
});
