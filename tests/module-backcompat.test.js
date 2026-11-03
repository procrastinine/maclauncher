const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Module = require("node:module");

test("registry discovers backcompat parts only for a migration and preserves missing-part errors", t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "module-backcompat-")));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  for (const id of ["current", "historical", "broken"]) {
    const root = path.join(directory, id);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({id, label: id}));
    fs.writeFileSync(path.join(root, "main.js"), `module.exports = {id:${JSON.stringify(id)}, manifest: require('./manifest.json')};`);
    if (id === "current") continue;
    fs.mkdirSync(path.join(root, "backcompat"));
    fs.writeFileSync(path.join(root, "backcompat/index.js"), id === "historical"
      ? "exports.legacyGameMirrors = entry => [{mirrorRoot: entry.previous, sourceRoot: entry.original}]; exports.migrateLegacyGameData = () => ({complete:true, entryPatch:{launchArguments:'--kept'}});"
      : "require('./missing-dependency');");
  }
  const actual = path.resolve(__dirname, "../src/modules/registry.js");
  const registry = new Module(path.join(directory, "registry.js"), module);
  registry.filename = path.join(directory, "registry.js");
  const requireProduction = Module.createRequire(actual);
  registry.require = name => path.isAbsolute(name) ? require(name) : requireProduction(name);
  registry._compile(fs.readFileSync(actual, "utf8"), registry.filename);
  const api = registry.exports, historical = path.join(directory, "historical/backcompat/index.js");
  assert.deepEqual(api.listModuleIds().sort(), ["broken", "current", "historical"]);
  assert.equal(require.cache[historical], undefined, "Ordinary registry loading must not load historical parts");
  assert.equal(require(path.join(directory, "historical/main.js")).legacyGameMirrors, undefined,
    "The registry must not add migration exports to the current module's own object");
  assert.deepEqual(api.getModule("current").legacyGameMirrors({}, {}), []);
  assert.deepEqual(api.getModule("historical").legacyGameMirrors({previous: "/old", original: "/original"}, {}),
    [{mirrorRoot: "/old", sourceRoot: "/original"}]);
  assert.ok(require.cache[historical]);
  assert.deepEqual(api.getModule("historical").migrateLegacyGameData({}, {}), {complete:true, entryPatch:{launchArguments:"--kept"}});
  assert.equal(api.getModule("current").migrateLegacyGameData({}, {}), null);
  assert.throws(() => api.getModule("broken").legacyGameMirrors({}, {}), /missing-dependency/);
  assert.equal(api.getModule("broken").id, "broken", "An unavailable old-data part must not hide the current game module");
});
