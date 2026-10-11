const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Managed = require("../src/modules/shared/runtime/steamworks/managed-consumer");
const Automatic = require("../src/modules/shared/runtime/steamworks/automatic");
const Environment = require("../src/modules/shared/runtime/steamworks/environment");
const { managedAssembly } = require("./helpers/fna-assembly");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const imports = ["SteamAPI_Init", "SteamAPI_Shutdown", "SteamAPI_DormantOnlineCall"]
  .map(name => ({ library: "steam_api", name }));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "managed-steam-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = managedAssembly({ name: "PortableWrapper", entryPoint: false, references: [], nativeImports: imports, ...options });
  const assemblyPath = path.join(root, "PortableWrapper.dll"); fs.writeFileSync(assemblyPath, bytes);
  const profile = { managedConsumer: { schemaVersion: 1, assemblySha256: hash(bytes), assemblyBytes: bytes.length,
    assemblyName: "PortableWrapper", assemblyVersion: "1.2.3.4", nativeImportsSha256: Managed.importIdentity(imports),
    requiredSymbols: ["SteamAPI_Init", "SteamAPI_Shutdown"] } };
  return { root, bytes, assemblyPath, profile, sources: [{ assemblyPath }], symbols: imports.map(item => item.name) };
}

test("exact managed assembly profile checks only its used APIs and preserves other requirements", async t => {
  const value = fixture(t), before = fs.readFileSync(value.assemblyPath);
  const prepared = await Managed.resolveManagedRequirement({ ...value,
    symbols: [...value.symbols, "SteamAPI_UnrecognizedOtherConsumer"] });
  assert.deepEqual(prepared.symbols, ["SteamAPI_Init", "SteamAPI_Shutdown", "SteamAPI_UnrecognizedOtherConsumer"]);
  assert.deepEqual(prepared.consumers, [{ assemblySha256: hash(value.bytes), assemblyBytes: value.bytes.length,
    assemblyName: "PortableWrapper", assemblyVersion: "1.2.3.4", declaredSymbolCount: 3, requiredSymbolCount: 2 }]);
  assert.deepEqual(fs.readFileSync(value.assemblyPath), before);
  assert.deepEqual(value.symbols, imports.map(item => item.name));
});

test("unknown profiles retain all native requirements and cannot claim a managed exception", async t => {
  const value = fixture(t);
  assert.deepEqual(await Managed.resolveManagedRequirement({ symbols: value.symbols }), { symbols: value.symbols, consumers: [] });
  await assert.rejects(Managed.resolveManagedRequirement({ symbols: value.symbols, sources: value.sources }), { code: "STEAM_API_PROFILE_REQUIRED" });
  for (const sources of [undefined, [], [...value.sources, ...value.sources]]) {
    await assert.rejects(Managed.resolveManagedRequirement({ ...value, sources }), { code: "STEAM_API_CONSUMER_REQUIRED" });
  }
});

test("managed profile rejects changed bytes, identity and import metadata", async t => {
  const value = fixture(t);
  for (const patch of [{ assemblySha256: "1".repeat(64) }, { assemblyName: "OtherWrapper" },
    { assemblyVersion: "9.9.9.9" }, { nativeImportsSha256: "2".repeat(64) }, { assemblyBytes: value.bytes.length + 1 }]) {
    const profile = { managedConsumer: { ...value.profile.managedConsumer, ...patch } };
    await assert.rejects(Managed.resolveManagedRequirement({ ...value, profile }), { code: "STEAM_API_CONSUMER_CHANGED" });
  }
  const altered = Buffer.from(value.bytes); altered[altered.length - 1] ^= 1;
  fs.writeFileSync(value.assemblyPath, altered);
  await assert.rejects(Managed.resolveManagedRequirement(value), { code: "STEAM_API_CONSUMER_CHANGED" });
});

test("invalid or undeclared profile functions cannot loosen native checks", async t => {
  const value = fixture(t);
  for (const requiredSymbols of [[], ["SteamAPI_Init", "SteamAPI_Init"], ["bad-symbol!"], ["SteamAPI_NotDeclared"]]) {
    const profile = { managedConsumer: { ...value.profile.managedConsumer, requiredSymbols } };
    await assert.rejects(Managed.resolveManagedRequirement({ ...value, profile }), { code: "STEAM_API_PROFILE_CHANGED" });
  }
  assert.throws(() => Managed.validateConsumerProfile({ ...value.profile.managedConsumer, assemblyBytes: Managed.MAX_BYTES + 1 }), { code: "STEAM_API_PROFILE_CHANGED" });
});

