const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createProjectBuildManager } = require("../src/modules/shared/runtime/project-build-manager");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("module-selected paths reuse flat packages and separately delivered source without copies", t => {
  const { inspectPackage } = require("../src/modules/shared/runtime/project-build-manager");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-executable-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [executableRelative, prefix] of [["Old.app/Contents/MacOS/old", ""], ["New.app/Contents/MacOS/new", "files/"]]) {
    const directory = path.join(root, executableRelative.split("/")[0]);
    const target = path.join(directory, prefix, executableRelative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync("/usr/bin/true", target);
    fs.chmodSync(target, 0o755);
    if (!prefix) fs.writeFileSync(path.join(directory, "source.tar.gz"), "source");
    const files = [executableRelative, ...(!prefix ? ["source.tar.gz"] : [])].map(name => {
      const bytes = fs.readFileSync(path.join(directory, prefix, name));
      return { path: name, size: bytes.length, mode: name === executableRelative ? 0o755 : 0o644,
        sha256: sha(bytes), ...(name === executableRelative ? { architectures: ["arm64", "x86_64"] } : {}) };
    });
    const manifest = { schemaVersion: 1, version: "1.0", minimumMacOS: "11.0", executableRelative, files };
    const bytes = Buffer.from(JSON.stringify(manifest)), file = path.join(directory, "manifest.json");
    fs.writeFileSync(file, bytes, { mode: 0o644 });
    const expectedSource = prefix ? sha(Buffer.from("separately published source")) : files[1].sha256;
    const record = { id: "sample", version: "1.0", minimumMacOS: "11.0", arch: "universal",
      manifestRelative: "manifest.json", manifestSha256: sha(bytes), sourceSha256: expectedSource };
    let validated = false, calls = 0;
    const format = { projectId: "sample", manifestRelative: "manifest.json",
      sourceRelative: prefix ? () => { assert.equal(validated, true); return null; } : "source.tar.gz",
      filesPrefix: prefix ? () => { assert.equal(validated, true); return prefix; } : "",
      validateManifest(value, selected) {
        assert.equal(value.version, record.version);
        if (selected.sourceSha256 !== expectedSource) throw new Error("The module's selected source identity changed.");
        validated = true;
      },
      executableRelative(value, selected) { assert.equal(validated, true); assert.equal(selected, record); calls++; return value.executableRelative; } };
    const selected = inspectPackage(directory, record, format);
    assert.equal(selected.executablePath, target);
    assert.equal(selected.payloadRoot, path.join(directory, prefix));
    Bundled.verifyPayload(directory, selected.declaration);
    if (prefix) assert.equal(fs.existsSync(path.join(directory, "source.tar.gz")), false, "Ordinary runtime content keeps corresponding source separate");
    fs.appendFileSync(file, " ");
    assert.throws(() => inspectPackage(directory, record, format), /manifest changed/);
    assert.equal(calls, 1, "Untrusted metadata never reaches the executable selector");
    fs.writeFileSync(file, bytes);
    assert.throws(() => inspectPackage(directory, { ...record, sourceSha256: "0".repeat(64) }, format), /selected source identity changed/);
    assert.throws(() => inspectPackage(directory, record, { ...format, executableRelative: () => "../outside" }), /relative|unsafe|invalid/i);
    assert.throws(() => inspectPackage(directory, record, { ...format, filesPrefix: () => "../" }), /relative|unsafe|invalid/i);
  }
});

