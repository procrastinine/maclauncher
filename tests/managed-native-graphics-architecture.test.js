const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const HashLink = require("../src/modules/hashlink/main");
const Unity = require("../src/modules/unity/main");
const UnityManager = require("../src/modules/unity/runtime/manager");
const Inputs = require("../src/modules/shared/runtime/native-graphics-inputs");

function executable(architectures) {
  const slices = architectures.map(architecture => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12); return bytes;
  });
  if (slices.length === 1) return slices[0];
  const header = Buffer.alloc(8 + 20 * slices.length);
  header.writeUInt32BE(0xcafebabe); header.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const at = 8 + index * 20;
    header.writeUInt32BE(slice.readUInt32LE(4), at); header.writeUInt32BE(header.length + index * 32, at + 8);
    header.writeUInt32BE(32, at + 12);
  });
  return Buffer.concat([header, ...slices]);
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-graphics-architecture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test("HashLink graphics follows the Intel bytecode VM even on an ARM launcher", () => {
  assert.equal(Inputs.resolveArchitecture({ moduleData: { executableArchitectures: ["arm64"] } }, {
    runtimeId: "hashlink", hostArchitecture: "arm64",
    declaredArchitecture: HashLink.manifest.runtime.entries.hashlink.graphicsArchitecture
  }), "x86_64");
});

test("Unity graphics follows the verified selected player and its Rosetta launch policy", t => {
  const root = temporary(t), player = path.join(root, "UnityPlayer"), settings = {};
  const entry = { gamePath: path.join(root, "Game.exe"), moduleData: { executableArchitectures: ["arm64"] } };
  let selection;
  t.mock.method(UnityManager, "resolveSelection", (selectedEntry, selectedSettings, selectedRoot) => {
    assert.equal(selectedEntry, entry); assert.equal(selectedSettings, settings); assert.equal(selectedRoot, root);
    return selection;
  });
  const host = process.arch === "x64" ? "x86_64" : process.arch;
  for (const [architectures, needsRosetta, expected] of [
    [["x86_64"], true, "x86_64"], [["arm64"], false, "arm64"],
    [["arm64", "x86_64"], false, host], [["arm64", "x86_64"], true, "x86_64"]
  ]) {
    fs.writeFileSync(player, executable(architectures));
    selection = { ready: true, install: { executablePath: player, architectures, needsRosetta } };
    assert.deepEqual(Unity.resolveGraphicsInputs(entry, { runtimeId: "unity", settings, userDataDir: root }), { architecture: expected });
  }
  // A complete selection with no architecture sidecar still uses its own native
  // executable, never the imported Windows/Linux export or launcher CPU.
  selection.install.architectures = [];
  selection.install.needsRosetta = false;
  fs.writeFileSync(player, executable(["x86_64"]));
  assert.deepEqual(Unity.resolveGraphicsInputs(entry, { runtimeId: "unity", settings, userDataDir: root }), { architecture: "x86_64" });
});

test("Unity native graphics inspects the same bundle entry used for launch", t => {
  const root = temporary(t), app = path.join(root, "Game.app"), contents = path.join(app, "Contents"), macos = path.join(contents, "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ActualPlayer</string></dict></plist>');
  const player = path.join(macos, "ActualPlayer"), entry = { nativeAppPath: app, moduleData: { executableArchitectures: ["arm64"] } };
  t.mock.method(UnityManager, "resolveSelection", () => assert.fail("Native Unity does not select a replacement player"));
  for (const architectures of [["x86_64"], ["arm64"], ["x86_64", "arm64"]]) {
    fs.writeFileSync(player, executable(architectures));
    const expected = architectures.length === 1 ? architectures[0] : process.arch === "x64" ? "x86_64" : process.arch;
    assert.deepEqual(Unity.resolveGraphicsInputs(entry, { runtimeId: "native" }), { architecture: expected });
  }
});

test("Unity does not invent a graphics architecture for an unavailable player or another backend", t => {
  t.mock.method(UnityManager, "resolveSelection", () => ({ ready: false, install: null }));
  assert.equal(Unity.resolveGraphicsInputs({}, { runtimeId: "unity" }), null);
  assert.equal(Unity.resolveGraphicsInputs({}, { runtimeId: "native" }), null);
  assert.equal(Unity.resolveGraphicsInputs({}, { runtimeId: "sikarugir" }), null);
});

test("Ren'Py SDK and patched graphics inspect selected native code rather than a universal folder name", t => {
  const Renpy = require("../src/modules/renpy/main");
  const Sdk = require("../src/modules/renpy/runtime/sdk-runtime-manager");
  const root = temporary(t), sdk = path.join(root, "sdk"), source = path.join(root, "game");
  let install = { version: "8.5.3", installDir: sdk };
  t.mock.method(Sdk.core, "listInstalled", () => install ? [install] : []);
  const entry = { gameId: "graphics", gamePath: source, contentRootDir: source,
    runtimeData: { sdk: { version: "8.5.3" } }, moduleData: { major: 8, baseName: "Game" } };
  const host = process.arch === "x64" ? "x86_64" : process.arch;
  for (const [name, architectures, expected] of [
    ["py3-mac-universal", ["x86_64"], "x86_64"], ["py3-mac-universal", ["arm64"], "arm64"],
    ["py3-mac-universal", ["arm64", "x86_64"], host], ["py3-mac-x86_64", ["arm64", "x86_64"], "x86_64"]
  ]) {
    for (const directory of [sdk, source]) {
      fs.rmSync(path.join(directory, "lib"), { recursive: true, force: true });
      const lib = path.join(directory, "lib", name); fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, directory === sdk ? "renpy" : "Game"), executable(architectures));
    }
    for (const runtimeId of ["sdk", "patched"]) {
      assert.deepEqual(Renpy.resolveGraphicsInputs(entry, { runtimeId, settings: {}, userDataDir: root }), { architecture: expected });
    }
  }
  install = null;
  assert.equal(Renpy.resolveGraphicsInputs(entry, { runtimeId: "sdk", settings: {}, userDataDir: root }), null);
});