test("embedded managed assembly proof reads only its exact byte range without extraction", async t => {
  const value = fixture(t), parent = path.join(value.root, "Container.exe"), offset = 3072;
  fs.writeFileSync(parent, Buffer.concat([Buffer.alloc(offset, 0x51), value.bytes, Buffer.alloc(2048, 0x52)]));
  const before = hash(fs.readFileSync(parent));
  const prepared = await Managed.resolveManagedRequirement({ ...value,
    sources: [{ assemblyPath: parent, range: { offset, size: value.bytes.length } }] });
  assert.deepEqual(prepared.symbols, ["SteamAPI_Init", "SteamAPI_Shutdown"]);
  assert.equal(hash(fs.readFileSync(parent)), before);
  assert.deepEqual(fs.readdirSync(value.root).sort(), ["Container.exe", "PortableWrapper.dll"]);
  for (const range of [{ offset: -1, size: value.bytes.length }, { offset, size: value.bytes.length - 1 },
    { offset: Number.MAX_SAFE_INTEGER, size: value.bytes.length }, { offset: 1.5, size: value.bytes.length }]) {
    await assert.rejects(Managed.resolveManagedRequirement({ ...value, sources: [{ assemblyPath: parent, range }] }),
      error => ["STEAM_API_CONSUMER_INVALID", "STEAM_API_CONSUMER_CHANGED"].includes(error.code));
  }
});

test("managed profile preserves CLR bitness and rejects symlinks or cancelled reads", async t => {
  const value = fixture(t, { flags: 3 });
  await assert.rejects(Managed.resolveManagedRequirement(value), { code: "STEAM_API_CONSUMER_CHANGED" });
  await assert.rejects(Managed.resolveManagedRequirement({ ...value, sources: [{ assemblyPath: "PortableWrapper.dll" }] }), { code: "STEAM_API_CONSUMER_INVALID" });
  const link = path.join(value.root, "Linked.dll"); fs.symlinkSync(value.assemblyPath, link);
  await assert.rejects(Managed.resolveManagedRequirement({ ...value, sources: [{ assemblyPath: link }] }), { code: "ELOOP" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Managed.resolveManagedRequirement({ ...value, signal: controller.signal }), { name: "AbortError" });
});

test("measured game-search versions use the ordinary shared configuration grammar", () => {
  assert.equal(Environment.INTERFACE.test("SteamMatchGameSearch001"), true);
  assert.equal(Environment.INTERFACE.test("SteamMatchGameSearch1"), false);
  assert.equal(Environment.INTERFACE.test("SteamMatchGameSearch001/path"), false);
  const files = Environment.configurationFiles({ appId: 480, interfaces: ["SteamClient021", "SteamMatchGameSearch001"] });
  assert.equal(files["steam_interfaces.txt"], "SteamClient021\nSteamMatchGameSearch001\n");
});

test("automatic shared launch validates the assembly before selecting lazy native requirements", async t => {
  const value = fixture(t), userDataDir = path.join(value.root, "launcher"), libraryPath = path.join(value.root, "api.dylib");
  fs.writeFileSync(libraryPath, "fixture native bytes");
  const sourceSha256 = "a".repeat(64), sha256 = hash(fs.readFileSync(libraryPath));
  const pin = { version: "owned-test-1", sourceKind: "owned", sourceSha256, sourceRevision: null,
    librarySha256: sha256, architectures: ["arm64"], qualifiedInterfaces: ["SteamClient021"] };
  const profile = { schemaVersion: 1, id: "managed-test-1", helperVersion: pin.version,
    helperSourceKind: "owned", helperSourceSha256: sourceSha256, helperSourceRevision: null,
    helperLibrarySha256: sha256, interfaces: pin.qualifiedInterfaces, architectures: ["arm64"],
    managedConsumer: value.profile.managedConsumer };
  const request = { required: true, arch: "arm64", appId: 480, abiProfile: profile.id,
    symbols: value.symbols, managedConsumers: value.sources, aliases: ["steam_api"], preferOffline: true,
    ownedDirectory: path.join(userDataDir, "games", "one", "modules", "steam-api") };
  const dependency = { catalog: [pin], profiles: [profile],
    resolveBundledLibrary: () => ({ ready: true, version: pin.version, mode: "offline", libraryPath, sha256,
      sourceKind: "owned", sourceSha256, sourceRevision: null, architectures: ["arm64"] }),
    inspectMachOExports: async () => ["SteamAPI_Init", "SteamAPI_Shutdown"] };
  const context = { userDataDir, baseEnvironment: { PATH: "/usr/bin:/bin" } };
  const prepared = await Automatic.prepareAutomaticLaunch(request, context, dependency);
  assert.equal(prepared.mode, "offline"); assert.equal(prepared.abiProfile, profile.id);
  assert.equal(prepared.managedConsumers[0].declaredSymbolCount, 3);
  const warm = await Automatic.prepareAutomaticLaunch(request, context, dependency);
  assert.equal(warm.aliasDirectory, prepared.aliasDirectory);
  await assert.rejects(Automatic.prepareAutomaticLaunch({ ...request, symbols: [...request.symbols, "SteamAPI_UnrecognizedOtherConsumer"] }, context, dependency),
    error => error.code === "STEAM_API_SYMBOLS_UNAVAILABLE" && error.missingSymbols.includes("SteamAPI_UnrecognizedOtherConsumer"));
  await assert.rejects(Automatic.prepareAutomaticLaunch({ ...request, managedConsumers: undefined }, context, dependency), { code: "STEAM_API_CONSUMER_REQUIRED" });
  const bad = { ...profile, managedConsumer: { ...profile.managedConsumer, assemblySha256: "b".repeat(64) } };
  await assert.rejects(Automatic.prepareAutomaticLaunch(request, context, { ...dependency, profiles: [bad] }), { code: "STEAM_API_CONSUMER_CHANGED" });
});
