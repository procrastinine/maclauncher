const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Backcompat = require("../src/modules/alicesoft/backcompat");
const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");

test("AliceSoft released save-route facts cover pending ordinary roots and veto authored choices", t => {
  for (const generation of ["system3", "system35", "system4"]) {
    const f = fixture(t, generation);
    f.entry.defaultSaveDir = f.releasedSaveRoot;
    const before = structuredClone(f.entry);
    // Missing scenario/CodeName deliberately leaves these native destinations
    // unresolved; facts still reach the shared pending-only decision.
    const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
    assert.deepEqual(descriptor.releasedSaveRoute, { directory: f.releasedSaveRoot,
      entryPatch: { saveDirOverride: f.releasedSaveRoot }, proven: true, explicit: false });
    if (generation !== "system3") assert.equal(descriptor.sourceRoot, null);
    assert.equal(Backcompat.legacyGameMirrors({ ...f.entry, defaultSaveDir: f.contentRootDir }, f)[0].releasedSaveRoute, undefined);
    for (const patch of [{ saveDirOverride: path.join(f.environment.HOME, "chosen") }, { launchArguments: '-savedir "chosen"' }, { launchArguments: '"unclosed' }])
      assert.equal(Backcompat.legacyGameMirrors({ ...f.entry, ...patch }, f)[0].releasedSaveRoute.explicit, true);
    if (generation === "system3") fs.writeFileSync(path.join(f.contentRootDir, "system3.ini"), "[config]\nsavedir = NativeSaves\n");
    else if (generation === "system35") fs.writeFileSync(path.join(f.contentRootDir, ".xsys35rc"), "savedir: NativeSaves\n");
    else fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\nSaveFolder = "NativeSaves"\n');
    assert.equal(Backcompat.legacyGameMirrors(f.entry, f)[0].releasedSaveRoute.explicit, true);
    assert.deepEqual(f.entry, before);
  }
  const f = fixture(t, "system4"); f.entry.defaultSaveDir = f.releasedSaveRoot;
  assert.equal(Backcompat.legacyGameMirrors(f.entry, { ...f, environment: { ...f.environment, XSYSTEM4_HOME: path.join(f.environment.HOME, "authored") } })[0].releasedSaveRoute.explicit, true);
});

function fixture(t, generation) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "alice-released-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), contentRootDir = path.join(root, "game"), home = path.join(root, "home");
  fs.mkdirSync(contentRootDir);
  fs.mkdirSync(home);
  const entry = { gameId: generation, contentRootDir, moduleData: { generation } };
  // v0.5.1 main.js:50–74 passes this exact directory to each native save flag.
  const releasedSaveRoot = path.join(userDataDir, "games", generation, "modules", "alicesoft", "saves");
  fs.mkdirSync(releasedSaveRoot, { recursive: true });
  return { entry, userDataDir, contentRootDir, releasedSaveRoot, environment: { HOME: home } };
}

test("released unconfigured System3 save bytes reach the native cwd and differing original bytes survive", async t => {
  const f = fixture(t, "system3");
  const saved = Buffer.from([0, 1, 255, 42, 73]);
  fs.writeFileSync(path.join(f.releasedSaveRoot, "ASLEEP_A.DAT"), saved);
  fs.writeFileSync(path.join(f.releasedSaveRoot, "ASLEEP_B.DAT"), "released private slot");
  fs.writeFileSync(path.join(f.contentRootDir, "ASLEEP_B.DAT"), "original slot");
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(descriptor.mirrorRoot, f.releasedSaveRoot);
  assert.equal(descriptor.sourceRoot, f.contentRootDir);
  const result = await retireLegacyGameMirror(descriptor, f);
  assert.equal(result.complete, true);
  assert.deepEqual(fs.readFileSync(path.join(f.contentRootDir, "ASLEEP_A.DAT")), saved);
  assert.equal(fs.readFileSync(path.join(f.contentRootDir, "ASLEEP_B.DAT"), "utf8"), "original slot");
  const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(f.contentRootDir, "ASLEEP_B.DAT.MacLauncher-conflict-")));
  assert.ok(conflict);
  assert.equal(fs.readFileSync(conflict, "utf8"), "released private slot");
  assert.equal(fs.existsSync(f.releasedSaveRoot), false);
});

