const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const registry = require("../src/modules/registry");
const Service = require("../src/core/component-service");
const Components = require("../src/modules/shared/runtime/runtime-components");
const File = require("../src/modules/shared/runtime/pinned-file");

function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-components-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const offline = t => t.mock.method(globalThis, "fetch", () => assert.fail("Components read local files only"));

test("every declaration follows the contract and lists an empty profile offline", async t => {
  offline(t);
  const root = temporary(t), declared = registry.listComponents(), all = Service.declarations(registry);
  assert.ok(declared.length > 0);
  assert.equal(new Set(all.map(item => item.id)).size, all.length, "component ids are unique");
  for (const component of declared) {
    assert.equal(typeof component.owner, "string", component.id);
    assert.ok(registry.listModuleIds().includes(component.owner) || component.owner.startsWith("shared/"), component.id);
  }
  for (const component of all) {
    assert.match(component.id, /^[a-z0-9][a-z0-9:._-]*$/i, component.id);
    assert.equal(typeof component.label, "string"); assert.ok(component.label.trim(), component.id);
    assert.equal(typeof component.description, "string", `${component.id} describes what it is`);
    assert.equal(typeof component.list, "function");
    if (component.import) {
      assert.equal(typeof component.import.run, "function", component.id);
      assert.ok((component.import.kinds || ["file"]).every(kind => ["file", "directory"].includes(kind)), component.id);
    }
    assert.deepEqual(await component.list({ userDataDir: root, settings: {}, logger: console }) || [], [], `${component.id} on an empty profile`);
  }
  const service = Service.createComponentService({ userDataDir: root, registry, logger: { warn() {} } });
  const listed = await service.list();
  assert.deepEqual(listed.components.map(row => row.id), all.map(row => row.id));
  assert.ok(listed.components.every(row => row.error === null && Array.isArray(row.items) && row.items.length === 0));
});

// Runtimes hides these managers, so Components is their only management view.
test("every runtime manager without a Runtimes row is declared as a component", () => {
  const providerUi = require("../src/modules/shared/reshade/runtime/provider-library-ui.json");
  const managers = [...registry.listSharedRuntimeManagers(), ...registry.listModuleIds().flatMap(id => registry.getModule(id)?.runtimeManagers || [])];
  const hidden = [...new Set(managers.filter(manager => (providerUi[manager.id]?.hidden ?? manager.ui?.hidden) === true).map(manager => manager.id))];
  assert.ok(hidden.length > 0);
  const declared = new Set(Service.declarations(registry).map(component => component.managerId).filter(Boolean));
  assert.deepEqual(hidden.filter(id => !declared.has(id)), []);
});

function fakeRegistry(components) {
  return { listComponents: () => components.map(component => ({ owner: "fixture", ...component })) };
}

test("the service presents items, reveals them and refuses deletion of items still required", async t => {
  const root = temporary(t), store = path.join(root, "store");
  fs.mkdirSync(path.join(store, "one"), { recursive: true }); fs.writeFileSync(path.join(store, "one", "data"), Buffer.alloc(9000));
  const removed = [], host = [];
  const component = {
    id: "fixture-store", label: "Fixture store", description: "Fixture files.",
    list: () => [
      { id: "one", version: "1.0", identity: "SHA-256 " + "a".repeat(64), architecture: "x86_64", path: path.join(store, "one"),
        source: { url: "https://example.test/one.zip" }, users: ["Fixture runtime"] },
      { id: "two", version: "2.0", architecture: "arm64", path: path.join(store, "missing"), source: "manual",
        users: ["Fixture runtime"], removable: false, removeReason: "Installed runtimes load it." }],
    remove: item => { removed.push(item.id); }
  };
  const service = Service.createComponentService({ userDataDir: root, registry: fakeRegistry([component]),
    callHost: async (name, value) => { host.push([name, value]); return true; }, running: () => ({ game: {} }) });
  const { components, gameRunning } = await service.list();
  assert.equal(gameRunning, true);
  const [first, second] = components.find(row => row.id === "fixture-store").items;
  assert.equal(first.architecture, "x64"); assert.ok(first.bytes >= 9000); assert.equal(first.sizeComplete, true);
  assert.deepEqual(first.source, { url: "https://example.test/one.zip", label: null }); assert.equal(first.removable, true);
  assert.deepEqual(second.source, { manual: true, label: "Added manually" });
  assert.equal(second.removable, false); assert.equal(second.removeReason, "Installed runtimes load it.");
  await assert.rejects(service.remove({ componentId: "fixture-store", itemId: "two" }), /Installed runtimes load it/);
  assert.deepEqual(removed, []);
  assert.equal(await service.remove({ componentId: "fixture-store", itemId: "one" }), true);
  assert.deepEqual(removed, ["one"]);
  await assert.rejects(service.remove({ componentId: "fixture-store", itemId: "three" }), /no longer installed/);
  await service.reveal({ componentId: "fixture-store", itemId: "one" });
  assert.deepEqual(host, [["shell.showItemInFolder", path.join(store, "one")]]);
  await assert.rejects(service.reveal({ componentId: "fixture-store", itemId: "two" }), /no files on this Mac/);
  await assert.rejects(service.import({ componentId: "fixture-store" }), /cannot be added manually/);
});

