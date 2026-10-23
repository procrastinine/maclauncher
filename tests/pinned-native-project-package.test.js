const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Native = require("../src/modules/shared/runtime/local-native");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("pinned hosted packages retain source identities, offline selection and included defaults without source preparation", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-project-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "sample-host", repository = "ExampleOwner/runtime-builds", revision = "1".repeat(40), sourceSha256 = "2".repeat(64);
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  const architectures = Native.readMachOArchitectures("/usr/bin/true");
  const packages = new Map(), originalPins = [];
  function makePackage(version) {
    const directory = path.join(root, "packages", version), payload = path.join(directory, "files"), content = path.join(payload, "files");
    const fileValues = [["bin/host", fs.readFileSync("/usr/bin/true"), 0o755], ["LICENSE", Buffer.from("Sample license\n"), 0o644],
      ["share/profile.json", Buffer.from('{"schemaVersion":1}\n'), 0o644]];
    for (const [name, bytes, mode] of fileValues) {
      fs.mkdirSync(path.dirname(path.join(content, name)), { recursive: true });
      fs.writeFileSync(path.join(content, name), bytes, { mode }); fs.chmodSync(path.join(content, name), mode);
    }
    const files = fileValues.map(([name, bytes, mode]) => ({ path: name, size: bytes.length, mode, sha256: sha(bytes),
      ...(name === "bin/host" ? { architectures } : {}) }));
    const manifest = { schemaVersion: 1, managerId: id, version, upstreamRevision: revision, arch: process.arch,
      platform: "darwin", minimumMacOS: "13.0", executableRelative: "bin/host", files,
      provenance: { sourceRevision: revision }, dependencies: [], environmentRelative: { PYTHONHOME: "share" },
      runtimeFiles: { profile: "share/profile.json" }, notices: [{ name: "Sample", license: "MIT", sourceUrl: "https://example.com/source", path: "LICENSE" }] };
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(payload, "manifest.json"), bytes, { mode: 0o644 });
    const wrapper = { id, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: "13.0",
      sourceArtifact: { managerId: id, version, directoryRelative: `${id}/${version}-source.tar.gz`, sha256: sourceSha256, bytes: 1 },
      sourceSha256, manifestRelative: "manifest.json", manifestSha256: sha(bytes),
      files: [...files.map(file => ({ ...file, path: "files/" + file.path })), { path: "manifest.json", size: bytes.length, mode: 0o644, sha256: sha(bytes) }] };
    fs.writeFileSync(path.join(directory, "runtime-package.json"), JSON.stringify(wrapper));
    const filename = `${id}-${version}-${process.arch}.tar.gz`, archive = path.join(root, filename);
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", directory, "runtime-package.json", "files"]);
    const tag = `${id}/v${version}/${process.arch}`, archiveBytes = fs.readFileSync(archive);
    const record = { schemaVersion: 2, id, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS: "13.0",
      manifestRelative: "manifest.json", manifestSha256: sha(bytes), sourceSha256, updatePolicy: "manual", tag,
      asset: { filename, bytes: archiveBytes.length, sha256: sha(archiveBytes), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
    originalPins.push({ version, upstreamRevision: revision, architecture, sourceArtifact: wrapper.sourceArtifact, localBuild: true });
    packages.set(version, { directory, payload, content, archive, record, wrapper, manifest });
    return record;
  }
  const first = makePackage("1.0"), second = makePackage("2.0");
  const includedRoot = path.join(root, "included"), includedDirectory = path.join(includedRoot, id, first.version, process.arch);
  fs.mkdirSync(path.dirname(includedDirectory), { recursive: true });
  fs.cpSync(packages.get(first.version).payload, includedDirectory, { recursive: true });
  let rows = [second, first], fetches = 0, downloads = 0, sourcePreparations = 0, sourceBuilds = 0, signatureChecks = 0;
  const options = { id, label: "Sample host", supportsDefault: true, catalog: originalPins, recommendedVersion: first.version,
    projectBuilds: { projectId: id, repository }, bundledExecution: "direct",
    bundledRuntime: Bundled.createBundledNativeRuntime({ managerId: id, resourceRoot: includedRoot,
      dependencies: { systemVersionSync: () => "26.0", verifySignaturesSync: () => {} } }),
    discoverCatalog: async () => [{ ...originalPins[1], asset: { filename: "upstream.tar.gz", url: "https://example.com/upstream.tar.gz", sha256: "3".repeat(64) } }],
    resolveExecutable: directory => path.join(directory, "upstream-layout", "host"),
    buildRuntime: async () => { sourceBuilds++; throw Error("Unexpected source build"); },
    prepareInstall: async () => { sourcePreparations++; throw Error("Unexpected source preparation"); },
    dependencies: { systemVersionSync: () => "26.0", projectBuilds: {
      fetchUrlBuffer: async () => { fetches++; return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: "manual", packages: rows })) }; },
      verifySignatures: async () => { signatureChecks++; }
    }, downloadToFile: async (url, destination) => { downloads++; const item = [...packages.values()].find(item => item.record.asset.url === url); fs.copyFileSync(item.archive, destination); } } };
  const manager = createPinnedNativeManager(options), userDataDir = path.join(root, "data");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, first.version);
  assert.equal(manager.getState({ userDataDir }).installed[0].source, "bundled");
  assert.equal(fetches, 0);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, first.version, "Refresh preserves the existing included choice");
  assert.equal(manager.core.listCatalog({ userDataDir }).find(pin => pin.version === second.version).asset.url, second.asset.url, "Hosted binary replaces the same-version upstream source download");
  const installed = await manager.installRuntime({ userDataDir, version: second.version });
  assert.equal(installed.upstreamRevision, revision, "The true source revision is retained, separately from the manifest SHA");
  assert.equal(installed.executablePath, path.join(installed.installDir, "project-payload/files/bin/host"));
  assert.equal(installed.environmentRelative.PYTHONHOME, "project-payload/files/share");
  assert.equal(installed.runtimeFiles.profile, "project-payload/files/share/profile.json");
  assert.deepEqual([sourcePreparations, sourceBuilds, downloads, signatureChecks], [0, 0, 1, 1]);
  const fresh = createPinnedNativeManager({ ...options, bundledRuntime: undefined, bundledExecution: "copy" });
  const freshData = path.join(root, "fresh-data"), beforeFresh = fetches;
  assert.equal(fresh.getState({ userDataDir: freshData }).catalog.versionRequirements[second.version].requiresDownload, true,
    "A missing hosted binary requests download consent before the first catalog lookup");
  assert.equal(fetches, beforeFresh, "Status does not discover the missing package");
  const initial = await fresh.installRuntime({ userDataDir: freshData, version: second.version });
  assert.equal(initial.version, second.version); assert.equal(initial.source, "download");
  assert.equal(fetches, beforeFresh + 1, "Explicit first installation discovers its exact hosted binary");
  assert.deepEqual([sourcePreparations, sourceBuilds], [0, 0]);
  const settings = { runtimes: { [id]: { defaultVersion: second.version } } };
  rows = [first]; await manager.refreshCatalog({ userDataDir, force: true });
  const reopened = createPinnedNativeManager(options), count = fetches;
  assert.equal(reopened.resolveSelection(null, settings, userDataDir).version, second.version);
  assert.equal(reopened.resolveSelection(null, settings, userDataDir).ready, true, "A removed catalog entry retains its installed identity offline");
  assert.equal(fetches, count);
  fs.appendFileSync(path.join(installed.installDir, installed.runtimeFiles.profile), " ");
  assert.equal(reopened.resolveSelection(null, settings, userDataDir).ready, false, "Changed auxiliary resources fail execution verification");
  rows = [{ ...first, sourceSha256: "4".repeat(64) }];
  await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }), /source profile/);
  assert.equal(manager.getState({ userDataDir }).catalog.status, "error");
  assert.equal(manager.resolveSelection(null, {}, path.join(root, "offline-data")).version, first.version, "A catalog failure leaves the included default usable");
});