test("released configured System3 saves stay retained when the native target is unresolved", async t => {
  const f = fixture(t, "system3");
  fs.writeFileSync(path.join(f.contentRootDir, "system3.ini"), "[config]\nsavedir = Authored/@\n");
  fs.writeFileSync(path.join(f.releasedSaveRoot, "ASLEEP_A.DAT"), "released save");
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(descriptor.sourceRoot, null);
  const result = await retireLegacyGameMirror(descriptor, f);
  assert.equal(result.complete, false);
  assert.equal(fs.readFileSync(path.join(f.releasedSaveRoot, "ASLEEP_A.DAT"), "utf8"), "released save");
  assert.equal(fs.existsSync(path.join(f.contentRootDir, "ASLEEP_A.DAT")), false);
});

for (const generation of ["system35", "system4"]) {
  test(`released ${generation} native-policy gap retains actual save bytes instead of moving them to the game root`, async t => {
    const f = fixture(t, generation), name = generation === "system35" ? "ExampleSA.asd" : "Save000.asd";
    const saved = Buffer.from([5, 4, 3, 2, 1]);
    fs.writeFileSync(path.join(f.releasedSaveRoot, name), saved);
    const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
    assert.equal(descriptor.mirrorRoot, f.releasedSaveRoot);
    assert.equal(descriptor.sourceRoot, null);
    const result = await retireLegacyGameMirror(descriptor, f);
    assert.equal(result.complete, false);
    assert.deepEqual(fs.readFileSync(path.join(f.releasedSaveRoot, name)), saved);
    assert.equal(fs.existsSync(path.join(f.contentRootDir, name)), false);
  });
}

test("one-time migration declares only obsolete saves and preserves explicit overrides and debugger state", t => {
  const f = fixture(t, "system3"), userDataDir = f.userDataDir;
  const contentRootDir = path.join(f.contentRootDir, "absent-game");
  const context = { userDataDir, environment: f.environment };
  const entry = { gameId: "example", contentRootDir, moduleData: { generation: "system3" } };
  const mirrorRoot = path.join(userDataDir, "games", "example", "modules", "alicesoft", "saves");
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, context), [{ mirrorRoot, sourceRoot: contentRootDir, generated: [], createSourceWithin: f.contentRootDir }]);
  assert.equal(fs.existsSync(contentRootDir), false, "describing a safe creation anchor creates no game directory");
  entry.moduleData.generation = "system4";
  assert.equal(Backcompat.legacyGameMirrors(entry, context)[0].sourceRoot, null, "native HOME policy must not be guessed");
  entry.saveDirOverride = mirrorRoot;
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, context), []);
  delete entry.saveDirOverride;
  entry.moduleData.generation = "system35";
  assert.equal(Backcompat.legacyGameMirrors(entry, context)[0].sourceRoot, null, "still-used debugger saves remain retained and reported");
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, { userDataDir: "relative" }), []);
});

async function recoverAt(t, generation, setup) {
  const f = fixture(t, generation), destination = setup(f);
  fs.mkdirSync(destination, { recursive: true });
  const saved = Buffer.from([0, 255, 13, 27]);
  const slot = generation === "system3" ? "ASLEEP_A.DAT" : generation === "system35" ? "ExampleSA.asd" : "slot.dat";
  const existing = generation === "system3" ? "ASLEEP_B.DAT" : generation === "system35" ? "ExampleSB.asd" : "existing.dat";
  fs.writeFileSync(path.join(f.releasedSaveRoot, slot), saved);
  fs.writeFileSync(path.join(f.releasedSaveRoot, existing), "released conflict");
  fs.writeFileSync(path.join(destination, existing), "original conflict");
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(descriptor.sourceRoot, destination, descriptor.unresolvedReason);
  const result = await retireLegacyGameMirror(descriptor, f);
  assert.equal(result.complete, true, result.reason);
  assert.deepEqual(fs.readFileSync(path.join(destination, slot)), saved);
  assert.equal(fs.readFileSync(path.join(destination, existing), "utf8"), "original conflict");
  const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(destination, existing + ".MacLauncher-conflict-")));
  assert.ok(conflict);
  assert.equal(fs.readFileSync(conflict, "utf8"), "released conflict");
  if (descriptor.retainMirror) assert.deepEqual(fs.readFileSync(path.join(f.releasedSaveRoot, slot)), saved, "current explicit debugger still reads these bytes");
  return f;
}

