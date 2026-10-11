const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const Packaged = require("../src/modules/rgss/packaged");
const SevenZip = require("../src/modules/shared/runtime/sevenzip");
const Registry = require("../src/modules/registry");
const RgssModule = require("../src/modules/rgss/main");
const MkxpzLauncher = require("../src/modules/rgss/runtime/mkxpz-launcher");

test("RGSS executable containers reject traversal paths and links", () => {
  for (const name of ["../escape", "/absolute", "C:\\escape", "dir/../escape"]) {
    assert.throws(() => Packaged.validateArchiveEntries([{ path: name }]), /Unsafe/);
  }
  assert.throws(() => Packaged.validateArchiveEntries([{ path: "Data", isLink: true }]), /Unsafe/);
  assert.doesNotThrow(() => Packaged.validateArchiveEntries([{ path: "Game/Data/Scripts.rvdata2" }]));
  assert.equal(Packaged.versionFromEntries(["Game/Data/Scripts.rvdata2"]), "RGSS3");
  assert.equal(Packaged.versionFromEntries(["readme.txt"]), null);
});

test("RGSS self-extracting executables import, stage, reuse saves, and leave the original unchanged", async t => {
  const sevenZip = SevenZip.resolveSevenZipBinary();
  if (!sevenZip) return t.skip("7-Zip is not installed");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rgss-sfx-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "Game", "Data"), { recursive: true });
  fs.writeFileSync(path.join(source, "Game", "Game.ini"), "[Game]\nLibrary=RGSS301.dll\nTitle=SFX Test");
  fs.writeFileSync(path.join(source, "Game", "Data", "Scripts.rvdata2"), "fixture");
  const zip = path.join(root, "payload.zip");
  const result = spawnSync(sevenZip, ["a", "-tzip", zip, "Game"], { cwd: source, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const executable = path.join(root, "Game.exe");
  const original = Buffer.concat([Buffer.from("MZ fixture stub\n"), fs.readFileSync(zip)]);
  fs.writeFileSync(executable, original);
  const detected = Registry.detectGame(executable);
  assert.equal(detected.engine, "rgss");
  assert.equal(detected.moduleData.packagedType, "sfx");
  const entry = { ...detected, gameId: "sfx-test" };
  const userDataDir = path.join(root, "userData");
  const [staged, concurrent] = await Promise.all([
    Packaged.ensureExtracted(entry, userDataDir), Packaged.ensureExtracted(entry, userDataDir)
  ]);
  assert.equal(concurrent.contentRootDir, staged.contentRootDir);
  assert.equal(staged.moduleData.rgssVersion, "RGSS3");
  assert.ok(staged.contentRootDir.startsWith(path.join(userDataDir, "games", "sfx-test")));
  assert.ok(fs.existsSync(path.join(staged.contentRootDir, "Data", "Scripts.rvdata2")));
  fs.writeFileSync(path.join(staged.contentRootDir, "Save01.rvdata2"), "save fixture");
  const cached = await Packaged.ensureExtracted(entry, userDataDir);
  assert.equal(fs.readFileSync(path.join(cached.contentRootDir, "Save01.rvdata2"), "utf8"), "save fixture");
  assert.deepEqual(fs.readFileSync(executable), original);
  assert.equal(cached.defaultSaveDir, cached.contentRootDir);
  let persisted;
  t.mock.method(MkxpzLauncher, "launchRuntime", async options => {
    assert.equal(options.entry.contentRootDir, cached.contentRootDir);
    return { pid: 123 };
  });
  await RgssModule.launchRuntime("mkxpz", entry, {
    userDataDir,
    onEntryChange: patch => { persisted = patch; }
  });
  assert.equal(persisted.contentRootDir, cached.contentRootDir);
  assert.equal(persisted.defaultSaveDir, cached.contentRootDir);
});

test("Enigma helper resolves a physical path in packaged layouts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-enigma-packaged-"));
  const previous = process.resourcesPath;
  t.after(() => {
    if (previous === undefined) delete process.resourcesPath;
    else process.resourcesPath = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const helper = path.join(root, "app.asar.unpacked", "src", "modules", "rgss", "evb-files.py");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, "# fixture");
  process.resourcesPath = root;
  assert.equal(Packaged.resolveEvbHelper(), helper);
  assert.ok(require("../package.json").build.asarUnpack.includes("src/modules/rgss/evb-files.py"));
});
