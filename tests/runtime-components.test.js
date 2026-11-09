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

// The folders whose components.js the registry reads: each module folder and
// every folder under shared, at any depth.
function declarationFiles() {
  const modules = path.join(__dirname, "../src/modules"), files = [];
  const folders = dir => fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => path.join(dir, entry.name));
  const shared = dir => { for (const folder of folders(dir)) { files.push(path.join(folder, "components.js")); shared(folder); } };
  for (const folder of folders(modules)) if (path.basename(folder) !== "shared") files.push(path.join(folder, "components.js"));
  shared(path.join(modules, "shared"));
  return files.filter(file => fs.existsSync(file));
}

test("every module and shared components.js loads, and each declaration it exports is listed", () => {
  const files = declarationFiles(), listed = new Set(registry.listComponents().map(component => component.id));
  assert.ok(files.length > 0);
  for (const file of files) {
    const declared = require(file), name = path.relative(path.join(__dirname, ".."), file);
    for (const component of Array.isArray(declared) ? declared : []) assert.ok(listed.has(component?.id), `${name}: ${component?.id}`);
  }
});

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
      assert.equal(typeof component.import.matches, "function", component.id);
      assert.equal(typeof component.import.run, "function", component.id);
    }
    assert.deepEqual(await component.list({ userDataDir: root, settings: {}, logger: console }) || [], [], `${component.id} on an empty profile`);
  }
  const service = Service.createComponentService({ userDataDir: root, registry, logger: { warn() {} } });
  const listed = await service.list();
  assert.deepEqual(listed.components.map(row => row.id), all.map(row => row.id));
  assert.ok(listed.components.every(row => row.error === null && Array.isArray(row.items) && row.items.length === 0));
});