test("owned removal refuses links and anything outside the component store", async t => {
  const root = temporary(t), store = path.join(root, "store"), outside = path.join(root, "outside");
  fs.mkdirSync(path.join(store, "kept"), { recursive: true }); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(store, "link"));
  await assert.rejects(Components.removeOwned(path.join(store, "link"), store), /link/);
  await assert.rejects(Components.removeOwned(outside, store), /outside its store/);
  assert.ok(fs.existsSync(outside));
  assert.equal(await Components.removeOwned(path.join(store, "kept"), store), true);
  assert.equal(fs.existsSync(path.join(store, "kept")), false);
});

test("a shared asset added by hand must match its size and SHA-256", async t => {
  offline(t);
  const root = temporary(t), bytes = Buffer.from("fixture soundfont bytes");
  const asset = { id: "fixture-font", label: "Fixture font", filename: "fixture.ttf", bytes: bytes.length, sha256: sha256(bytes), url: "https://example.test/fixture.ttf" };
  const component = File.component(asset, { users: ["Fixture engine"], description: "Fixture." });
  const chosen = { file: null };
  const service = Service.createComponentService({ userDataDir: root, registry: fakeRegistry([component]),
    callHost: async name => name === "chooseImportPath" ? chosen.file : true });
  chosen.file = path.join(root, "short.ttf"); fs.writeFileSync(chosen.file, "short");
  await assert.rejects(service.import({ componentId: component.id }), /has 5 bytes; Fixture font has 23/);
  chosen.file = path.join(root, "wrong.ttf"); fs.writeFileSync(chosen.file, Buffer.from("fixture soundfont BYTES"));
  await assert.rejects(service.import({ componentId: component.id }), /SHA-256 is [a-f0-9]{64}; Fixture font is/);
  assert.deepEqual(await component.list({ userDataDir: root }), []);
  chosen.file = null;
  assert.equal(await service.import({ componentId: component.id }), false, "a canceled chooser adds nothing");
  chosen.file = path.join(root, "right.ttf"); fs.writeFileSync(chosen.file, bytes);
  assert.equal(await service.import({ componentId: component.id }), true);
  const [item] = (await service.list()).components.find(row => row.id === component.id).items;
  assert.deepEqual(item.source, { manual: true, label: "Added manually" });
  assert.equal(File.resolve(asset, root), item.path);
  assert.deepEqual(item.users, ["Fixture engine"]);
  await service.remove({ componentId: component.id, itemId: item.id });
  assert.equal(File.resolve(asset, root), null, "a deleted asset is fetched again by ensure(), after consent");
});

test("a runtime archive added by hand installs the release whose SHA-256 it matches", async t => {
  const root = temporary(t), archive = path.join(root, "release.tar.gz"); fs.writeFileSync(archive, "release archive");
  const actions = [];
  const manager = { id: "fixture-runtime", label: "Fixture runtime",
    getState: () => ({ sections: [{ id: "default", installed: [
      { version: "2.0", architecture: "x64", architectures: ["x86_64", "arm64"], installDir: path.join(root, "two"), archiveSha256: "b".repeat(64), assetUrl: "https://example.test/two.tar.gz" },
      { version: "1.0", architecture: "arm64", installDir: path.join(root, "one"), catalogEntry: { architecture: "arm64" }, source: "manual" },
      { version: "0.9", installDir: path.join(root, "included"), included: true }] }] }),
    core: { listCatalog: ({ architecture }) => architecture === "x64" ? [{ version: "3.0", asset: { sha256: sha256("release archive") } }] : [] } };
  const component = Components.fromRuntimeManager(manager, { users: ["Fixture games"], description: "Fixture." });
  const context = { userDataDir: root, runtimeAction: async (...args) => { actions.push(args); return true; } };
  const items = component.list(context);
  assert.deepEqual(items.map(item => [item.version, item.architecture, item.identity, item.source]), [
    ["2.0", "universal", "SHA-256 " + "b".repeat(64), { url: "https://example.test/two.tar.gz" }], ["1.0", "arm64", null, "manual"]]);
  await component.remove(items[0], context);
  assert.deepEqual(actions.pop(), ["fixture-runtime", "uninstall", { sectionId: "default", version: "2.0", architecture: "x64", variant: undefined,
    platformKey: undefined, installDir: path.join(root, "two") }]);
  const other = path.join(root, "other.tar.gz"); fs.writeFileSync(other, "another archive");
  await assert.rejects(component.import.run(other, context), /does not match any Fixture runtime release recorded on this Mac/);
  assert.equal(actions.length, 0);
  assert.deepEqual(await component.import.run(archive, context), { version: "3.0", architecture: "x64" });
  assert.deepEqual(actions.pop(), ["fixture-runtime", "install", { sectionId: "default", version: "3.0", architecture: "x64" }, { archiveFile: archive }]);
});

function machO(architecture) {
  const data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(2, 12);
  return data;
}

