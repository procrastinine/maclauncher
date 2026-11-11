const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const Preparation = require("../src/modules/vnds/prepare");
const Runtime = require("../src/modules/vnds/runtime/manager");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
// The package producer and packer belong to the separate MacLauncher Builds project.
const builds = require("./helpers/builds-checkout.cjs").buildsCheckout("producers/engine-adaptations/stage.mjs", "tools/runtime-package.mjs");
const buildsStage = path.join(builds.root, "producers/engine-adaptations/stage.mjs");
const buildsPackage = path.join(builds.root, "tools/runtime-package.mjs");
const skip = builds.skip;
function inventory(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(item => {
    const file = path.join(root, item.name);
    return item.isDirectory() ? inventory(file).map(([name, hash]) => [item.name + "/" + name, hash]) : [[item.name, sha256(fs.readFileSync(file))]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t, { version, revision, catalogRevision, sourceRepository = "ajusa/VNDS-LOVE" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vnds-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stageData } = await import(pathToFileURL(buildsStage));
  const { pack, catalog } = await import(pathToFileURL(buildsPackage));
  const input = path.join(root, "input"), declaration = stageData({ project: "vnds-love", output: input, ...(version ? { version } : {}) });
  const manifestPath = path.join(input, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (revision) {
    manifest.sourceRevision = revision;
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(manifestPath, bytes);
    declaration.sourceSha256 = declaration.manifestSha256 = sha256(bytes);
    Object.assign(declaration.files.find(file => file.path === "manifest.json"), { sha256: sha256(bytes), size: bytes.length });
  }
  const archive = path.join(root, `vnds-love-${declaration.version}-universal.tar.gz`);
  const record = await pack({ project: "vnds-love", input, declaration, output: archive,
    ...(revision ? { metadata: { source: { repository: "ajusa/VNDS-LOVE", revision } } } : {}) });
  if (catalogRevision) record.source = { repository: sourceRepository, revision: catalogRevision };
  const selectedCatalog = catalog([record], { project: "vnds-love", repository: "procrastinine/maclauncher-builds" });
  const userDataDir = path.join(root, "data");
  const manager = Runtime.createManager({ systemVersionSync: () => "26.0", fetchUrlBuffer: async () => ({ status: 200, body: Buffer.from(JSON.stringify(selectedCatalog)) }),
    downloadToFile: async (_url, destination) => fs.copyFileSync(archive, destination) });
  await manager.installRuntime({ userDataDir, version: declaration.version });
  const context = { userDataDir, settings: { runtimes: { "vnds-love": { defaultVersion: declaration.version } } } }, engine = Preparation.verifyEngine(context).root;
  return { root, userDataDir, context, engine, version: declaration.version, sourceRevision: manifest.sourceRevision };
}
test("VNDS verifies its managed interpreter without app resources or source fallbacks", { skip }, async t => {
  const f = await fixture(t), selected = Preparation.verifyEngine(f.context);
  assert.equal(selected.root, f.engine);
  assert.equal(selected.profile.version, f.version);
  assert.equal(selected.profile.sourceRevision, f.sourceRevision);
  assert.equal(selected.profile.loveVersion, "11.5");
  assert.ok(!f.engine.includes("app.asar"));
  assert.throws(() => Preparation.verifyEngine({ userDataDir: path.join(f.root, "missing"), settings: f.context.settings, resourcesRoot: path.resolve(__dirname, "../src") }), /not installed|not available|Install|Refresh|missing/i);
});
test("VNDS accepts later compatible packages and records differing source identities", { skip }, async t => {
  const f = await fixture(t, { version: "0.0.14-fixture-MCLv1", revision: "b".repeat(40) });
  const selected = Preparation.verifyEngine(f.context);
  assert.equal(selected.profile.version, f.version);
  assert.equal(selected.profile.sourceRevision, "b".repeat(40));
  assert.equal(selected.profile.loveVersion, "11.5");
  assert.equal(Runtime.resolveSelection({}, {}, f.userDataDir).version, f.version);
  const mismatch = await fixture(t, { version: "0.0.14-mismatch-MCLv1", revision: "b".repeat(40), catalogRevision: "c".repeat(40) });
  assert.equal(Preparation.verifyEngine(mismatch.context).profile.sourceRevision, "b".repeat(40));
});
test("VNDS producer source identifies its build tree while the sealed interpreter retains its upstream", { skip }, async t => {
  const f = await fixture(t, {version: "0.0.14-producer-MCLv1", revision: "b".repeat(40),
    catalogRevision: "c".repeat(40), sourceRepository: "procrastinine/maclauncher-builds"});
  const selected = Preparation.verifyEngine(f.context);
  assert.equal(selected.profile.sourceRevision, "b".repeat(40));
  assert.equal(selected.profile.loveVersion, "11.5");
});
for (const name of ["lib/json.lua", "main.lua", "conf.lua"]) test(`VNDS does not pin installed managed adapter bytes: ${name}`, { skip }, async t => {
  const f = await fixture(t), file = path.join(f.engine, name), changed = fs.readFileSync(file); changed[0] ^= 1; fs.writeFileSync(file, changed);
  assert.equal(Preparation.verifyEngine(f.context).root, f.engine);
});
test("VNDS preparations share one immutable managed interpreter and preserve original games", { skip }, async t => {
  const f = await fixture(t), beforeEngine = inventory(f.engine), prepared = [];
  t.mock.method(os, "homedir", () => path.join(f.root, "home"));
  for (const gameId of ["first", "second"]) {
    const gamePath = path.join(f.root, gameId); fs.mkdirSync(path.join(gamePath, "script"), { recursive: true });
    fs.writeFileSync(path.join(gamePath, "script", "main.scr"), "text Example\n"); fs.writeFileSync(path.join(gamePath, "global.json"), JSON.stringify({ flag: gameId }));
    const before = inventory(gamePath); prepared.push(await Preparation.prepare({ gameId, gamePath }, f.context));
    assert.deepEqual(inventory(gamePath), before);
    assert.equal(prepared.at(-1).working, gamePath);
    assert.equal(prepared.at(-1).saveDirectory, path.join(os.homedir(), "Library", "Application Support", "LOVE", "VNDS-LOVE", "novels", gameId));
    assert.equal(fs.existsSync(path.join(prepared.at(-1).saveDirectory, "global.json")), false, "Play does not import original saves into a private tree");
  }
  assert.deepEqual(prepared.map(item => item.engine), [f.engine, f.engine]);
  assert.notEqual(prepared[0].working, prepared[1].working); assert.notEqual(prepared[0].saveDirectory, prepared[1].saveDirectory);
  assert.deepEqual(inventory(f.engine), beforeEngine);
  assert.equal(inventory(path.join(f.userDataDir, "games")).some(([name]) => name.endsWith(".lua")), false);
});

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vnds-paths-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  const gamePath = path.join(root, "Original Novel"), context = { userDataDir: path.join(root, "profile") };
  fs.mkdirSync(gamePath);
  return { root, gamePath, context, entry: { gameId: "novel", gamePath },
    engine: () => ({ root: path.join(root, "shared-interpreter"), profile: { version: "fixture" } }) };
}

test("VNDS uses upstream user saves and original cwd without a root save scan or warm mount rewrite", async t => {
  const f = scratch(t), original = fs.readdirSync;
  fs.writeFileSync(path.join(f.gamePath, "global.json"), "original bytes need no eager validation");
  t.mock.method(fs, "readdirSync", function(directory, ...args) {
    assert.notEqual(path.resolve(directory), f.gamePath, "Preparation must not enumerate original root saves");
    return original.call(this, directory, ...args);
  });
  const first = await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  assert.equal(first.working, f.gamePath);
  assert.equal(first.saveRoot, Preparation.defaultSaveDirectory(f.entry));
  assert.equal(first.saveRoot.startsWith(f.context.userDataDir + path.sep), false);
  assert.equal(fs.existsSync(path.join(first.saveRoot, "global.json")), false);
  assert.equal(fs.existsSync(path.join(Preparation.moduleRoot(f.entry, f.context), "saves")), false);
  const held = new Date("2020-01-01T00:00:00Z"); fs.utimesSync(first.mountFile, held, held);
  const before = fs.statSync(first.mountFile).mtimeMs;
  const second = await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  assert.equal(fs.statSync(second.mountFile).mtimeMs, before);
  assert.equal(fs.readFileSync(path.join(f.gamePath, "global.json"), "utf8"), "original bytes need no eager validation");
});

test("VNDS retains validated ZIP mounts, audio conversion deduplication and explicit saves", async t => {
  const f = scratch(t), { writeZipArchive } = require("./helpers/zip-fixture");
  writeZipArchive(path.join(f.gamePath, "script.zip"), [{ name: "main.scr", data: "text Original" }]);
  const sound = path.join(f.gamePath, "sound"); fs.mkdirSync(sound); fs.writeFileSync(path.join(sound, "voice.m4a"), "AAC bytes");
  f.entry.saveDirOverride = path.join(f.root, "Custom Saves"); let conversions = 0;
  const dependencies = { resolveEngine: f.engine, run: async (_executable, args) => {
    conversions++; fs.writeFileSync(args.at(-1), "fLaC fixture");
  } };
  const first = await Preparation.prepare(f.entry, f.context, dependencies);
  assert.equal(first.saveRoot, f.entry.saveDirOverride);
  const mounts = JSON.parse(fs.readFileSync(first.mountFile, "utf8"));
  assert.equal(mounts[0].path, path.join(f.gamePath, "script.zip"));
  assert.equal(mounts[0].point, "novels/game/script");
  assert.equal(mounts[1].point, "novels/game/sound");
  await Preparation.prepare(f.entry, f.context, dependencies);
  assert.equal(conversions, 1, "Matching source and converted bytes reuse the real conversion");
  writeZipArchive(path.join(f.gamePath, "script.zip"), [{ name: "../escape.scr", data: "text Invalid" }]);
  await assert.rejects(Preparation.prepare(f.entry, f.context, dependencies), /unsupported paths/);
});

test("VNDS old private saves migrate once without replacing upstream conflicts or active overrides", async t => {
  const f = scratch(t), mod = require("../src/modules/vnds/backcompat");
  const [descriptor] = mod.legacyGameMirrors(f.entry, f.context);
  assert.equal(descriptor.sourceRoot, Preparation.defaultSaveDirectory(f.entry));
  assert.equal(fs.existsSync(Preparation.moduleRoot(f.entry, f.context)), false, "Descriptors do no disk work");
  fs.mkdirSync(descriptor.mirrorRoot, { recursive: true }); fs.mkdirSync(descriptor.sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(descriptor.mirrorRoot, "save1.json"), "private slot");
  fs.writeFileSync(path.join(descriptor.sourceRoot, "save1.json"), "upstream slot");
  fs.writeFileSync(path.join(descriptor.mirrorRoot, "global.json"), "unique globals");
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, f.context);
  assert.equal(result.complete, true);
  assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, "save1.json"), "utf8"), "upstream slot");
  assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, "global.json"), "utf8"), "unique globals");
  const conflicts = fs.readdirSync(descriptor.sourceRoot).filter(name => name.startsWith("save1.json.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1); assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, conflicts[0]), "utf8"), "private slot");
  assert.equal(fs.existsSync(descriptor.mirrorRoot), false);
  for (const saveDirOverride of [descriptor.mirrorRoot, path.join(descriptor.mirrorRoot, "nested"), path.dirname(descriptor.mirrorRoot)])
    assert.deepEqual(mod.legacyGameMirrors({ ...f.entry, saveDirOverride }, f.context), [], "Explicit overrides keep their live trees");
});


