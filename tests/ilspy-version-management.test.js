const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const Catalog = require("../src/modules/shared/runtime/ilspy-catalog");
const Manager = require("../src/modules/shared/runtime/ilspy-manager");
// Exercise the module's gate directly; shared service instrumentation also has
// an installed-tool shortcut, with host preparation deferred to Decompile.
const installIlSpy = Manager.installRuntime;
const Tool = require("../src/modules/shared/runtime/managed-decompiler");
const FnaTool = require("../src/modules/fna/decompiler");
const Native = require("../src/modules/shared/runtime/local-native");
const Bundled = require("../src/modules/shared/runtime/bundled-native");
const Host = require("../src/modules/shared/runtime/dotnet-tool-host");
const FnaManager = require("../src/modules/fna/runtime/manager");
const FnaBuild = require("../src/modules/fna/runtime/build");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { managedAssembly, writeAssembly } = require("./helpers/fna-assembly");
const { writeZipArchive } = require("./helpers/zip-fixture");

const json = data => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) });
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-ilspy-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function metadata(version, framework = "net10.0") {
  const prefix = "tools/" + framework + "/any/";
  return { id: "ilspycmd", version, packageHashAlgorithm: "SHA512", packageHash: Buffer.alloc(64, 1).toString("base64"),
    packageSize: 1024, repository: { type: "git", url: "https://github.com/icsharpcode/ILSpy", commit: Catalog.PINS["11.1.0.9782"].sourceRevision },
    packageEntries: ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"].map(name => ({ fullName: prefix + name })) };
}
function pin(version, framework = "net10.0") {
  return Catalog.metadataEntry(metadata(version, framework), version, "https://api.nuget.org/v3/catalog0/data/1/ilspycmd." + version + ".json");
}
function cachedTool(userDataDir, selected = Catalog.PINS[Tool.DEFAULT_VERSION]) {
  const root = Tool.installRoot(userDataDir, selected.version), files = path.join(root, "files"); fs.mkdirSync(files, { recursive: true });
  for (const name of ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"])
    fs.writeFileSync(path.join(files, name), "tool fixture " + name);
  fs.writeFileSync(path.join(root, "tool.json"), JSON.stringify({ version: selected.version, framework: selected.framework,
    sourceRevision: selected.sourceRevision, archiveSha256: selected.sha256, archiveSha512: selected.sha512,
    minimumRuntime: selected.minimumRuntime, catalogEntry: selected, files: Tool.__test.inventory(files) }));
  return { root, files };
}
function includedFna(t) {
  const root = directory(t), resources = path.join(root, "resources"), directoryPath = path.join(resources, "fna", "arm64");
  const payload = path.join(directoryPath, "files", "fna"); fs.mkdirSync(payload, { recursive: true });
  for (const name of FnaBuild.__test.REQUIRED_FILES) {
    const file = path.join(payload, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "sealed " + name);
  }
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, "dotnet"), executable, { mode: 0o755 }); fs.writeFileSync(path.join(payload, "LICENSE.txt"), "fixture notice");
  fs.writeFileSync(path.join(payload, "fna-runtime.json"), JSON.stringify({ profile: FnaBuild.PROFILE,
    upstreamRevision: FnaBuild.FNA_REVISION, frameworkVersion: "26.10.0.0", dotnetVersion: FnaBuild.DOTNET_VERSION,
    architecture: "arm64", files: Object.fromEntries(FnaBuild.__test.REQUIRED_FILES.map(name => [name, "b".repeat(64)])) }));
  const files = Bundled.fileInventory(path.join(directoryPath, "files")).map(relative => {
    const file = path.join(directoryPath, "files", relative), stat = fs.statSync(file);
    return { path: relative, size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777,
      ...(relative === "fna/dotnet" ? { architectures: ["arm64"] } : {}) };
  });
  fs.writeFileSync(path.join(directoryPath, "manifest.json"), JSON.stringify({ schemaVersion: 1, managerId: "fna",
    version: FnaBuild.PROFILE, upstreamRevision: FnaBuild.FNA_REVISION, platform: "darwin", arch: "arm64", minimumMacOS: "13.0",
    executableRelative: "fna/dotnet", files, dependencies: [], notices: [{ name: "Fixture notice", license: "Test",
      sourceUrl: "https://example.com", path: "fna/LICENSE.txt" }], provenance: { sourceRevision: FnaBuild.FNA_REVISION } }));
  const manager = FnaManager.createManager({ dependencies: { bundle: { resourceRoot: resources, platform: "darwin", arch: "arm64",
    dependencies: { systemVersionSync: () => "13.0", verifySignaturesSync: () => {} } } } });
  t.mock.method(Bundled, "systemVersionSync", () => "13.0");
  t.mock.method(FnaManager, "getState", options => manager.getState(options));
  t.mock.method(FnaManager, "resolveSelection", (...args) => manager.resolveSelection(...args));
  return { root, payload, directoryPath, userDataDir: path.join(root, "userData") };
}