test("resolved configured System3 relative and absolute literal save folders receive released bytes and preserve conflicts", async t => {
  for (const absolute of [false, true]) await t.test(absolute ? "absolute" : "relative", async st => {
    await recoverAt(st, "system3", f => {
      const destination = path.join(f.contentRootDir, "Authored", "Slots");
      const setting = absolute ? destination : "Authored\\Slots";
      fs.writeFileSync(path.join(f.contentRootDir, "system3.ini"), "[config]\nsavedir = ignored\n[string]\nsavedir = not-config\n[config]\nsavedir = " + setting + "\n");
      return destination;
    });
  });
});

test("resolved System4 native HOME, XDG and XSYSTEM4_HOME precedence receives released bytes and preserves conflicts", async t => {
  for (const kind of ["HOME", "XDG_DATA_HOME", "XSYSTEM4_HOME"]) await t.test(kind, async st => {
    await recoverAt(st, "system4", f => {
      f.environment.XDG_DATA_HOME = kind === "HOME" ? "" : path.join(f.environment.HOME, "xdg");
      f.environment.XSYSTEM4_HOME = kind === "XSYSTEM4_HOME" ? path.join(f.environment.HOME, "explicit") : "";
      fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'GameName = "Example"\nCodeName = "Game.ain"\nSaveFolder = "Authored"\n');
      const nativeHome = f.environment.XSYSTEM4_HOME || (f.environment.XDG_DATA_HOME ? path.join(f.environment.XDG_DATA_HOME, "xsystem4") : path.join(f.environment.HOME, ".xsystem4"));
      return path.join(nativeHome, "Example", "Authored");
    });
  });
});

test("resolved System4 user config overrides use global cwd and then game-relative paths without reading Formation fields", async t => {
  await recoverAt(t, "system4", f => {
    const nativeHome = path.join(f.environment.HOME, ".xsystem4"); fs.mkdirSync(nativeHome);
    fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\nFormation "ignored" { SaveFolder = "wrong" }\n');
    fs.writeFileSync(path.join(nativeHome, ".xsys4rc"), 'save-folder = "global-relative"\n');
    fs.writeFileSync(path.join(f.contentRootDir, ".xsys4rc"), 'save-folder = "Game Saves" // local wins\n');
    return path.join(f.contentRootDir, "Game Saves");
  });
  await recoverAt(t, "system4", f => {
    const nativeHome = path.join(f.environment.HOME, ".xsystem4"); fs.mkdirSync(nativeHome);
    fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\n');
    fs.writeFileSync(path.join(nativeHome, ".xsys4rc"), 'save-folder = "global-relative"\n');
    return path.join(f.contentRootDir, "global-relative");
  });
});

test("resolved explicit external override receives released bytes even for System35 without retiring debugger defaults by guess", async t => {
  await recoverAt(t, "system35", f => {
    f.entry.saveDirOverride = path.join(f.environment.HOME, "Explicit Saves");
    return f.entry.saveDirOverride;
  });
});

test("resolved System4 fallback names and Shift-JIS GameName match native get_save_path", async t => {
  await recoverAt(t, "system4", f => {
    const sjisName = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
    fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), Buffer.concat([Buffer.from('CodeName = "Game.ain"\nGameName = "'), sjisName, Buffer.from('"\n')]));
    return path.join(f.environment.HOME, ".xsystem4", "テスト", "SaveData");
  });
  await recoverAt(t, "system4", f => {
    fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\n');
    return path.join(f.environment.HOME, ".xsystem4", "Game.ain", "SaveData");
  });
});

test("resolved System35 default and authored HOME/game profiles restore native slots while keeping debugger bytes", async t => {
  for (const setting of ["default", "relative", "tilde"]) await recoverAt(t, "system35", f => {
    fs.writeFileSync(path.join(f.contentRootDir, "ExampleSA.ALD"), "scenario name fixture");
    if (setting === "default") return f.contentRootDir;
    fs.writeFileSync(path.join(f.environment.HOME, ".xsys35rc"), "savedir: ignored-global\n");
    fs.writeFileSync(path.join(f.contentRootDir, ".xsys35rc"), "save dir: ignored-key\nsavedir: " + (setting === "tilde" ? "~/Authored" : "Authored") + "\n");
    return path.join(setting === "tilde" ? f.environment.HOME : f.contentRootDir, "Authored");
  });
});