test("project builds preserve offline fallbacks, explicit selections and verified version installations", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-project-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "main.c"), executable = path.join(root, "native");
  fs.writeFileSync(source, "int main(void){return 0;}\n"); execFileSync("clang", [source, "-o", executable]);
  const projectId = "sample-runtime", runtimeId = "sample-engine", repository = "ExampleOwner/runtime-builds", packages = new Map();
  function packageFor(version, minimumMacOS = "13.0") {
    const directory = path.join(root, "package-" + version); fs.mkdirSync(directory);
    const files = [["native", fs.readFileSync(executable), 0o755], ["source.tar.gz", Buffer.from("owned source " + version), 0o644]];
    for (const [name, bytes, mode] of files) { fs.writeFileSync(path.join(directory, name), bytes, { mode }); fs.chmodSync(path.join(directory, name), mode); }
    const manifest = { schemaVersion: 1, version, minimumMacOS, files: files.map(([name, bytes, mode]) =>
      ({ path: name, size: bytes.length, mode, sha256: sha(bytes), ...(name === "native" ? { architectures: [process.arch === "x64" ? "x86_64" : "arm64"] } : {}) })) };
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(directory, "runtime.json"), bytes, { mode: 0o644 });
    const archive = Buffer.from("local archive " + version), tag = projectId + "/v" + version + "/" + process.arch;
    const filename = projectId + "-" + version + "-" + process.arch + ".tar.gz";
    const record = { schemaVersion: 2, id: projectId, version, arch: process.arch, launcherArchitectures: [process.arch], minimumMacOS,
      manifestRelative: "runtime.json", manifestSha256: sha(bytes), sourceSha256: manifest.files[1].sha256, updatePolicy: "manual", tag,
      asset: { filename, bytes: archive.length, sha256: sha(archive), url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
    const wrapper = { ...record, sourceRelative: "source.tar.gz", files: [...manifest.files,
      { path: "runtime.json", size: bytes.length, mode: 0o644, sha256: sha(bytes) }] };
    packages.set(version, { directory, record, archive, wrapper }); return record;
  }
  const first = packageFor("1.0"), second = packageFor("2.0"), unsupported = packageFor("3.0", "99.0");
  let rows = [unsupported, second, first], fetches = 0, downloads = 0;
  const options = { projectId, runtimeId, label: "Sample runtime", supportsDefault: true, repository, manifestRelative: "runtime.json", sourceRelative: "source.tar.gz", executableRelative: "native",
    included: () => ({ root: packages.get("1.0").directory, record: first }), validateManifest: () => {},
    verifyPayload: selected => Bundled.verifyPayload(selected.root, selected.declaration),
    dependencies: { systemVersionSync: () => "26.0", fetchUrlBuffer: async url => { assert.equal(url, `https://raw.githubusercontent.com/${repository}/main/catalogs/${projectId}.json`); fetches++; return { status: 200,
      body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId, updatePolicy: "manual", packages: rows })) }; },
    downloadToFile: async (url, destination) => { downloads++; const item = [...packages.values()].find(item => item.record.asset.url === url); fs.writeFileSync(destination, item.archive); },
    extractArchive: async (archive, destination) => { const item = [...packages.values()].find(item => fs.readFileSync(archive).equals(item.archive));
      fs.writeFileSync(path.join(destination, "runtime-package.json"), JSON.stringify(item.wrapper));
      fs.cpSync(item.directory, path.join(destination, "files"), { recursive: true }); } } };
  const manager = createProjectBuildManager(options), userDataDir = path.join(root, "data");
  assert.equal(manager.getState({ userDataDir }).installed[0].source, "bundled");
  assert.equal(manager.getState({ userDataDir }).sections[0].installed[0].source, "bundled", "Ordinary runtime sections expose the included fallback");
  assert.deepEqual(manager.getState({ userDataDir }).sections[0].catalog.includedVersions, ["1.0"]);
  assert.equal(manager.getState({ userDataDir }).sections[0].catalog.installReason, null);
  assert.equal(manager.getState({ userDataDir }).sections[0].catalog.latestInstalledVersion, "1.0");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, "1.0"); assert.equal(fetches, 0); assert.equal(downloads, 0);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(fetches, 1); assert.equal(downloads, 0);
  assert.equal(manager.getState({ userDataDir }).catalog.recommendedVersion, "1.0", "Catalog refresh preserves the usable included default");
  assert.deepEqual(manager.getState({ userDataDir }).sections[0].catalog.installableVersions, ["2.0"], "A catalog copy of the included version needs no Install action");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, "1.0");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).ready, true);
  assert.equal(manager.resolveSelection(null, { runtimes: { [projectId]: { defaultVersion: "auto" } } }, userDataDir).version, "1.0");
  assert.equal(manager.resolveSelection({ runtimeData: { [runtimeId]: { version: "1.0" } } }, {}, userDataDir).version, "1.0");
  assert.equal(manager.resolveSelection({ runtimeData: { [runtimeId]: { version: "v1.0" } } }, {}, userDataDir).ready, true);
  let runtimeSettings = {};
  const installed = await runRuntimeManagerAction({ manager, action: "install", payload: { version: "2.0" }, userDataDir,
    readSettings: () => runtimeSettings, saveSettings: next => { runtimeSettings = next; } });
  assert.equal(installed.version, "2.0"); assert.equal(downloads, 1);
  assert.equal(runtimeSettings.defaultVersion, "2.0", "The ordinary explicit Install action saves the first installed version as default");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, "2.0", "Auto uses a newer compatible installed package before the included fallback");
  const gameManager = createProjectBuildManager({ ...options, supportsDefault: false });
  assert.equal(gameManager.resolveSelection(null, { runtimes: { [projectId]: { defaultVersion: "missing-old-pin" } } }, userDataDir).version, "2.0");
  assert.equal(gameManager.updateSettingsAfterInstall({}, installed), undefined, "Game installation does not persist a global selection");
  assert.equal(gameManager.getState({ userDataDir }).sections[0].supportsDefault, false);
  assert.equal(manager.getState({ userDataDir }).sections[0].catalog.latestInstalledVersion, "2.0", "The included fallback does not hide a newer installed build");
  const selected = manager.resolveSelection(null, { runtimes: { [projectId]: runtimeSettings } }, userDataDir);
  assert.equal(selected.ready, true); assert.equal(selected.install.root, path.join(installed.installDir, "payload"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed.installDir, "runtime.json"))).source, "download");
  assert.equal(JSON.parse(fs.readFileSync(path.join(selected.install.root, "runtime.json"))).version, "2.0", "Package manifest is separate from installation registration");
  const fourth = packageFor("4.0"); rows = [fourth];
  await manager.refreshCatalog({ userDataDir, force: true });
  const settings = { runtimes: { [projectId]: { defaultVersion: "2.0" } } };
  assert.equal(manager.resolveSelection(null, settings, userDataDir).version, "2.0", "Refresh never changes explicit installed selection");
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, "2.0"); assert.equal(downloads, 1);
  const reloaded = createProjectBuildManager(options);
  assert.equal(reloaded.resolveSelection(null, settings, userDataDir).ready, true, "Removed catalog entries remain usable through retained installation identity");
  assert.equal(fetches, 2, "Cold status and selection reuse only the local catalog");
  packages.get("4.0").wrapper.id = "other-runtime";
  await assert.rejects(manager.installRuntime({ userDataDir, version: "4.0" }), /different project/);
  packages.get("4.0").wrapper.id = projectId;
  fs.unlinkSync(path.join(packages.get("4.0").directory, "source.tar.gz"));
  await assert.rejects(manager.installRuntime({ userDataDir, version: "4.0" }), /inventory|ENOENT/);
  assert.equal(fs.existsSync(manager.core.getInstallDir({ userDataDir, version: "4.0" })), false, "Incomplete closures never publish");
  fs.appendFileSync(path.join(selected.install.root, "runtime.json"), " ");
  assert.equal(manager.resolveSelection(null, settings, userDataDir).ready, false, "Manifest tampering fails closed");
  assert.equal(gameManager.resolveSelection(null, settings, userDataDir).version, "1.0", "Auto skips an installed package whose real manifest changed");
  rows = [{ ...fourth, id: "other-project" }];
  await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }), /invalid package/);
  assert.equal(manager.getState({ userDataDir }).catalog.status, "error");
  assert.equal(manager.resolveSelection({ runtimeData: { [runtimeId]: { version: "1.0" } } }, {}, userDataDir).ready, true);
  const oldHash = packageFor("0.1.0-eb7b9a58-ml1"), newHash = packageFor("0.1.0-93400928-ml4");
  rows = [oldHash];
  await manager.refreshCatalog({ userDataDir, force: true });
  const upgradedOptions = { ...options, included: () => ({ root: packages.get(newHash.version).directory, record: newHash }) };
  const upgraded = createProjectBuildManager(upgradedOptions);
  assert.equal(upgraded.getState({ userDataDir }).catalog.recommendedVersion, newHash.version, "A stale catalog does not displace a newly included hash version");
  assert.equal(upgraded.resolveSelection(null, {}, userDataDir).version, newHash.version, "A damaged higher installed release does not displace the healthy included build");
  assert.equal(upgraded.resolveSelection(null, {}, userDataDir).ready, true);
  assert.deepEqual(upgraded.getState({ userDataDir }).catalog.installableVersions, [oldHash.version], "Older catalog packages remain manually installable");
  assert.equal(upgraded.resolveSelection(null, {}, userDataDir, { version: oldHash.version }).version, oldHash.version);
  assert.equal(upgraded.resolveSelection(null, {}, userDataDir, { version: oldHash.version }).ready, false, "Explicit missing choices stay exact");
  const retainedOptions = { ...upgradedOptions, retainedIncluded: () => [{ root: packages.get(oldHash.version).directory, record: oldHash }] };
  const retainedManager = createProjectBuildManager(retainedOptions), offlineData = path.join(root, "retained-offline"), requestsBefore = [fetches, downloads];
  const retainedState = retainedManager.getState({ userDataDir: offlineData });
  assert.deepEqual(retainedState.catalog.includedVersions, [newHash.version, oldHash.version]);
  assert.equal(retainedState.catalog.recommendedVersion, newHash.version, "Retaining an older included package preserves the new recommendation");
  assert.equal(retainedManager.resolveSelection(null, {}, offlineData).version, newHash.version, "Automatic selection still uses the primary included package");
  for (const selected of [
    retainedManager.resolveSelection(null, {}, offlineData, { version: oldHash.version }),
    retainedManager.resolveSelection({ runtimeData: { [runtimeId]: { version: oldHash.version } } }, {}, offlineData),
    retainedManager.resolveSelection(null, { runtimes: { [projectId]: { defaultVersion: oldHash.version } } }, offlineData)
  ]) {
    assert.equal(selected.ready, true, "A retained explicit selection works without Refresh or a local catalog");
    assert.equal(selected.install.runtimePath, path.join(packages.get(oldHash.version).directory, "native"));
    assert.equal(Bundled.verifyPayload(selected.install.root, selected.install.declaration), true, "The retained fixture is a complete real Mach-O payload");
  }
  const primaryIncluded = retainedManager.resolveSelection(null, {}, offlineData).install;
  assert.equal(Bundled.verifyPayload(primaryIncluded.root, primaryIncluded.declaration), true, "The new fixture is also a complete real Mach-O payload");
  assert.equal((await retainedManager.installRuntime({ userDataDir: offlineData, version: oldHash.version })).source, "bundled", "An already included choice requires no download");
  assert.deepEqual([fetches, downloads], requestsBefore, "Status, selection and using retained packages stay offline");
  for (const version of [newHash.version, oldHash.version]) {
    assert.equal(retainedState.installed.find(row => row.version === version).removable, false);
    assert.equal(retainedState.catalog.versionRequirements[version].requiresDownload, false);
    await assert.rejects(retainedManager.uninstallRuntime({ userDataDir: offlineData, version }), /included/i);
    assert.equal(fs.existsSync(packages.get(version).directory), true);
  }
  const oldManifest = path.join(packages.get(oldHash.version).directory, "runtime.json"), oldBytes = fs.readFileSync(oldManifest);
  fs.writeFileSync(oldManifest, "not a trusted manifest");
  const damaged = retainedManager.resolveSelection(null, {}, offlineData, { version: oldHash.version });
  assert.equal(damaged.version, oldHash.version); assert.equal(damaged.ready, false);
  assert.match(damaged.reason, /manifest changed/, "Trusted manifest SHA is checked before parsing retained metadata");
  assert.equal(retainedManager.getState({ userDataDir: offlineData }).installed.find(row => row.version === oldHash.version).status, "damaged-bundled");
  assert.equal(retainedManager.resolveSelection(null, {}, offlineData).version, newHash.version, "A damaged retained package does not displace the primary default");
  fs.unlinkSync(oldManifest);
  const unavailable = retainedManager.resolveSelection(null, {}, offlineData, { version: oldHash.version });
  assert.equal(unavailable.version, oldHash.version);
  assert.equal(unavailable.ready, false); assert.equal(unavailable.install, null); assert.match(unavailable.reason, /not installed/);
  assert.equal(retainedManager.getState({ userDataDir: offlineData }).installed.some(row => row.version === oldHash.version), false);
  assert.equal(retainedManager.getState({ userDataDir: offlineData }).catalog.includedVersions.includes(oldHash.version), false);
  assert.equal(retainedManager.getState({ userDataDir: offlineData }).catalog.recommendedVersion, newHash.version, "An unavailable retained manifest does not break healthy primary status");
  fs.writeFileSync(oldManifest, oldBytes);
  for (const name of ['native', 'source.tar.gz']) {
    const file = path.join(packages.get(oldHash.version).directory, name), missing = file + '.missing';
    fs.renameSync(file, missing);
    const selected = retainedManager.resolveSelection(null, {}, offlineData, { version: oldHash.version });
    assert.equal(selected.version, oldHash.version); assert.equal(selected.ready, false); assert.equal(selected.install, null);
    assert.equal(retainedManager.getState({ userDataDir: offlineData }).installed.some(row => row.version === oldHash.version), false,
      'A manifest alone does not make a missing executable or source package installed');
    fs.renameSync(missing, file);
  }
  assert.equal(upgraded.resolveSelection(null, settings, userDataDir).version, "2.0", "App upgrades preserve a saved global choice");
  assert.equal(upgraded.resolveSelection({ runtimeData: { [runtimeId]: { version: "2.0" } } }, {}, userDataDir).version, "2.0", "App upgrades preserve a saved game choice");
  await runRuntimeManagerAction({ manager: upgraded, action: "install", payload: { version: oldHash.version }, userDataDir,
    readSettings: () => runtimeSettings, saveSettings: next => { runtimeSettings = next; } });
  assert.equal(runtimeSettings.defaultVersion, "2.0", "Installing another version preserves an existing explicit default");
  await runRuntimeManagerAction({ manager: upgraded, action: "setDefault", payload: { version: oldHash.version }, userDataDir,
    readSettings: () => runtimeSettings, saveSettings: next => { runtimeSettings = next; } });
  const restarted = createProjectBuildManager(upgradedOptions);
  assert.equal(restarted.resolveSelection(null, { runtimes: { [projectId]: runtimeSettings } }, userDataDir).version, oldHash.version, "Set default remains exact after restart");
  assert.equal(restarted.resolveSelection(null, { runtimes: { [projectId]: runtimeSettings } }, userDataDir).ready, true);
  const gameSelection = { runtimeData: { [runtimeId]: { version: "2.0" } } }, globalSelection = { runtimes: { [projectId]: runtimeSettings } };
  assert.equal(restarted.resolveSelection(gameSelection, globalSelection, userDataDir).version, "2.0", "A game choice takes precedence over the global default");
  assert.equal(restarted.resolveSelection(gameSelection, globalSelection, userDataDir, { version: newHash.version }).version, newHash.version, "An explicit action version takes precedence over game and global choices");
  const emptyData = path.join(root, 'first-play'), beforeFirstPlay = [fetches, downloads], empty = createProjectBuildManager({ ...options,
    included: () => ({root:path.join(root,'absent-included'),record:first}) });
  assert.equal(empty.resolveSelection(null, {}, emptyData).version, null);
  assert.deepEqual(empty.getState({userDataDir:emptyData}).installed, []);
  let consent = 0, result;
  const beforeRows = rows; rows = [second, first];
  await prepareForLaunch({entry:{},mod:{ensureRuntime:()=>({managerId:projectId,version:null})},info:{runtime:{}},
    context:{runtimeId,userDataDir:emptyData,settings:{},confirmRuntimeInstall:async()=>{consent++;assert.deepEqual([fetches,downloads],beforeFirstPlay);return true;}},
    registry:{listModules:()=>[],listSharedRuntimeManagers:()=>[empty]},
    install:async(manager, payload)=>{result=await manager.installRuntime({...payload,userDataDir:emptyData});},runAction:()=>assert.fail('Unexpected action')});
  assert.equal(consent,1);assert.equal(result.version,'2.0');assert.equal(result.source,'download');
  assert.equal(empty.getState({userDataDir:emptyData}).catalog.installReason,null,'Absent development metadata does not warn to reinstall an old included version');
  assert.deepEqual([fetches,downloads],[beforeFirstPlay[0]+1,beforeFirstPlay[1]+1], 'First Play refreshes and installs only after consent');
  const beforeMissing = [fetches,downloads];
  await assert.rejects(empty.installRuntime({userDataDir:emptyData,version:'missing-7.0'}), /missing-7\.0.*not available/);
  assert.deepEqual([fetches,downloads],[beforeMissing[0]+1,beforeMissing[1]], 'An unavailable exact pin refreshes its own catalog without installing another version');
  assert.equal(empty.resolveSelection(null,{},emptyData,{version:'missing-7.0'}).version,'missing-7.0');
  rows = beforeRows;
  const incompatible = createProjectBuildManager({ ...options, included: () => ({ root: packages.get(unsupported.version).directory, record: unsupported }) });
  assert.equal(incompatible.resolveSelection(null, {}, userDataDir).version, oldHash.version, "An incompatible included package does not hide a compatible catalog package");
  assert.equal(incompatible.getState({ userDataDir }).catalog.recommendedVersion, oldHash.version);
  assert.equal(await manager.uninstallRuntime({ userDataDir, version: "2.0" }), true);
  assert.equal(fs.existsSync(packages.get("1.0").directory), true);
  await assert.rejects(manager.uninstallRuntime({ userDataDir, version: "1.0" }), /included/i);
  fs.appendFileSync(path.join(packages.get("1.0").directory, "runtime.json"), " ");
  assert.equal(manager.getState({ userDataDir }).installed[0].status, "damaged-bundled");
  assert.equal(manager.resolveSelection(null, { runtimes: { [projectId]: { defaultVersion: "1.0" } } }, userDataDir).ready, false);
});