test("NuGet content metadata supplies the actual framework, digest and Git revision", () => {
  const row = pin("12.0.0.9000", "net8.0");
  assert.equal(row.framework, "net8.0"); assert.equal(row.sha512.length, 128);
  assert.equal(row.sourceRevision, Catalog.PINS["11.1.0.9782"].sourceRevision);
  const noRepository = metadata("12.0.0.9001"); delete noRepository.repository;
  const without = Catalog.metadataEntry(noRepository, noRepository.version, "https://api.nuget.org/v3/catalog0/data/1/ilspycmd.json");
  assert.equal(without.sourceRevision, null); assert.equal(without.upstreamRevision, "nuget:ilspycmd@12.0.0.9001");
  assert.throws(() => Catalog.metadataEntry({ ...metadata("11.1.0.9782"), packageHash: "bad" }, "11.1.0.9782",
    "https://api.nuget.org/v3/catalog0/data/1/ilspycmd.json"), /incomplete|digest/);
  assert.throws(() => Catalog.trustedUrl("https://other.test/v3/catalog0/data/1.json", "/v3/catalog0/data/"), /source/);
});
test("an unsupported older package layout stays visible with an explicit reason", () => {
  const old = metadata("7.0.0.1000"); old.packageEntries = [];
  const row = Catalog.metadataEntry(old, old.version, "https://api.nuget.org/v3/catalog0/data/1/ilspycmd.json");
  assert.equal(row.framework, null); assert.match(row.installReason, /layout/); assert.equal(Catalog.validEntry(row), true);
});
test("the registry exposes one shared ILSpy manager in Tools without changing fixed FNA", () => {
  const Registry = require("../src/modules/registry");
  const managers = Registry.listSharedRuntimeManagers().filter(manager => manager.id === "ilspy");
  assert.equal(managers.length, 1);
  assert.equal(Registry.getRuntimeManagerUi("ilspy").management, "managed");
  assert.equal(Registry.getRuntimeManagerUi("ilspy").groupId, "tools");
  assert.equal(Registry.getRuntimeManagerUi("ilspy").tabLabel, "Tools");
  assert.equal(managers[0].getState({}).sections[0].id, "decompiler");
  assert.equal(Registry.getRuntimeManagerUi("fna").management, "built-in");
});
test("full NuGet discovery deduplicates listed versions and bounds parallel metadata work", async () => {
  const versions = ["12.0.0.9000", "11.1.0.9782", "10.1.1.8388", "10.0.0.8282", "9.1.0.7988", "9.0.0.7889"];
  const base = "https://api.nuget.org/v3/registration5-gz-semver2/", paths = new Map();
  const leaves = versions.map(version => {
    const url = "https://api.nuget.org/v3/catalog0/data/1/ilspycmd." + version + ".json"; paths.set(url, metadata(version));
    return { packageContent: Catalog.packageUrl(version), catalogEntry: { "@id": url, id: "ilspycmd", version, listed: true } };
  });
  let active = 0, maximum = 0, packages = 0;
  const rows = await Catalog.discover({ request: async url => {
    if (url.endsWith(".nupkg")) packages++;
    if (url === "https://api.nuget.org/v3/index.json") return json({ resources: [{ "@type": "RegistrationsBaseUrl/3.6.0", "@id": base }] });
    if (url === base + "ilspycmd/index.json") return json({ items: [{ items: [...leaves, leaves[0], { catalogEntry: { id: "ilspycmd", version: "1.0.0.0", listed: false } }] }] });
    assert.ok(paths.has(url)); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return { status: 200, headers: { "content-encoding": "gzip" }, body: zlib.gzipSync(Buffer.from(JSON.stringify(paths.get(url)))) };
  } });
  assert.deepEqual(rows.map(row => row.version), versions); assert.equal(maximum, 4); assert.equal(packages, 0);
});
test("NuGet refresh rejects an unexpected artifact source and cancels bounded discovery", async () => {
  const base = "https://api.nuget.org/v3/registration5-gz-semver2/";
  const request = async url => json(url.endsWith("/v3/index.json")
    ? { resources: [{ "@type": "RegistrationsBaseUrl/3.6.0", "@id": base }] }
    : { items: [{ items: [{ packageContent: "https://other.test/tool.nupkg", catalogEntry: {
      "@id": "https://api.nuget.org/v3/catalog0/data/1/ilspycmd.json", id: "ilspycmd", version: "11.1.0.9782" } }] }] });
  await assert.rejects(Catalog.discover({ request }), /package URL/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(Catalog.discover({ request, signal: abort.signal }), { code: "ABORT_ERR" });
});
test("ILSpy starts offline without factory release rows and refresh replaces obsolete results", async t => {
  const userDataDir = directory(t);
  t.mock.method(Catalog, "discover", () => assert.fail("State inspection cannot use the network"));
  const initial = Manager.getState({ userDataDir });
  assert.equal(initial.defaultVersion, Tool.DEFAULT_VERSION);
  assert.equal(initial.catalog.supportsLatestOnly, false);
  assert.deepEqual(initial.catalog.versions, []);
  assert.equal(initial.catalog.status, "idle");
  assert.equal(initial.catalog.recommendedVersion, null);
  await Manager.refreshCatalog({ userDataDir, force: true }, { discover: async () => [pin("12.0.0.9000"), pin("10.0.0.8000", "net6.0")] });
  assert.ok(Manager.getState({ userDataDir }).catalog.versions.includes("12.0.0.9000"));
  await Manager.refreshCatalog({ userDataDir, force: true }, { discover: async () => [pin("12.0.0.9001")] });
  const state = Manager.getState({ userDataDir });
  assert.equal(state.catalog.versions.includes("12.0.0.9000"), false);
  assert.deepEqual(state.catalog.versions, ["12.0.0.9001"]);
  assert.equal(Catalog.pinFor(Tool.DEFAULT_VERSION, userDataDir).sha256, Catalog.PINS[Tool.DEFAULT_VERSION].sha256);
  assert.equal(Catalog.cachedCatalog(userDataDir).entries.length, 1);
  assert.equal(Manager.updateSettingsAfterInstall({}, { version: "12.0.0.9001" }).defaultVersion, Tool.DEFAULT_VERSION);
});
test("retired installed tools retain exact identities after refresh and cache reload", async t => {
  const userDataDir = directory(t), selected = pin("12.0.0.9000"); Catalog.saveCatalog(userDataDir, [selected]); cachedTool(userDataDir, selected);
  await Manager.refreshCatalog({ userDataDir, force: true }, { discover: async () => [pin("12.0.0.9001")] });
  assert.equal(Catalog.cachedCatalog(userDataDir).retainedEntries[0].version, selected.version);
  assert.equal(Catalog.pinFor(selected.version, userDataDir).sha512, selected.sha512);
  assert.equal(Manager.getState({ userDataDir }).installed[0].version, selected.version);
  fs.rmSync(path.join(userDataDir, "runtimes", "ilspy", "catalog.json"));
  assert.equal(Catalog.pinFor(selected.version, userDataDir).sha512, selected.sha512);
});
test("unchanged version display avoids payload hashes while execution invalidates changed files", t => {
  const userDataDir = directory(t), { files } = cachedTool(userDataDir), originalHash = Native.hashFile;
  Manager.getState({ userDataDir });
  const calls = t.mock.method(Native, "hashFile", originalHash);
  Manager.getState({ userDataDir }); assert.equal(calls.mock.callCount(), 0);
  assert.ok(Tool.resolveTool({ userDataDir })); const initial = calls.mock.callCount(); assert.ok(initial >= 4);
  assert.ok(Tool.resolveTool({ userDataDir })); assert.equal(calls.mock.callCount(), initial);
  fs.writeFileSync(path.join(files, "ICSharpCode.Decompiler.dll"), "changed");
  assert.equal(Tool.resolveTool({ userDataDir }), null);
});
test("ILSpy export uses the global version choice and keeps an explicit action override", async t => {
  const userDataDir = directory(t), assembly = path.join(userDataDir, "game.exe"); writeAssembly(assembly, {});
  let settings = {}, selectedTools = [], requiredFrameworks = [];
  await runRuntimeManagerAction({ manager: Manager, userDataDir, action: "setDefault", payload: { sectionId: "decompiler", version: "11.1.0.9782" },
    readSettings: () => settings.runtimes?.ilspy, saveSettings: next => { settings = { runtimes: { ilspy: next } }; } });
  const context = { userDataDir, settings }, entry = { gameId: "game", gamePath: assembly, moduleData: {} };
  const dependencies = {
    ensureTool: async (_context, version) => { selectedTools.push(version); return { ...Catalog.PINS[version], entryPath: path.join(userDataDir, "ilspy.dll") }; },
    ensureHost: async (_context, tool) => { requiredFrameworks.push(tool.framework); return { install: { executablePath: path.join(userDataDir, "dotnet") },
      profile: { root: userDataDir, dotnetVersion: tool.framework === "net10.0" ? "10.0.12" : "8.0.31" } }; },
    runCommand: async (_command, _args, options) => fs.writeFileSync(path.join(options.cwd, "Game.cs"), "source")
  };
  await FnaTool.decompile(entry, {}, context, dependencies);
  await FnaTool.decompile(entry, { version: Tool.DEFAULT_VERSION }, context, dependencies);
  assert.deepEqual(selectedTools, ["11.1.0.9782", Tool.DEFAULT_VERSION]); assert.deepEqual(requiredFrameworks, ["net10.0", "net8.0"]);
  assert.equal(settings.runtimes.ilspy.defaultVersion, "11.1.0.9782");
});
test("package extraction verifies the selected assembly version and actual runtime framework", t => {
  const root = directory(t), selected = Catalog.PINS["11.1.0.9782"], archive = path.join(root, "ilspy.nupkg");
  const entries = ["ilspycmd", "ICSharpCode.Decompiler"].map(name => ({ name: "tools/net10.0/any/" + name + ".dll",
    data: managedAssembly({ name, version: [11, 1, 0, 9782], framework: ".NETCoreApp,Version=v10.0" }) }));
  entries.push({ name: "tools/net10.0/any/ilspycmd.deps.json", data: "{}" },
    { name: "tools/net10.0/any/ilspycmd.runtimeconfig.json", data: JSON.stringify({ runtimeOptions: {
      tfm: "net10.0", framework: { name: "Microsoft.NETCore.App", version: "10.0.0" } } }) });
  writeZipArchive(archive, entries);
  const files = path.join(root, "files"); fs.mkdirSync(files);
  assert.deepEqual(Tool.__test.extractPackage(archive, files, selected), { framework: "net10.0", minimumRuntime: "10.0.0" });
  entries.at(-1).data = JSON.stringify({ runtimeOptions: { tfm: "net8.0", framework: { name: "Microsoft.NETCore.App", version: "8.0.0" } } });
  writeZipArchive(archive, entries);
  assert.throws(() => Tool.__test.extractPackage(archive, files, selected), /different .NET framework/);
});
test("unsupported framework versions fail before tool acquisition", async t => {
  const userDataDir = directory(t), row = pin("8.2.0.7000", "net6.0"); Catalog.saveCatalog(userDataDir, [row]);
  const state = Manager.getState({ userDataDir });
  assert.equal(state.catalog.versions.includes(row.version), true);
  assert.equal(state.catalog.installableVersions.includes(row.version), false);
  assert.match(state.catalog.versionRequirements[row.version].installReason, /unsupported/);
  await assert.rejects(Tool.ensureTool({ userDataDir }, row.version, { downloadToFile: () => assert.fail("Unsupported hosts cannot download") }), /unsupported .NET/);
});
test("macOS 13 uses the ready included CLR8 floor once per state and preserves strict installation", async t => {
  const { userDataDir } = includedFna(t);
  const rows = Array.from({ length: 12 }, (_, index) => pin("9.2.0." + (8000 + index), "net8.0"));
  Catalog.saveCatalog(userDataDir, [...rows, ...Object.values(Catalog.PINS)]);
  const resolveHost = Tool.resolveHost, lookups = t.mock.method(Tool, "resolveHost", (...args) => resolveHost(...args));
  const verifyRuntime = FnaBuild.verifyRuntime, verified = t.mock.method(FnaBuild, "verifyRuntime", (...args) => verifyRuntime(...args));
  const hostInstall = t.mock.method(Host, "ensure", () => assert.fail("An included CLR must not download another host"));
  const state = Manager.getState({ userDataDir });
  assert.equal(lookups.mock.callCount(), 1); assert.equal(lookups.mock.calls[0].arguments[2], "status");
  assert.equal(verified.mock.callCount(), 1);
  assert.equal(state.catalog.versionRequirements[Tool.DEFAULT_VERSION].minimumMacOS, "13.0");
  assert.equal(state.catalog.versionRequirements[Tool.DEFAULT_VERSION].installReason, null);
  assert.equal(state.catalog.installableVersions.includes(Tool.DEFAULT_VERSION), true);
  assert.equal(state.catalog.versionRequirements["11.1.0.9782"].minimumMacOS, "14.0");
  assert.equal(state.catalog.installableVersions.includes("11.1.0.9782"), false);
  const hashes = t.mock.method(Native, "hashFile", Native.hashFile);
  for (let index = 0; index < 10; index++) Manager.getState({ userDataDir });
  assert.equal(lookups.mock.callCount(), 11); assert.equal(verified.mock.callCount(), 1);
  assert.equal(hashes.mock.callCount(), 0, "unchanged status must not rehash the included host");
  const events = [], selectedPin = Catalog.PINS[Tool.DEFAULT_VERSION], hashFile = Native.hashFile;
  t.mock.method(Native, "hashFile", file => path.basename(file) === "ilspy.nupkg" ? selectedPin.sha256 : hashFile(file));
  const managed = { ...Manager, installRuntime: context => installIlSpy(context, { tool: {
    downloadToFile: async (_url, archive) => { events.push("download"); fs.writeFileSync(archive, "package fixture"); },
    extractPackage: (_archive, files) => {
      for (const name of ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"])
        fs.writeFileSync(path.join(files, name), "package fixture " + name);
    }
  } }) };
  const installed = await runRuntimeManagerAction({ manager: managed, action: "install", userDataDir,
    payload: { version: Tool.DEFAULT_VERSION, sectionId: "decompiler" },
    prerequisiteContext: { confirmRuntimeInstall: async plan => { events.push("consent"); assert.equal(plan.version, Tool.DEFAULT_VERSION); return true; } } });
  assert.deepEqual(events, ["consent", "download"]);
  assert.equal(installed.version, Tool.DEFAULT_VERSION); assert.equal(installed.ready, true);
  assert.equal(verified.mock.callCount(), 2, "execution preparation still verifies the actual host");
  assert.equal(hostInstall.mock.callCount(), 0);
  const acquireTool = t.mock.method(Tool, "ensureTool", () => assert.fail("An unavailable host must stop before acquisition"));
  await assert.rejects(installIlSpy({ userDataDir, version: "11.1.0.9782" }), /macOS 14/);
  assert.equal(acquireTool.mock.callCount(), 0);
});
test("macOS 13 rejects missing or damaged included CLR8 before tool acquisition", async t => {
  const { userDataDir, payload, directoryPath } = includedFna(t);
  Catalog.saveCatalog(userDataDir, Object.values(Catalog.PINS));
  assert.equal(Manager.getState({ userDataDir }).catalog.installableVersions.includes(Tool.DEFAULT_VERSION), true);
  const file = path.join(payload, "FNA.dll"), original = fs.readFileSync(file); original[0] ^= 1; fs.writeFileSync(file, original);
  const acquireTool = t.mock.method(Tool, "ensureTool", () => assert.fail("An unavailable host must stop before acquisition"));
  for (const missing of [false, true]) {
    if (missing) fs.rmSync(directoryPath, { recursive: true });
    const state = Manager.getState({ userDataDir }), requirement = state.catalog.versionRequirements[Tool.DEFAULT_VERSION];
    assert.equal(requirement.minimumMacOS, "14.0"); assert.match(requirement.installReason, /macOS 14/);
    assert.equal(state.catalog.installableVersions.includes(Tool.DEFAULT_VERSION), false);
    await assert.rejects(installIlSpy({ userDataDir, version: Tool.DEFAULT_VERSION }), /macOS 14/);
  }
  assert.equal(acquireTool.mock.callCount(), 0);
});
test("an installed tool's newer CLR minimum cannot reuse an older included host on macOS 13", async t => {
  const { userDataDir } = includedFna(t), selected = pin("9.2.0.8100", "net8.0"); Catalog.saveCatalog(userDataDir, [selected]);
  const { root } = cachedTool(userDataDir, selected), recordPath = path.join(root, "tool.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")); record.minimumRuntime = "8.0.32";
  fs.writeFileSync(recordPath, JSON.stringify(record));
  const state = Manager.getState({ userDataDir });
  assert.equal(state.catalog.versionRequirements[selected.version].minimumMacOS, "14.0");
  assert.equal(state.catalog.installableVersions.includes(selected.version), false);
  await assert.rejects(installIlSpy({ userDataDir, version: selected.version }), /macOS 14/);
});