test("Java graphics follows the same JRE line, version and CPU selection as launch", t => {
  const Java = require("../src/modules/java/main"), Core = require("../src/modules/java/runtime/java-runtime");
  const root = temporary(t), java = path.join(root, "java");
  let selected;
  t.mock.method(Core, "resolveBestInstalled", options => {
    assert.equal(options.line, 8); assert.equal(options.version, "8.0.492+9");
    assert.equal(options.variant, selected?.variant || "arm64");
    return selected;
  });
  for (const [architectures, variant, requiresRosetta, expected] of [
    [["x86_64"], "x64", true, "x86_64"], [["arm64"], "arm64", false, "arm64"],
    [["arm64", "x86_64"], "x64", true, "x86_64"]
  ]) {
    fs.writeFileSync(java, executable(architectures));
    selected = { javaPath: java, variant, requiresRosetta };
    const entry = { runtimeData: { java: { line: 8, version: "8.0.492+9", variant } } };
    assert.deepEqual(Java.resolveGraphicsInputs(entry, { runtimeId: "java", settings: {}, userDataDir: root }), { architecture: expected });
  }
  selected = null;
  assert.equal(Java.resolveGraphicsInputs({ runtimeData: { java: { line: 8, version: "8.0.492+9", variant: "arm64" } } },
    { runtimeId: "java", settings: {}, userDataDir: root }), null);
});

test("LÖVE graphics reads the explicitly selected bundle and keeps native universal choice", t => {
  const Love = require("../src/modules/love/main"), Manager = Love.runtimeManagers[0];
  const root = temporary(t), app = path.join(root, "love.app"), player = path.join(app, "Contents", "MacOS", "love");
  fs.mkdirSync(path.dirname(player), { recursive: true });
  let selected;
  t.mock.method(Manager, "getState", () => ({ sections: [] }));
  t.mock.method(Manager.core, "resolveInstalled", options => {
    assert.equal(options.channel, "stable"); assert.equal(options.version, "11.5"); return selected;
  });
  const entry = { runtimeData: { love: { channel: "stable", version: "11.5" } } };
  const host = process.arch === "x64" ? "x86_64" : process.arch;
  for (const [architectures, requiresRosetta, expected] of [
    [["x86_64"], true, "x86_64"], [["arm64"], false, "arm64"], [["arm64", "x86_64"], false, host]
  ]) {
    fs.writeFileSync(player, executable(architectures));
    selected = { appPath: app, version: "11.5", requiresRosetta };
    assert.deepEqual(Love.resolveGraphicsInputs(entry, { runtimeId: "love", settings: {}, userDataDir: root }), { architecture: expected });
  }
  selected = null;
  assert.equal(Love.resolveGraphicsInputs(entry, { runtimeId: "love", settings: {}, userDataDir: root }), null);
});

test("Official GameMaker graphics uses the selected legacy Intel runner without forcing modern ARM runners", t => {
  const GameMaker = require("../src/modules/gamemaker/main"), Official = require("../src/modules/gamemaker/runtime/official");
  const root = temporary(t), player = path.join(root, "Mac_Runner");
  let selected;
  t.mock.method(Official.manager, "resolveSelection", () => selected);
  const host = process.arch === "x64" ? "x86_64" : process.arch;
  for (const [version, architectures, expected] of [
    ["1.4.9999", ["x86_64"], "x86_64"], ["2024.11.0.227", ["arm64"], "arm64"],
    ["2024.11.0.227", ["arm64", "x86_64"], host]
  ]) {
    fs.writeFileSync(player, executable(architectures));
    selected = { ready: true, version, install: { executablePath: player, architectures } };
    assert.deepEqual(GameMaker.resolveGraphicsInputs({}, { runtimeId: "official-studio", settings: {}, userDataDir: root }), { architecture: expected });
  }
  selected = { ready: false, install: null };
  assert.equal(GameMaker.resolveGraphicsInputs({}, { runtimeId: "official-studio", settings: {}, userDataDir: root }), null);
  assert.equal(GameMaker.resolveGraphicsInputs({}, { runtimeId: "butterscotch" }), null);
});
