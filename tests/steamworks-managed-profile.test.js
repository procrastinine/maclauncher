const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Managed = require("../src/modules/shared/runtime/steamworks/managed-consumer");
const Selector = require("../src/modules/shared/runtime/steamworks/managed-profile");
const { managedAssembly } = require("./helpers/fna-assembly");

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "steam-managed-selector-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imported = ["SteamAPI_Init", "SteamAPI_Shutdown", "SteamAPI_DormantOnlineCall"].map(name => ({ library: "steam_api", name }));
  const bytes = managedAssembly({ name: "PortableWrapper", entryPoint: false, references: [], nativeImports: imported, ...options });
  const assemblyPath = path.join(root, "UnrelatedFileName.dll"); fs.writeFileSync(assemblyPath, bytes);
  const pin = { version: "independent-helper-1", sourceKind: "owned", sourceSha256: "a".repeat(64), sourceRevision: null,
    librarySha256: "b".repeat(64), qualifiedInterfaces: ["SteamClient021"], architectures: ["arm64", "x86_64"] };
  const profile = { schemaVersion: 1, id: "portable-managed-1", helperVersion: pin.version,
    helperSourceKind: pin.sourceKind, helperSourceSha256: pin.sourceSha256, helperSourceRevision: null,
    helperLibrarySha256: pin.librarySha256, interfaces: pin.qualifiedInterfaces, architectures: ["arm64"],
    managedConsumer: { schemaVersion: 1, assemblySha256: hash(bytes), assemblyBytes: bytes.length,
      assemblyName: "PortableWrapper", assemblyVersion: "1.2.3.4", nativeImportsSha256: Managed.importIdentity(imported),
      requiredSymbols: ["SteamAPI_Init", "SteamAPI_Shutdown"] } };
  const imports = imported.map(item => ({ ...item, assemblyPath, assemblyName: "PortableWrapper", resourceName: null }));
  return { root, assemblyPath, bytes, profile, pin, imports,
    options: { imports, architecture: "arm64", profiles: [profile], catalog: [pin] } };
}

test("managed producer selection verifies original bytes and CPU without depending on the DLL filename", async t => {
  const f = fixture(t), original = hash(fs.readFileSync(f.assemblyPath));
  const result = await Selector.selectManagedProfile(f.options);
  assert.deepEqual(result, { abiProfile: f.profile.id, version: f.pin.version, managedConsumers: [{ assemblyPath: f.assemblyPath }] });
  assert.equal(hash(fs.readFileSync(f.assemblyPath)), original);
  assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, architecture: "x86_64" }), {});
  assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, architecture: "unknown" }), {});
});

test("changed or unrecognized managed wrappers retain full native export requirements", async t => {
  const f = fixture(t), unknown = Buffer.from(f.bytes); unknown[unknown.length - 1] ^= 1;
  fs.writeFileSync(f.assemblyPath, unknown);
  assert.deepEqual(await Selector.selectManagedProfile(f.options), {});
  assert.deepEqual(f.imports.map(item => item.name), ["SteamAPI_Init", "SteamAPI_Shutdown", "SteamAPI_DormantOnlineCall"]);
  fs.writeFileSync(f.assemblyPath, f.bytes);
  const profile = { ...f.profile, managedConsumer: { ...f.profile.managedConsumer, nativeImportsSha256: "c".repeat(64) } };
  assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, profiles: [profile] }), {});
  const narrow = fixture(t, { flags: 3 });
  assert.deepEqual(await Selector.selectManagedProfile(narrow.options), {});
});

test("another assembly cannot inherit the known wrapper's dormant import exception", async t => {
  const f = fixture(t), external = path.join(f.root, "OtherWrapper.dll"); fs.writeFileSync(external, f.bytes);
  for (const extra of [{ ...f.imports[0], assemblyPath: external }, { ...f.imports[0], assemblyPath: undefined },
    { ...f.imports[0], resourceName: "AnotherWrapper.dll" }]) {
    assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, imports: [...f.imports, extra] }), {});
  }
  assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, imports: f.imports.map(item => ({ ...item, assemblyPath: "Wrapper.dll" })) }), {});
});

test("embedded managed selection needs an exact byte range and never extracts the assembly", async t => {
  const f = fixture(t), parent = path.join(f.root, "Game.exe"), offset = 1024;
  fs.writeFileSync(parent, Buffer.concat([Buffer.alloc(offset), f.bytes, Buffer.alloc(1024)]));
  const original = hash(fs.readFileSync(parent));
  const imports = f.imports.map(item => ({ ...item, assemblyPath: parent, resourceName: "Wrapper.dll" }));
  assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, imports }), {});
  const range = { offset, size: f.bytes.length };
  const result = await Selector.selectManagedProfile({ ...f.options, imports: imports.map(item => ({ ...item, range })) });
  assert.deepEqual(result.managedConsumers, [{ assemblyPath: parent, range }]);
  assert.equal(hash(fs.readFileSync(parent)), original);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["Game.exe", "UnrelatedFileName.dll"]);
});

test("managed selection preserves exact helper/source bindings and cancellation", async t => {
  const f = fixture(t);
  for (const patch of [{ helperVersion: "other" }, { helperSourceSha256: "c".repeat(64) }, { helperLibrarySha256: "c".repeat(64) }]) {
    await assert.rejects(Selector.selectManagedProfile({ ...f.options, profiles: [{ ...f.profile, ...patch }] }), { code: "STEAM_API_PROFILE_CHANGED" });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Selector.selectManagedProfile({ ...f.options, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await Selector.selectManagedProfile({ ...f.options, imports: [] }), {});
});
