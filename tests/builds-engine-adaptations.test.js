const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const Bundled = require("../src/modules/shared/runtime/bundled-native");

for (const [id, modulePath, entry] of [
  ["vnds-love", "../src/modules/vnds/runtime/manager", "engine/main.lua"]
]) test(`${id} installs a sealed archive, preserves exact selection and reuses it offline`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-engine-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stageData } = await import(pathToFileURL(path.resolve(__dirname, "../../maclauncher-builds/producers/engine-adaptations/stage.mjs")));
  const { pack, catalog } = await import(pathToFileURL(path.resolve(__dirname, "../../maclauncher-builds/tools/runtime-package.mjs")));
  const input = path.join(root, "input"), declaration = stageData({ project: id, output: input });
  const archive = path.join(root, `${id}-${declaration.version}-${declaration.arch}.tar.gz`);
  const record = await pack({ project: id, input, declaration, output: archive });
  const selectedCatalog = catalog([record], { project: id, repository: "procrastinine/maclauncher-builds" });
  let fetches = 0, downloads = 0, offline = false;
  const options = { systemVersionSync: () => "26.0", fetchUrlBuffer: async url => {
    assert.equal(offline, false, "offline selection must not refresh"); fetches++;
    assert.equal(url, `https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/${id}.json`);
    return { status: 200, body: Buffer.from(JSON.stringify(selectedCatalog)) };
  }, downloadToFile: async (url, destination) => {
    assert.equal(offline, false); downloads++; assert.equal(url, selectedCatalog.packages[0].asset.url);
    fs.copyFileSync(archive, destination);
  } };
  const Runtime = require(modulePath), userDataDir = path.join(root, "profile");
  const manager = Runtime.createManager(options);
  assert.equal(manager.getState({ userDataDir }).catalog.versions.length, 0);
  assert.equal(fetches, 0);
  assert.equal(manager.resolveSelection(null, {}, userDataDir).version, null);
  assert.equal(manager.resolveSelection(null, {}, userDataDir).selectionRequired, true);
  assert.equal(fetches, 0);
  await manager.installRuntime({ userDataDir, version: record.version });
  assert.equal(downloads, 1); assert.equal(fetches, 1);
  offline = true;
  const restarted = Runtime.createManager(options), configured = { runtimes: { [id]: { defaultVersion: record.version } } };
  const selected = restarted.resolveSelection(null, configured, userDataDir);
  assert.equal(selected.ready, true); assert.equal(selected.version, record.version);
  assert.equal(selected.install.executablePath, path.join(selected.install.root, entry));
  assert.equal(Bundled.verifyPayload(selected.install.root, selected.install.declaration), true);
  await restarted.installRuntime({ userDataDir, version: record.version });
  assert.equal(downloads, 1); assert.equal(fetches, 1);
  // Consumption rejects corruption anywhere in the script closure, including a non-entry member.
  const member = selected.install.manifest.files.find(file => file.path !== entry && (file.path.endsWith(".js") || file.path.endsWith("conf.lua")));
  const memberPath = path.join(selected.install.root, member.path);
  const changed = fs.readFileSync(memberPath); changed[0] ^= 1; fs.writeFileSync(memberPath, changed);
  assert.throws(() => Bundled.verifyPayload(selected.install.root, selected.install.declaration), /checksum|permissions|size/i);
  assert.throws(() => Runtime.resolveEngine(null, { settings: configured, userDataDir }), /checksum|permissions|size/i);
});
