const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Apktool = require("../src/modules/android/tools/apktool");
const Manager = require("../src/modules/android/tools/apktool-manager");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-apktool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apk = path.join(root, "original.apk");
  const manifest = fs.readFileSync(path.resolve("tests/fixtures/android-package-metadata/metadata.apk"));
  fs.writeFileSync(apk, manifest);
  return { root, apk, entry: { gameId: "apktool-fixture", gamePath: apk, moduleData: { original: true } }, context: { userDataDir: path.join(root, "profile") } };
}

test("Apktool is a separate offline managed tool and Android action leaves runtime selection alone", () => {
  const module = require("../src/modules/android/main");
  assert.ok(module.runtimeManagers.some(manager => manager.id === "apktool"));
  assert.equal(require("../src/modules/registry").getRuntimeManagerUi("apktool").groupId, "tools");
  assert.equal(module.actions.decodeApk, Apktool.decodeApk);
  assert.equal(module.manifest.runtime.default, "klepton");
  assert.ok(module.manifest.ui.actions.find(action => action.id === "decodeApk").cancellable);
});

test("APK decoding retains original package bytes and previous output if a later decode fails", async t => {
  const { entry, context, apk } = setup(t), original = fs.readFileSync(apk);
  const run = async (_context, _payload, options) => {
    assert.equal(options.args[0], "decode");
    assert.ok(options.args.includes("--all-src"));
    const output = options.args[options.args.indexOf("--output") + 1];
    fs.mkdirSync(output); fs.writeFileSync(path.join(output, "AndroidManifest.xml"), "<manifest/>");
    fs.mkdirSync(path.join(output, "smali")); fs.writeFileSync(path.join(output, "smali", "Game.smali"), ".class public LGame;");
    return { toolVersion: "3.0.3" };
  };
  const result = await Apktool.decodeApk(entry, {}, context, { run });
  assert.equal(result.packages, 1); assert.equal(entry.moduleData.original, true);
  assert.deepEqual(fs.readFileSync(apk), original);
  assert.ok(fs.existsSync(path.join(result.outputDir, "base", "smali", "Game.smali")));
  await assert.rejects(Apktool.decodeApk(entry, {}, context, { run: async () => { throw Error("decode failed"); } }), /decode failed/);
  assert.ok(fs.existsSync(path.join(result.outputDir, "base", "smali", "Game.smali")));
});

test("APK decoding retains resource splits and supplies the original base as a private resource library", async t => {
  const { root, entry, context } = setup(t);
  fs.rmSync(entry.gamePath);
  entry.gamePath = path.join(root, "base.apk");
  for (const name of ["base.apk", "resources.apk"])
    fs.copyFileSync(path.resolve("tests/fixtures/android-apk-metadata-standalone", name), path.join(root, name));
  const calls = [];
  const result = await Apktool.decodeApk(entry, {}, context, { run: async (_context, _payload, options) => {
    calls.push(options.args);
    const directory = options.args[options.args.indexOf("--output") + 1]; fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "AndroidManifest.xml"), "<manifest/>");
    return { toolVersion: "3.0.3" };
  } });
  assert.equal(result.packages, 2);
  assert.equal(calls[0].includes("--lib"), false);
  assert.match(calls[1][calls[1].indexOf("--lib") + 1], /^org\.maclauncher\.metadata\.fixture:.*base-library\.apk$/);
  assert.deepEqual(result.decoded.map(item => item.originalName), ["base.apk", "resources.apk"]);
});