test("a pinned release installs from a local archive only when the archive matches its SHA-256", { skip: process.platform !== "darwin" }, async t => {
  const { createPinnedNativeManager, hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");
  const root = temporary(t), archive = path.join(root, "runtime.zip"), wrong = path.join(root, "wrong.zip");
  fs.writeFileSync(archive, "trusted archive fixture"); fs.writeFileSync(wrong, "replaced archive");
  let extracted = 0;
  const runtime = createPinnedNativeManager({ id: "fixture-native", label: "Fixture",
    discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "a", architecture: process.arch === "x64" ? "x64" : "arm64",
      asset: { url: "https://example.test/runtime.zip", filename: "runtime.zip", sha256: hashFile(archive) } }],
    resolveExecutable: directory => path.join(directory, "engine"),
    dependencies: { downloadToFile: () => assert.fail("A local archive is never downloaded"),
      extractArchive: async (_input, directory) => { extracted++; fs.writeFileSync(path.join(directory, "engine"), machO(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }); } } });
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "1.0", archiveFile: wrong }), /SHA-256/);
  assert.equal(extracted, 0);
  await runtime.installRuntime({ userDataDir: root, version: "1.0", archiveFile: archive });
  assert.equal(extracted, 1);
  const [installed] = runtime.getState({ userDataDir: root }).installed;
  assert.equal(installed.version, "1.0"); assert.equal(installed.ready, true); assert.equal(installed.archiveSha256, hashFile(archive));
});

test("a Valve client archive is accepted only under the name that carries its SHA-1", async t => {
  offline(t);
  const root = temporary(t), [valve] = require("../src/modules/crossover/components");
  assert.equal(valve.id, "steam-client-components");
  const file = path.join(root, "steamclient.zip"); fs.writeFileSync(file, "archive");
  await assert.rejects(valve.import.run(file, { userDataDir: root }), /bins_misc_ubuntu12\.zip\.<SHA-1>/);
  assert.deepEqual(valve.list({ userDataDir: root }), []);
  const store = path.join(root, "runtimes/steam-client-components"), current = "c".repeat(40), earlier = "d".repeat(40);
  fs.mkdirSync(path.join(store, current), { recursive: true }); fs.mkdirSync(path.join(store, earlier));
  fs.writeFileSync(path.join(store, "active.json"), JSON.stringify({ archiveSha1: current, source: "https://example.test/archive" }));
  const rows = valve.list({ userDataDir: root });
  assert.deepEqual(rows.map(row => [row.version, row.users.length > 0]), [["Current", true], ["Earlier archive", false]]);
  await valve.remove(rows[0], { userDataDir: root });
  assert.equal(fs.existsSync(path.join(store, "active.json")), false, "the bridge asks for an archive again");
  assert.equal(fs.existsSync(path.join(store, current)), false);
});

test("a cache component deletes its folder and reports its owner", async t => {
  const root = temporary(t), cache = Service.declarations(registry).find(item => item.id === "runtime-download-cache");
  const folder = path.join(root, "runtimes/artifacts"); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, "a"), "x");
  const [item] = cache.list({ userDataDir: root });
  assert.equal(cache.cache, true); assert.deepEqual(item.source, { label: "Created by MacLauncher" });
  await cache.remove(item, { userDataDir: root });
  assert.equal(fs.existsSync(folder), false);
});

test("a shared runtime library stays while an installed runtime declares it and can be deleted once none does", async t => {
  const root = temporary(t), dependency = { project: "vulkan-loader", release: "1.4.0", sha256: "e".repeat(64) };
  const store = path.join(root, "runtimes/.dependencies", dependency.project, dependency.release, dependency.sha256);
  fs.mkdirSync(store, { recursive: true });
  const receipt = path.join(root, "runtimes/maclauncher-kosmickrisp/arm64/27.0");
  fs.mkdirSync(receipt, { recursive: true });
  fs.writeFileSync(path.join(receipt, "runtime.json"), JSON.stringify({ version: "27.0", catalogEntry: { projectPackage: { dependencies: [dependency] } } }));
  const service = Service.createComponentService({ userDataDir: root, registry, logger: { warn() {} } });
  const listed = async () => (await service.list()).components.find(row => row.id === "shared-package-dependencies").items;
  const [item] = await listed();
  assert.deepEqual([item.version, item.identity, item.users, item.removable], ["vulkan-loader 1.4.0", "SHA-256 " + "e".repeat(64), ["maclauncher-kosmickrisp"], false]);
  assert.match(item.removeReason, /Installed runtimes load this library/);
  await assert.rejects(service.remove({ componentId: "shared-package-dependencies", itemId: item.id }), /Installed runtimes load this library/);
  assert.ok(fs.existsSync(store));
  fs.rmSync(path.dirname(path.dirname(receipt)), { recursive: true });
  const [unused] = await listed();
  assert.deepEqual([unused.users, unused.removable], [[], true]);
  await service.remove({ componentId: "shared-package-dependencies", itemId: unused.id });
  assert.equal(fs.existsSync(store), false);
});