test('optional project builds remain offline and unavailable until an explicit catalog refresh', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-optional-project-'));
  t.after(() => fs.rmSync(userDataDir, {recursive:true, force:true}));
  let fetches = 0, catalog = null;
  const manager = createProjectBuildManager({projectId:'optional-runtime', label:'Optional runtime', repository:'ExampleOwner/runtime-builds',
    manifestRelative:'runtime.json', sourceRelative:'source.tar.gz', executableRelative:'native', included:() => null,
    validateManifest:() => {}, verifyPayload:() => assert.fail('An unavailable package cannot be verified'),
    dependencies:{systemVersionSync:() => '26.0', fetchUrlBuffer:async () => {fetches++; return catalog
      ? {status:200, body:Buffer.from(JSON.stringify(catalog))} : {status:404, body:Buffer.alloc(0)};}}});
  const state = manager.getState({userDataDir});
  assert.deepEqual(state.installed, []);
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.equal(state.catalog.recommendedVersion, null);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, false);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, null);
  assert.equal(fetches, 0, 'Settings, launch planning and missing installation do not query the network');
  await assert.rejects(manager.refreshCatalog({userDataDir, force:true}), /catalog could not be downloaded/);
  assert.equal(fetches, 1, 'Only explicit Refresh queries the catalog');
  assert.equal(manager.getState({userDataDir}).catalog.status, 'error');
  assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
  function packageFor(version, minimumMacOS) {
    const tag = `optional-runtime/v${version}/${process.arch}`, filename = `optional-runtime-${version}-${process.arch}.tar.gz`;
    return {schemaVersion:2, id:'optional-runtime', version, arch:process.arch, launcherArchitectures:[process.arch], minimumMacOS,
      manifestRelative:'runtime.json', manifestSha256:'a'.repeat(64), sourceSha256:'b'.repeat(64), updatePolicy:'manual', tag,
      asset:{filename, bytes:1, sha256:'c'.repeat(64), url:`https://github.com/ExampleOwner/runtime-builds/releases/download/${encodeURIComponent(tag)}/${filename}`}};
  }
  catalog = {schemaVersion:2, projectId:'optional-runtime', updatePolicy:'manual', packages:[packageFor('2.0', '99.0'), packageFor('1.0', '13.0')]};
  await manager.refreshCatalog({userDataDir, force:true});
  assert.equal(fetches, 2);
  assert.equal(manager.getState({userDataDir}).catalog.recommendedVersion, '1.0', 'Download-only projects recommend the first compatible catalog package');
  assert.deepEqual(manager.getState({userDataDir}).catalog.installableVersions, ['1.0']);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, '1.0');
  assert.equal(manager.resolveSelection({}, {}, userDataDir).ready, false);
  assert.equal(fetches, 2, 'Reading a download-only catalog stays offline');
});
