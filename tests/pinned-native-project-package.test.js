const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Native = require("../src/modules/shared/runtime/local-native");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("hosted Intel packages inspect real slices without requiring matching inventory annotations", {skip: process.platform !== "darwin"}, async t => {
  const {createProjectNativePackage} = require("../src/modules/shared/runtime/project-native-package");
  const {nativeTool} = require("./helpers/managed-tool-fixture.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-project-intel-child-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const binary = nativeTool(path.join(root, "native"), "", {architecture: "x64"}).binary;
  const librarySource = path.join(root, "child.c"), libraryPath = path.join(root, "child.dylib");
  fs.writeFileSync(librarySource, "int child_value(void) { return 1; }\n");
  execFileSync("clang", ["-arch", "x86_64", "-dynamiclib", "-mmacosx-version-min=13.0", librarySource, "-o", libraryPath], {stdio: "pipe"});
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", libraryPath], {stdio: "pipe"});
  const libraryBytes = fs.readFileSync(libraryPath);
  const id = "sample-child", repository = "ExampleOwner/runtime-builds", revision = "1".repeat(40);
  let sequence = 0;
  function fixture({manifestFlag, wrapperFlag = "x86_64", launchers = ["arm64", "x64"],
    sourceRepository = "ExampleOwner/source", sourceRevision = revision, provenanceRevision = revision} = {}) {
    const directory = path.join(root, "case-" + sequence++), payload = path.join(directory, "files");
    const entries = [["bin/host", binary, 0o755], ["lib/child.dylib", libraryBytes, 0o755], ["LICENSE", Buffer.from("Fixture license\n"), 0o644]];
    const files = entries.map(([name, bytes, mode]) => {
      const file = path.join(payload, "files", name);
      fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes, {mode}); fs.chmodSync(file, mode);
      return {path: name, size: bytes.length, mode, sha256: sha(bytes), ...(name !== "LICENSE" ?
        {architectures: ["x86_64"], ...(manifestFlag !== undefined ? {executionArchitecture: manifestFlag} : {})} : {})};
    });
    const manifest = {schemaVersion: 1, managerId: id, version: "99.0.1", upstreamRevision: revision,
      arch: "x64", platform: "darwin", minimumMacOS: "13.0", executableRelative: "bin/host", files,
      provenance: {sourceRevision: provenanceRevision}, dependencies: [],
      notices: [{name: "Fixture", license: "MIT", sourceUrl: "https://example.com/source", path: "LICENSE"}]};
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(payload, "manifest.json"), bytes, {mode: 0o644});
    const filename = id + "-99.0.1-x64.tar.gz", tag = id + "/v99.0.1/x64";
    const record = {schemaVersion: 2, id, version: manifest.version, arch: "x64", launcherArchitectures: launchers,
      minimumMacOS: "13.0", manifestRelative: "manifest.json", manifestSha256: sha(bytes), sourceSha256: sha(bytes),
      source: {repository: sourceRepository, revision: sourceRevision}, updatePolicy: "manual", tag,
      asset: {filename, bytes: 1, sha256: "2".repeat(64), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}`}};
    const wrapper = {...record, files: [...files.map(file => {
      const {executionArchitecture, ...value} = file;
      return {...value, path: "files/" + value.path, ...(value.architectures && wrapperFlag !== undefined ? {executionArchitecture: wrapperFlag} : {})};
    }), {path: "manifest.json", size: bytes.length, mode: 0o644, sha256: sha(bytes)}]};
    const writeWrapper = () => fs.writeFileSync(path.join(directory, "runtime-package.json"), JSON.stringify(wrapper));
    writeWrapper();
    return {directory, payload, manifest, wrapper, record, writeWrapper, pin: {version: manifest.version, upstreamRevision: sourceRevision, projectPackage: record}};
  }
  const adapter = createProjectNativePackage({projectId: id, repository}, {id, catalog: []});
  for (const [name, flags] of [
    ["wrapper identifies its Intel child", {}],
    ["legacy wrapper omits its role", {manifestFlag: "x86_64", wrapperFlag: undefined}],
    ["both legacy inventories omit roles", {wrapperFlag: undefined}]
  ]) await t.test(name, async () => {
    // Use a sentinel to distinguish an intentionally absent wrapper field from
    // the fixture's ordinary producer-style default.
    const item = fixture(flags);
    if (Object.hasOwn(flags, "wrapperFlag") && flags.wrapperFlag === undefined) {
      for (const file of item.wrapper.files) delete file.executionArchitecture;
      item.writeWrapper();
    }
    await adapter.prepare({unpacked: item.directory, pin: item.pin});
    const selected = adapter.inspectInstalled(item.directory, item.pin);
    assert.ok(selected.declaration.files.filter(file => file.architectures).every(file => file.executionArchitecture === "x86_64"));
    assert.equal(selected.declaration.files.find(file => file.path.endsWith("LICENSE")).executionArchitecture, undefined);
    assert.equal(sha(fs.readFileSync(path.join(item.directory, "project-payload/manifest.json"))), item.record.manifestSha256);
  });
  await t.test("unused wrapper roles do not override actual slices or the executable contract", async () => {
    for (const wrapperFlag of ["arm64", "x64", "universal", "", null]) {
      const item = fixture({wrapperFlag});
      await adapter.prepare({unpacked: item.directory, pin: item.pin});
      assert.deepEqual(Native.readMachOArchitectures(path.join(item.directory,'project-payload/files/bin/host')),['x86_64']);
    }
    const item = fixture({manifestFlag: "arm64"});
    await adapter.prepare({unpacked:item.directory,pin:item.pin});
    assert.deepEqual(Native.readMachOArchitectures(path.join(item.directory,'project-payload/files/bin/host')),['x86_64']);
  });
  await t.test("wrapper file facts do not pin a managed payload while real CPU validation remains", async () => {
    for (const mutate of [file => file.sha256 = "3".repeat(64), file => file.size++, file => file.mode = 0o644,
      file => file.path = "files/bin/other"]) {
      const item = fixture(); mutate(item.wrapper.files[0]); item.writeWrapper();
      await adapter.prepare({unpacked: item.directory, pin: item.pin});
      assert.deepEqual(Native.readMachOArchitectures(path.join(item.directory,'project-payload/files/bin/host')),['x86_64']);
    }
    const wrongCPU = fixture();wrongCPU.wrapper.files[0].architectures = ['arm64'];wrongCPU.writeWrapper();
    await adapter.prepare({unpacked:wrongCPU.directory,pin:wrongCPU.pin});
    assert.deepEqual(Native.readMachOArchitectures(path.join(wrongCPU.directory,'project-payload/files/bin/host')),['x86_64']);
    const item = fixture(); fs.writeFileSync(path.join(item.payload, "files/LICENSE"), "Changed license\n");
    await adapter.prepare({unpacked:item.directory,pin:item.pin});
    assert.equal(fs.readFileSync(path.join(item.directory,'project-payload/files/LICENSE'),'utf8'),'Changed license\n');
    const falseSlices = fixture();
    falseSlices.manifest.files[0].architectures = ["arm64", "x86_64"];
    falseSlices.wrapper.files[0].architectures = ["arm64", "x86_64"];
    const manifestBytes = Buffer.from(JSON.stringify(falseSlices.manifest));
    fs.writeFileSync(path.join(falseSlices.payload, "manifest.json"), manifestBytes);
    falseSlices.record.manifestSha256 = falseSlices.record.sourceSha256 = sha(manifestBytes);
    falseSlices.wrapper.manifestSha256 = falseSlices.wrapper.sourceSha256 = sha(manifestBytes);
    Object.assign(falseSlices.wrapper.files.at(-1), {sha256: sha(manifestBytes), size: manifestBytes.length});
    falseSlices.writeWrapper();
    await adapter.prepare({unpacked:falseSlices.directory,pin:falseSlices.pin});
    assert.deepEqual(Native.readMachOArchitectures(path.join(falseSlices.directory,'project-payload/files/bin/host')),['x86_64']);
  });
  await t.test("Intel-only records receive no derived role", async () => {
    const item = fixture({launchers: ["x64"]});
    await adapter.prepare({unpacked: item.directory, pin: item.pin});
    assert.equal(adapter.inspectInstalled(item.directory,item.pin).manifest.arch,'x64');
  });
  await t.test("producer source identity does not replace the checksum-bound upstream identity", async () => {
    const item = fixture({sourceRepository: repository, sourceRevision: "b".repeat(40)});
    await adapter.prepare({unpacked: item.directory, pin: item.pin});
    const selected = adapter.inspectInstalled(item.directory, item.pin);
    assert.equal(selected.manifest.upstreamRevision, revision);
    assert.equal(selected.declaration.source.revision, "b".repeat(40));
    const wrongProvenance = fixture({sourceRepository: repository, sourceRevision: "b".repeat(40), provenanceRevision: "c".repeat(40)});
    const provenanceReceipt = await adapter.prepare({unpacked: wrongProvenance.directory, pin: wrongProvenance.pin});
    assert.equal(provenanceReceipt.sourceIdentity.provenanceRevision, "c".repeat(40));
    assert.throws(() => Bundled.validateManifest(wrongProvenance.manifest), /Invalid bundled runtime manifest/);
    const wrongUpstream = fixture({sourceRevision: "b".repeat(40)});
    const upstreamReceipt = await adapter.prepare({unpacked: wrongUpstream.directory, pin: wrongUpstream.pin});
    assert.equal(upstreamReceipt.sourceIdentity.upstreamRevision, revision);
    assert.equal(upstreamReceipt.sourceIdentity.revision, "b".repeat(40));
    const legacy = fixture(); delete legacy.record.source;
    legacy.pin.upstreamRevision = "c".repeat(40);
    const legacyReceipt = await adapter.prepare({unpacked: legacy.directory, pin: legacy.pin});
    assert.equal(legacyReceipt.sourceIdentity.receiptRevision, "c".repeat(40));
  });
  await t.test("registered managers install the selected CPU and reopen offline without comparing role annotations", async () => {
    const item = fixture({sourceRepository: repository, sourceRevision: "b".repeat(40)}), archive = path.join(root, "fixture.tar.gz");
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", item.directory, "runtime-package.json", "files"]);
    const bytes = fs.readFileSync(archive); item.record.asset.sha256 = sha(bytes); item.record.asset.bytes = bytes.length;
    let offline = false, requests = 0;
    const options = {id, label: "Fixture child", projectBuilds: {projectId: id, repository},
      dependencies: {systemVersionSync: () => "26.0", projectBuilds: {fetchUrlBuffer: async () => {
        assert.equal(offline, false); requests++;
        return {status: 200, body: Buffer.from(JSON.stringify({schemaVersion: 2, projectId: id, updatePolicy: "manual", packages: [item.record]}))};
      }}, downloadToFile: async (_url, destination) => {assert.equal(offline, false); requests++; fs.copyFileSync(archive, destination);}}};
    const manager = createPinnedNativeManager(options), userDataDir = path.join(root, "profile");
    await manager.refreshCatalog({userDataDir, force: true});
    const installed = await manager.installRuntime({userDataDir, version: item.record.version, architecture: "x64"});
    assert.equal(installed.version, item.record.version);
    assert.equal(installed.upstreamRevision, "b".repeat(40), "The existing receipt key retains the corresponding producer source identity");
    assert.equal(adapter.inspectInstalled(installed.installDir, installed.catalogEntry).manifest.upstreamRevision, revision);
    offline = true; const count = requests;
    const reopened = createPinnedNativeManager(options);
    assert.equal(reopened.resolveSelection({}, {}, userDataDir, {architecture: "x64"}).ready, true);
    const receiptPath = path.join(installed.installDir, "runtime.json"), receipt = JSON.parse(fs.readFileSync(receiptPath));
    receipt.upstreamRevision = "d".repeat(40); fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const observed = reopened.resolveSelection({}, {}, userDataDir, {architecture: "x64"});
    assert.equal(observed.ready, true);
    assert.equal(observed.install.sourceIdentity.receiptRevision, "d".repeat(40));
    assert.equal(requests, count);
    offline = false;
    const library = createPinnedNativeManager({...options, nativeLibrary: true});
    const libraryInstall = await library.installRuntime({userDataDir: path.join(root, "library-profile"), version: item.record.version, architecture: "x64"});
    assert.equal(libraryInstall.version,item.record.version);
    assert.deepEqual(Native.readMachOArchitectures(libraryInstall.executablePath),['x86_64']);
  });
});

test("hosted packages retain source identities, offline selection and listed included versions without source preparation", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-project-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "sample-host", repository = "ExampleOwner/runtime-builds", revision = "1".repeat(40), sourceSha256 = "2".repeat(64);
  // The fixture simulates macOS 26; a system executable on newer hosts may
  // legitimately have a higher deployment target than that simulated host.
  const {nativeTool} = require("./helpers/managed-tool-fixture.cjs");
  const binary = nativeTool(path.join(root, "native"), "", {architecture: process.arch}).binary;
  const architectures = Native.readMachOArchitectures(path.join(root, "native/tool"));
  const packages = new Map(), source = { repository: "ExampleOwner/source", revision };
  // Each record names its source revision; the launcher holds no recipe row.
  function makePackage(version, nativeApi) {
    const directory = path.join(root, "packages", version), payload = path.join(directory, "files"), content = path.join(payload, "files");
    const fileValues = [["bin/host", binary, 0o755], ["LICENSE", Buffer.from("Sample license\n"), 0o644],
      ["share/profile.json", Buffer.from('{"schemaVersion":1}\n'), 0o644]];
    for (const [name, bytes, mode] of fileValues) {
      fs.mkdirSync(path.dirname(path.join(content, name)), { recursive: true });
      fs.writeFileSync(path.join(content, name), bytes, { mode }); fs.chmodSync(path.join(content, name), mode);
    }
    const files = fileValues.map(([name, bytes, mode]) => ({ path: name, size: bytes.length, mode, sha256: sha(bytes),
      ...(name === "bin/host" ? { architectures } : {}) }));
    const manifest = { schemaVersion: 1, managerId: id, version, upstreamRevision: revision, arch: process.arch,
      platform: "darwin", minimumMacOS: "13.0", executableRelative: "bin/host", files,
      provenance: { sourceRevision: revision }, ...(nativeApi ? { nativeApi } : {}), dependencies: [], environmentRelative: { PYTHONHOME: "share" },
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
      manifestRelative: "manifest.json", manifestSha256: sha(bytes), sourceSha256, source, updatePolicy: "manual", tag, ...(nativeApi ? { capabilities: { nativeApi } } : {}),
      asset: { filename, bytes: archiveBytes.length, sha256: sha(archiveBytes), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
    packages.set(version, { directory, payload, content, archive, record, wrapper, manifest });
    return record;
  }
  const first = makePackage("1.0"), second = makePackage("2.0");
  const includedRoot = path.join(root, "included"), includedDirectory = path.join(includedRoot, id, first.version, process.arch);
  fs.mkdirSync(path.dirname(includedDirectory), { recursive: true });
  fs.cpSync(packages.get(first.version).payload, includedDirectory, { recursive: true });
  let rows = [second, first], fetches = 0, downloads = 0, sourcePreparations = 0, sourceBuilds = 0, signatureChecks = 0;
  const options = { id, label: "Sample host", supportsDefault: true,
    projectBuilds: { projectId: id, repository }, bundledExecution: "direct",
    bundledRuntime: Bundled.createBundledNativeRuntime({ managerId: id, resourceRoot: includedRoot,
      dependencies: { systemVersionSync: () => "26.0", verifySignaturesSync: () => {} } }),
    resolveExecutable: directory => path.join(directory, "upstream-layout", "host"),
    buildRuntime: async () => { sourceBuilds++; throw Error("Unexpected source build"); },
    prepareInstall: async () => { sourcePreparations++; throw Error("Unexpected source preparation"); },
    dependencies: { systemVersionSync: () => "26.0", projectBuilds: {
      fetchUrlBuffer: async () => { fetches++; return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: "manual", packages: rows })) }; },
      verifySignatures: async () => { signatureChecks++; }
    }, downloadToFile: async (url, destination) => { downloads++; const item = [...packages.values()].find(item => item.record.asset.url === url); fs.copyFileSync(item.archive, destination); } } };
  const manager = createPinnedNativeManager(options), userDataDir = path.join(root, "data");
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(fetches, 0, "Status does not discover");
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(manager.getState({ userDataDir }).installed.find(row => row.version === first.version).source, "bundled",
    "A listed version included in the app needs no install");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, second.version, "The newest compatible published runtime supplies the manager default");
  assert.equal(manager.resolveSelection(null, { runtimes: { [id]: { defaultVersion: first.version } } }, userDataDir).version, first.version,
    "An explicit included choice survives Refresh");
  assert.equal(manager.core.listCatalog({ userDataDir }).find(pin => pin.version === second.version).asset.url, second.asset.url, "Hosted binary replaces the same-version upstream source download");
  const installed = await manager.installRuntime({ userDataDir, version: second.version });
  assert.equal(installed.upstreamRevision, revision, "The true source revision is retained, separately from the manifest SHA");
  assert.equal(installed.executablePath, path.join(installed.installDir, "project-payload/files/bin/host"));
  assert.equal(installed.environmentRelative.PYTHONHOME, "project-payload/files/share");
  assert.equal(installed.runtimeFiles.profile, "project-payload/files/share/profile.json");
  assert.deepEqual([sourcePreparations, sourceBuilds, downloads, signatureChecks], [0, 0, 1, 1]);
  const fresh = createPinnedNativeManager({ ...options, bundledRuntime: undefined, bundledExecution: "copy" });
  const freshData = path.join(root, "fresh-data"), beforeFresh = fetches;
  assert.deepEqual(fresh.getState({ userDataDir: freshData }).catalog.versions, []);
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
  assert.equal(reopened.resolveSelection(null, settings, userDataDir).ready, true, "Managed auxiliary resources do not need to match recorded per-file bytes");
  rows = [{ ...first, sourceSha256: "4".repeat(64) }];
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(manager.getState({ userDataDir }).catalog.versionRequirements[first.version].installReason ?? null, null,
    "A published record is not compared with a launcher build recipe");
  const published = makePackage("3.0", "sample-v1");
  rows = [published];
  const unpinned = createPinnedNativeManager({ ...options, bundledRuntime: undefined, bundledExecution: "copy",
    projectBuilds: { projectId: id, repository, validateManifest(manifest, pin) {
      if (pin.nativeApi !== "sample-v1" || manifest.nativeApi !== pin.nativeApi) throw new Error("Unsupported sample native API.");
    } } });
  const unpinnedData = path.join(root, "unpinned-data");
  await unpinned.refreshCatalog({ userDataDir: unpinnedData, force: true });
  assert.equal(unpinned.resolveSelection(null, {}, unpinnedData).version, published.version, "A newly published compatible version supplies the manager default");
  const newInstall = await unpinned.installRuntime({ userDataDir: unpinnedData, version: published.version });
  assert.equal(newInstall.version, published.version, "A published version needs real source/API metadata, not a launcher version pin");
  assert.equal(newInstall.upstreamRevision, revision);
  rows = [{ ...published, capabilities: { nativeApi: "sample-v2" } }];
  await unpinned.refreshCatalog({ userDataDir: unpinnedData, force: true });
  await assert.rejects(unpinned.installRuntime({ userDataDir: path.join(root, "incompatible-data"), version: published.version }), /native API/);
});