test("VNDS shared import policy changes only an actual same-basename save collision", async t => {
  const f = scratch(t), mod = require("../src/modules/vnds/main");
  const { applySaveIdentity } = require("../src/core/save-identity");
  const describe = entry => mod.resolveSaveIdentity(entry, f.context);
  const make = (gameId, folder) => {
    const entry = { gameId, gamePath: path.join(f.root, gameId, folder) };
    fs.mkdirSync(entry.gamePath, { recursive: true }); mod.onImport(entry, f.context); return entry;
  };
  const first = make("first-novel", "game"), firstBefore = structuredClone(first);
  assert.equal(first.saveDirOverride, undefined, "onImport leaves the upstream default alone");
  assert.equal(applySaveIdentity(first, { games: [], describe, context: f.context }), first);
  assert.deepEqual(first, firstBefore);
  const firstPlan = await Preparation.prepare(first, f.context, { resolveEngine: f.engine });
  fs.writeFileSync(path.join(firstPlan.saveRoot, "global.json"), '{"owner":"upstream-first"}');
  const second = make("second-novel", "game");
  assert.equal(describe(first).identity, describe(second).identity, "The two actual defaults collide");
  const secondPatched = applySaveIdentity(second, { games: [first], describe, context: f.context });
  assert.equal(second.saveDirOverride, undefined, "The shared core returns an ordinary setting delta without mutating the source");
  assert.equal(secondPatched.saveDirOverride, path.join(path.dirname(firstPlan.saveRoot), second.gameId));
  assert.equal(describe(secondPatched).explicit, true);
  const secondPlan = await Preparation.prepare(secondPatched, f.context, { resolveEngine: f.engine });
  assert.notEqual(secondPlan.saveRoot, firstPlan.saveRoot);
  assert.equal(fs.existsSync(path.join(secondPlan.saveRoot, "global.json")), false, "No shared saves are guessed or copied");
  assert.equal(fs.readFileSync(path.join(firstPlan.saveRoot, "global.json"), "utf8"), '{"owner":"upstream-first"}');
  const third = make("third-novel", "another-game"), thirdBefore = structuredClone(third);
  assert.equal(applySaveIdentity(third, { games: [first, secondPatched], describe, context: f.context }), third);
  assert.deepEqual(third, thirdBefore, "A noncolliding default remains exactly unchanged");
  const explicit = { ...third, gameId: "explicit-novel", saveDirOverride: path.join(f.root, "Chosen Saves") };
  mod.onImport(explicit, f.context);
  assert.equal(describe(explicit).identity, explicit.saveDirOverride);
  assert.equal(applySaveIdentity(explicit, { games: [first, secondPatched], describe, context: f.context }), explicit);
});