// Downloaded files lists only downloads without a runtime manager: every
// registry manager is managed, refreshed and removed in a Runtimes row of its own.
test("every registry runtime manager has its own Runtimes row with Refresh and Remove", () => {
  const managers = [...registry.listModuleIds().flatMap(id => registry.getModule(id)?.runtimeManagers || []), ...registry.listSharedRuntimeManagers()];
  const rowless = [...new Set(managers.filter(manager => {
    const ui = registry.getRuntimeManagerUi(manager.id) || manager.ui || {};
    return ui.hidden === true || ui.management === "built-in";
  }).map(manager => manager.id))];
  assert.deepEqual(rowless, []);
  for (const manager of managers) {
    assert.equal(typeof manager.refreshCatalog, "function", `${manager.id} refreshes its catalog`);
    assert.equal(typeof (manager.uninstallRuntime || manager.uninstall), "function", `${manager.id} removes its downloads`);
  }
  const declared = new Set(Service.declarations(registry).map(component => component.managerId).filter(Boolean));
  assert.deepEqual([...declared], [], "no runtime manager is listed twice");
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
      { id: "one", version: "1.0", identity: "SHA-256 " + "a".repeat(64), architecture: "x86_64", windows: true, path: path.join(store, "one"),
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
  assert.equal(first.architecture, "x64"); assert.equal(first.windows, true); assert.equal(second.windows, false);
  assert.ok(first.bytes >= 9000); assert.equal(first.sizeComplete, true);
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

test("Add from file reads the chosen file first and adds a shared asset only when its size and SHA-256 match", async t => {
  offline(t);
  const root = temporary(t), bytes = Buffer.from("fixture soundfont bytes");
  const asset = { id: "fixture-font", label: "Fixture font", filename: "fixture.ttf", bytes: bytes.length, sha256: sha256(bytes), url: "https://example.test/fixture.ttf" };
  const component = File.component(asset, { users: ["Fixture engine"], description: "Fixture." });
  const chosen = { file: null }, prompts = [];
  const service = Service.createComponentService({ userDataDir: root, registry: fakeRegistry([component]),
    callHost: async (name, value) => { if (name === "chooseImportPath") { prompts.push(value); return chosen.file; } return true; } });
  chosen.file = null;
  assert.equal(await service.import(), false, "a canceled chooser adds nothing");
  assert.deepEqual(prompts[0], { label: "Add from file", kinds: ["file"], extensions: [], buttonLabel: "Add" });
  chosen.file = path.join(root, "empty.ttf"); fs.writeFileSync(chosen.file, "");
  await assert.rejects(service.import(), /The chosen file is empty/);
  chosen.file = root;
  await assert.rejects(service.import(), /Choose a file/);
  chosen.file = path.join(root, "wrong.ttf"); fs.writeFileSync(chosen.file, Buffer.from("fixture soundfont BYTES"));
  await assert.rejects(service.import(), new RegExp(`matches no download that MacLauncher records. Its SHA-256 is ${sha256(Buffer.from("fixture soundfont BYTES"))}`));
  assert.deepEqual(await component.list({ userDataDir: root }), []);
  chosen.file = path.join(root, "right.ttf"); fs.writeFileSync(chosen.file, bytes);
  assert.deepEqual(await service.import(), { componentId: component.id, label: "Fixture font" });
  const [item] = (await service.list()).components.find(row => row.id === component.id).items;
  assert.deepEqual(item.source, { manual: true, label: "Added manually" });
  assert.equal(File.resolve(asset, root), item.path);
  assert.deepEqual(item.users, ["Fixture engine"]);
  // Installed already: a different file is still read and rejected, never reported as added.
  chosen.file = path.join(root, "wrong.ttf");
  await assert.rejects(service.import(), /matches no download/);
  const short = path.join(root, "short.ttf"); fs.writeFileSync(short, "short");
  await assert.rejects(component.import.run(short, { userDataDir: root }), /has 5 bytes; Fixture font has 23/, "run checks the file again");
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
  const component = Components.fromRuntimeManager(manager, { users: ["Fixture games"], description: "Fixture.", windows: true });
  const context = { userDataDir: root, runtimeAction: async (...args) => { actions.push(args); return true; } };
  const items = component.list(context);
  assert.deepEqual(items.map(item => [item.version, item.architecture, item.windows, item.identity, item.source]), [
    ["2.0", "universal", true, "SHA-256 " + "b".repeat(64), { url: "https://example.test/two.tar.gz" }], ["1.0", "arm64", true, null, "manual"]]);
  await component.remove(items[0], context);
  assert.deepEqual(actions.pop(), ["fixture-runtime", "uninstall", { sectionId: "default", version: "2.0", architecture: "x64", variant: undefined,
    platformKey: undefined, installDir: path.join(root, "two") }]);
  const other = path.join(root, "other.tar.gz"); fs.writeFileSync(other, "another archive");
  assert.equal(component.import.matches({ sha256: sha256("another archive") }, context), false);
  assert.equal(component.import.matches({ sha256: sha256("release archive") }, context), true);
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

test("interrupted deletions in every component store are finished by storage upkeep", async t => {
  const Storage = require("../src/core/storage-maintenance");
  const root = temporary(t), trash = () => ".maclauncher-trash-" + crypto.randomUUID();
  const folders = [path.join(root, "assets", "fixture-font"), path.join(root, "cache"),
    path.join(root, "modules", "rgss", "assets", "rtp-packs", "RPGVXAce"), path.join(root, "external", "tools"),
    path.join(root, "runtimes", "graphics-neural-models")];
  const left = folders.map(folder => { const file = path.join(folder, trash()); fs.mkdirSync(file, { recursive: true }); fs.writeFileSync(path.join(file, "data"), "x"); return file; });
  const kept = path.join(root, "cache", "translator-descriptions"); fs.mkdirSync(kept, { recursive: true });
  await Storage.maintainStorage({ userDataDir: root, stores: Storage.listStores(registry), logger: { info() {}, warn() {} } });
  assert.deepEqual(left.filter(file => fs.existsSync(file)).map(file => path.relative(root, path.dirname(file))), []);
  assert.ok(fs.existsSync(kept), "only trash entries are removed");
});

test("a cache component deletes its folder and reports its owner", async t => {
  const root = temporary(t), cache = Service.declarations(registry).find(item => item.id === "translator-descriptions");
  const folder = path.join(root, "cache/translator-descriptions"); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, "a"), "x");
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
  const label = [...registry.listSharedRuntimeManagers(), ...registry.listModuleIds().flatMap(id => registry.getModule(id)?.runtimeManagers || [])]
    .find(manager => manager.id === "maclauncher-kosmickrisp")?.label;
  assert.ok(label && label !== "maclauncher-kosmickrisp");
  assert.deepEqual([item.version, item.identity, item.users, item.removable], ["vulkan-loader 1.4.0", "SHA-256 " + "e".repeat(64), [label], false],
    "Used by names the runtime as Runtimes does");
  assert.match(item.removeReason, /Installed runtimes load this library/);
  await assert.rejects(service.remove({ componentId: "shared-package-dependencies", itemId: item.id }), /Installed runtimes load this library/);
  assert.ok(fs.existsSync(store));
  fs.rmSync(path.dirname(path.dirname(receipt)), { recursive: true });
  const [unused] = await listed();
  assert.deepEqual([unused.users, unused.removable], [[], true]);
  await service.remove({ componentId: "shared-package-dependencies", itemId: unused.id });
  assert.equal(fs.existsSync(store), false);
});

test("a component with a catalog offers Refresh, and a Runtimes row measures its installed versions inside the profile", async t => {
  const root = temporary(t), outside = temporary(t), refreshed = [];
  const component = { id: "catalogued", label: "Catalogued", list: () => [], async refresh(context) { refreshed.push(Boolean(context.userDataDir)); return "Newest: 2.0."; } };
  const inside = path.join(root, "runtimes", "fixture", "1.0");
  fs.mkdirSync(inside, { recursive: true }); fs.writeFileSync(path.join(inside, "runtime.bin"), Buffer.alloc(8192));
  const manager = { id: "fixture", getState: () => ({ sections: [{ id: "default", installed: [{ version: "1.0", installDir: inside }, { version: "2.0", installDir: outside }] }] }) };
  const service = Service.createComponentService({ userDataDir: root, logger: { warn() {} },
    registry: { ...fakeRegistry([component, { id: "plain", label: "Plain", list: () => [] }]), listSharedRuntimeManagers: () => [manager] } });
  const { components } = await service.list();
  assert.deepEqual(components.filter(row => row.owner === "fixture").map(row => [row.id, row.refreshable]), [["catalogued", true], ["plain", false]]);
  assert.equal(await service.refresh({ componentId: "catalogued" }), "Newest: 2.0.");
  assert.deepEqual(refreshed, [true]);
  await assert.rejects(service.refresh({ componentId: "plain" }), /no catalog/);
  const { sizes } = await service.sizes({ managerId: "fixture" });
  assert.deepEqual(Object.keys(sizes), [inside], "a registered folder outside the profile is not measured");
  assert.ok(sizes[inside].bytes >= 8192); assert.equal(sizes[inside].complete, true);
  await assert.rejects(service.sizes({ managerId: "missing" }), /not found/);
});

test("Android system images, microG packages and store catalogs are listed and removed in their own stores", async t => {
  const root = temporary(t), sha = "a".repeat(64);
  const image = path.join(root, "android", "system-images", sha);
  fs.mkdirSync(path.join(image, "mounted"), { recursive: true });
  fs.writeFileSync(path.join(image, "image.json"), JSON.stringify({ schemaVersion: 1, archiveSha256: sha }));
  fs.writeFileSync(path.join(image, "system.dmg"), Buffer.alloc(4096));
  const release = path.join(root, "android", "google", "packages", "0.3.9");
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, "release.json"), JSON.stringify({ version: "0.3.9", releaseUrl: "https://github.com/microg/GmsCore/releases/tag/v0.3.9", packages: [] }));
  fs.mkdirSync(path.join(root, "external", "catalogs", "fdroid"), { recursive: true });
  fs.mkdirSync(path.join(root, "steam", "accounts", "abc", "catalog"), { recursive: true });
  const service = Service.createComponentService({ userDataDir: root, registry, logger: { warn() {} } });
  const listed = Object.fromEntries((await service.list()).components.map(row => [row.id, row]));
  const [systemImage] = listed["android-system-images"].items;
  assert.equal(systemImage.identity, `SHA-256 ${sha}`); assert.equal(systemImage.removable, true); assert.ok(systemImage.bytes >= 4096);
  assert.deepEqual(listed["android-google-packages"].items.map(item => [item.version, item.source.url]), [["microG 0.3.9", "https://github.com/microg/GmsCore/releases/tag/v0.3.9"]]);
  assert.equal(listed["android-google-packages"].refreshable, true);
  assert.deepEqual(listed["android-store-catalogs"].items.map(item => item.version), ["F-Droid index"]);
  assert.deepEqual(listed["steam-catalogs"].items.map(item => item.id), [path.join("accounts", "abc", "catalog")]);
  assert.deepEqual(listed["steam-catalogs"].items.map(item => item.version), ["for a signed-in account"]);
  // An image attached for a running game stays.
  fs.mkdirSync(path.join(image, "mounted", "system"));
  const attached = (await service.list()).components.find(row => row.id === "android-system-images").items[0];
  assert.equal(attached.removable, false); assert.match(attached.removeReason, /running Android game/);
  fs.rmdirSync(path.join(image, "mounted", "system"));
  for (const [componentId, itemId, location] of [["android-system-images", sha, image], ["android-google-packages", "0.3.9", release],
    ["android-store-catalogs", "fdroid", path.join(root, "external", "catalogs", "fdroid")]]) {
    assert.equal(await service.remove({ componentId, itemId }), true); assert.equal(fs.existsSync(location), false, componentId);
  }
});
