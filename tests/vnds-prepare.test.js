const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const Preparation = require("../src/modules/vnds/prepare");
const Runtime = require("../src/modules/vnds/runtime/manager");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function inventory(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(item => {
    const file = path.join(root, item.name);
    return item.isDirectory() ? inventory(file).map(([name, hash]) => [item.name + "/" + name, hash]) : [[item.name, sha256(fs.readFileSync(file))]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t, { version, revision, catalogRevision } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vnds-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stageData } = await import(pathToFileURL(path.resolve(__dirname, "../../maclauncher-builds/producers/engine-adaptations/stage.mjs")));
  const { pack, catalog } = await import(pathToFileURL(path.resolve(__dirname, "../../maclauncher-builds/tools/runtime-package.mjs")));
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
  if (catalogRevision) record.source = { repository: "ajusa/VNDS-LOVE", revision: catalogRevision };
  const selectedCatalog = catalog([record], { project: "vnds-love", repository: "procrastinine/maclauncher-builds" });
  const userDataDir = path.join(root, "data");
  const manager = Runtime.createManager({ systemVersionSync: () => "26.0", fetchUrlBuffer: async () => ({ status: 200, body: Buffer.from(JSON.stringify(selectedCatalog)) }),
    downloadToFile: async (_url, destination) => fs.copyFileSync(archive, destination) });
  await manager.installRuntime({ userDataDir, version: declaration.version });
  const context = { userDataDir, settings: { runtimes: { "vnds-love": { defaultVersion: declaration.version } } } }, engine = Preparation.verifyEngine(context).root;
  return { root, userDataDir, context, engine, version: declaration.version, sourceRevision: manifest.sourceRevision };
}
test("VNDS verifies its managed interpreter without app resources or source fallbacks", async t => {
  const f = await fixture(t), selected = Preparation.verifyEngine(f.context);
  assert.equal(selected.root, f.engine);
  assert.equal(selected.profile.version, f.version);
  assert.equal(selected.profile.sourceRevision, f.sourceRevision);
  assert.equal(selected.profile.loveVersion, "11.5");
  assert.ok(!f.engine.includes("app.asar"));
  assert.throws(() => Preparation.verifyEngine({ userDataDir: path.join(f.root, "missing"), settings: f.context.settings, resourcesRoot: path.resolve(__dirname, "../src") }), /not installed|Install|Refresh|missing/i);
});
test("VNDS accepts a later compatible sealed catalog revision and rejects a mismatched source identity", async t => {
  const f = await fixture(t, { version: "0.0.14-fixture-MCLv1", revision: "b".repeat(40) });
  const selected = Preparation.verifyEngine(f.context);
  assert.equal(selected.profile.version, f.version);
  assert.equal(selected.profile.sourceRevision, "b".repeat(40));
  assert.equal(selected.profile.loveVersion, "11.5");
  assert.equal(Runtime.resolveSelection({}, {}, f.userDataDir).version, f.version);
  await assert.rejects(fixture(t, { version: "0.0.14-mismatch-MCLv1", revision: "b".repeat(40), catalogRevision: "c".repeat(40) }), /unsupported interpreter profile/);
});
for (const name of ["lib/json.lua", "main.lua", "conf.lua"]) test(`VNDS rejects changed managed adapter content: ${name}`, async t => {
  const f = await fixture(t), file = path.join(f.engine, name), changed = fs.readFileSync(file); changed[0] ^= 1; fs.writeFileSync(file, changed);
  assert.throws(() => Preparation.verifyEngine(f.context), /checksum|changed|not installed/i);
});
test("VNDS preparations share one immutable managed interpreter and preserve original games", async t => {
  const f = await fixture(t), beforeEngine = inventory(f.engine), prepared = [];
  for (const gameId of ["first", "second"]) {
    const gamePath = path.join(f.root, gameId); fs.mkdirSync(path.join(gamePath, "script"), { recursive: true });
    fs.writeFileSync(path.join(gamePath, "script", "main.scr"), "text Example\n"); fs.writeFileSync(path.join(gamePath, "global.json"), JSON.stringify({ flag: gameId }));
    const before = inventory(gamePath); prepared.push(await Preparation.prepare({ gameId, gamePath }, f.context));
    assert.deepEqual(inventory(gamePath), before);
    assert.equal(fs.readFileSync(path.join(prepared.at(-1).saveDirectory, "global.json"), "utf8"), fs.readFileSync(path.join(gamePath, "global.json"), "utf8"));
  }
  assert.deepEqual(prepared.map(item => item.engine), [f.engine, f.engine]);
  assert.notEqual(prepared[0].working, prepared[1].working); assert.notEqual(prepared[0].saveDirectory, prepared[1].saveDirectory);
  assert.deepEqual(inventory(f.engine), beforeEngine);
  assert.equal(inventory(path.join(f.userDataDir, "games")).some(([name]) => name.endsWith(".lua")), false);
});