test("resolved System35 existing asleep naming collision remains precisely diagnosed and untouched", async t => {
  const f = fixture(t, "system35");
  fs.writeFileSync(path.join(f.contentRootDir, "ExampleSA.ALD"), "scenario name fixture");
  fs.writeFileSync(path.join(f.contentRootDir, "asleep.asd"), "native save");
  fs.writeFileSync(path.join(f.releasedSaveRoot, "ExampleSA.asd"), "released prefix save");
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(descriptor.sourceRoot, null);
  assert.match(descriptor.unresolvedReason, /different slot names/);
  assert.equal((await retireLegacyGameMirror(descriptor, f)).complete, false);
  assert.equal(fs.readFileSync(path.join(f.contentRootDir, "asleep.asd"), "utf8"), "native save");
  assert.equal(fs.readFileSync(path.join(f.releasedSaveRoot, "ExampleSA.asd"), "utf8"), "released prefix save");
});

test("native guard refinements retain exact ambiguous inputs instead of accepting a guessed destination", t => {
  const f = fixture(t, "system4");
  fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\nFormation "bad" { SaveFolder = "wrong", }\n');
  assert.match(Backcompat.legacyGameMirrors(f.entry, f)[0].unresolvedReason, /trailing comma/);
  fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\nViewWidth[1.5] = 10\n');
  assert.match(Backcompat.legacyGameMirrors(f.entry, f)[0].unresolvedReason, /index must be an integer/);
  f.entry.saveDirOverride = path.join(f.environment.HOME, "explicit");
  f.entry.launchArguments = '-savedir "different-native-option"';
  assert.match(Backcompat.legacyGameMirrors(f.entry, f)[0].unresolvedReason, /Native launch arguments/);
  const g = fixture(t, "system35");
  fs.writeFileSync(path.join(g.contentRootDir, "ExampleSA.ALD"), "scenario");
  fs.writeFileSync(path.join(g.contentRootDir, "DifferentSB.ALD"), "other scenario");
  assert.match(Backcompat.legacyGameMirrors(g.entry, g)[0].unresolvedReason, /one unambiguous scenario prefix/);
});

test("native command-line path guard permits unrelated options and names the unresolved override", t => {
  const f = fixture(t, "system3");
  f.entry.launchArguments = "-fullscreen -noantialias";
  assert.equal(Backcompat.legacyGameMirrors(f.entry, f)[0].sourceRoot, f.contentRootDir);
  f.entry.launchArguments = '-savedir "chosen elsewhere"';
  const [blocked] = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(blocked.sourceRoot, null);
  assert.match(blocked.unresolvedReason, /select -savedir/);
});

test("fresh native System4 save folders receive released bytes only when the old folder exists", async t => {
  const f = fixture(t, "system4");
  fs.writeFileSync(path.join(f.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\nGameName = "Example"\n');
  const destination = path.join(f.environment.HOME, ".xsystem4", "Example", "SaveData");
  fs.writeFileSync(path.join(f.releasedSaveRoot, "slot.dat"), "released slot");
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f);
  assert.equal(descriptor.sourceRoot, destination);
  assert.equal(descriptor.createSourceWithin, f.environment.HOME);
  assert.equal(fs.existsSync(destination), false, "descriptor reading performs no directory creation");
  const result = await retireLegacyGameMirror(descriptor, f);
  assert.equal(result.complete, true, result.reason);
  assert.equal(fs.readFileSync(path.join(destination, "slot.dat"), "utf8"), "released slot");
  assert.equal(fs.existsSync(f.releasedSaveRoot), false);
  const empty = fixture(t, "system4");
  fs.writeFileSync(path.join(empty.contentRootDir, "System40.ini"), 'CodeName = "Game.ain"\n');
  fs.rmdirSync(empty.releasedSaveRoot);
  const [missing] = Backcompat.legacyGameMirrors(empty.entry, empty);
  assert.equal((await retireLegacyGameMirror(missing, empty)).complete, true);
  assert.equal(fs.existsSync(missing.sourceRoot), false, "no native target is created for a game without released private saves");
});
