const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Inno = require("../src/modules/shared/installers/inno");
const Header = require("../src/modules/shared/installers/inno-header");
const { createManager } = require("../src/modules/shared/installers/runtime/innoextract-manager");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-inno-receipts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), userDataDir = path.join(root, "profile"), tools = path.join(root, "reader");
  fs.mkdirSync(source); fs.mkdirSync(tools);
  const file = path.join(source, "setup.exe"), slice = path.join(source, "setup-1.bin");
  const loader = Buffer.alloc(256); loader.write("MZ");
  loader.writeUInt32LE(0x6f6e6e49, 0x30); loader.writeUInt32LE(64, 0x34); loader.writeUInt32LE(~64 >>> 0, 0x38);
  Buffer.from("72446c507453cde6d77b0b2a", "hex").copy(loader, 64);
  loader.writeUInt32LE(1, 76); loader.writeUInt32LE(128, 96); loader.writeUInt32LE(0, 100);
  loader.writeUInt32LE(Header.crc32(loader.subarray(64, 104)), 104); loader.write("Inno Setup Setup Data (5.5.7) (u)", 128);
  fs.writeFileSync(file, loader); fs.writeFileSync(slice, "original installer data");
  const executable = path.join(tools, "reader"); fs.writeFileSync(executable, "Reader bytes: must never execute during receipt conversion.");
  const version = "fixture-v1", sourceRevision = "a".repeat(40), manifest = JSON.stringify({ version });
  fs.writeFileSync(path.join(tools, "bundle-manifest.json"), manifest);
  const helper = { version, sourceRevision, executable, inspector: executable, identity: sha(manifest) };
  const sources = [file, slice].map(path => ({ path, identity: Inno.identity(path) }));
  const key = Inno.cacheKey(helper.identity, sources), cache = path.join(userDataDir, "games", "testgame", "containers", "inno");
  const generation = path.join(cache, key), game = path.join(generation, "files");
  fs.mkdirSync(game, { recursive: true });
  const script = path.join(game, "game.hcb"); fs.writeFileSync(script, "original extracted script");
  const receipt = { schemaVersion: 1, key, format: "inno", formatVersion: "5.5.7 (unicode)", helperVersion: version,
    helperIdentity: helper.identity, sources, files: [{ path: "game.hcb", size: fs.statSync(script).size, identity: Inno.identity(script) }], extractedBytes: fs.statSync(script).size };
  const receiptFile = path.join(generation, "receipt.json"), indexFile = path.join(cache, "current.json");
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 1, key, helperIdentity: helper.identity, sourceIdentity: sources[0].identity, sources }));
  fs.writeFileSync(script, "a user's modified script, with different size");
  fs.mkdirSync(path.join(game, "save")); fs.writeFileSync(path.join(game, "save/slot1"), "sole player progress");
  const manager = createManager();
  t.mock.method(manager, "resolveSelection", () => ({ ready: true, install: {
    version, upstreamRevision: sourceRevision, runtimePath: executable, runtimeFiles: { inspector: "reader" }, installDir: tools,
    bundledManifestSha256: helper.identity
  } }));
  const entry = { gameId: "testgame", moduleId: "fixture", gamePath: game, contentRootDir: game, importPath: file,
    containerData: { format: "inno", version: receipt.formatVersion, sourcePath: file, key, extractedRoot: game, sources } };
  const registry = { getModule: () => ({}), listSharedRuntimeManagers: () => [manager] };
  return { root, source, userDataDir, file, slice, executable, helper, key, generation, cache, game, script,
    receipt, receiptFile, indexFile, entry, manager, registry, options: { userDataDir, gameId: entry.gameId, helper } };
}

test("shared migration converts once, preserves mutable game bytes, and warm reuse reads only current receipts", async t => {
  const f = fixture(t), originalReceipt = fs.readFileSync(f.receiptFile), hashed = [];
  let protectGame = true, calls = 0;
  const inside = file => typeof file === "string" && (file === f.game || file.startsWith(f.game + path.sep));
  for (const [owner, method] of [[fs, "readdirSync"], [fs.promises, "readdir"], [fs, "readFileSync"]]) {
    const original = owner[method];
    t.mock.method(owner, method, function (file, ...args) {
      assert.equal(protectGame && inside(file), false, "Conversion/reuse must not read or enumerate the mutable game");
      return original.call(this, file, ...args);
    });
  }
  const stream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", function (file, ...args) {
    assert.equal(inside(file), false, "Historical extracted checksums must not be reconstructed");
    hashed.push(file); return stream.call(this, file, ...args);
  });
  const migrate = f.manager.migrateLegacyGameData;
  t.mock.method(f.manager, "migrateLegacyGameData", (...args) => { calls++; return migrate(...args); });
  let settings = {}, persisted;
  const run = () => runDataMigrations({ settings, games: [f.entry], registry: f.registry, userDataDir: f.userDataDir,
    saveSettings: next => { settings = next; }, saveEntry: entry => { persisted = structuredClone(entry); } });
  const result = await run(); assert.equal(result.complete, true); assert.deepEqual(result.pendingIds, []);
  assert.equal(calls, 1); assert.equal(persisted.gamePath, f.game); assert.equal(persisted.contentRootDir, f.game);
  assert.ok(persisted.containerData.sources.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  const index = JSON.parse(fs.readFileSync(f.indexFile)); assert.equal(index.schemaVersion, 2); assert.equal(index.key, f.key);
  assert.match(index.receiptFile, /^receipt-[a-f0-9]{64}\.json$/);
  const bytes = fs.readFileSync(path.join(f.generation, index.receiptFile));
  assert.equal(index.receiptFile, "receipt-" + sha(bytes) + ".json");
  const converted = JSON.parse(bytes);
  assert.deepEqual(converted.files, f.receipt.files); assert.equal(converted.files[0].sha256, undefined);
  assert.equal(converted.legacyGeneration.key, f.key); assert.deepEqual(fs.readFileSync(f.receiptFile), originalReceipt);
  for (const file of [f.file, f.slice]) assert.equal(hashed.filter(item => item === file).length, 1);
  await run(); assert.equal(calls, 1, "Completed migration never invokes the manager again");
  const streamsBefore = hashed.length;
  const warm = await Inno.prepareInstaller(f.file, f.options);
  assert.equal(warm.inputPath, f.game); assert.equal(warm.containerData.cached, true);
  assert.ok(hashed.slice(streamsBefore).every(file => file === f.executable), "Warm reuse hashes no archive or game files");
  protectGame = false;
  assert.equal(fs.readFileSync(f.script, "utf8"), "a user's modified script, with different size");
  assert.equal(fs.readFileSync(path.join(f.game, "save/slot1"), "utf8"), "sole player progress");
});

test("unconverted schema1 never causes extraction, and changed source/helper/metadata cannot authorize conversion", async t => {
  for (const mutation of ["inode", "helper", "path", "key"]) {
    const f = fixture(t);
    await assert.rejects(Inno.prepareInstaller(f.file, f.options), { code: "INSTALLER_CACHE_RECHECK_REQUIRED" });
    if (mutation === "inode") {
      fs.copyFileSync(f.slice, f.slice + ".new"); fs.renameSync(f.slice + ".new", f.slice);
    } else if (mutation === "helper") f.helper = { ...f.helper, identity: "b".repeat(64) };
    else {
      const receipt = JSON.parse(fs.readFileSync(f.receiptFile));
      if (mutation === "path") receipt.files[0].path = "../outside";
      else receipt.key = "c".repeat(64);
      fs.writeFileSync(f.receiptFile, JSON.stringify(receipt));
    }
    const indexBefore = fs.readFileSync(f.indexFile), receiptBefore = fs.readFileSync(f.receiptFile);
    await assert.rejects(f.manager.migrateLegacyGameData(f.entry, { userDataDir: f.userDataDir, helper: f.helper }), { code: "INSTALLER_CACHE_INVALID" });
    assert.deepEqual(fs.readFileSync(f.indexFile), indexBefore); assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore);
    assert.equal(fs.readFileSync(path.join(f.game, "save/slot1"), "utf8"), "sole player progress");
  }
});

test("historical unhashed facts require the labeled metadata predicate and never waive a present invalid hash", async t => {
  const f = fixture(t);
  await f.manager.migrateLegacyGameData(f.entry, { userDataDir: f.userDataDir, helper: f.helper });
  const index = JSON.parse(fs.readFileSync(f.indexFile)), receipt = JSON.parse(fs.readFileSync(path.join(f.generation, index.receiptFile)));
  const validate = (value, current = index) => Inno.validateCacheReceipt(value, current, { file: f.file, probe: Header.probeInno(f.file), helper: f.helper });
  validate(receipt);
  const fresh = structuredClone(receipt); delete fresh.legacyGeneration; fresh.key = fresh.contentKey;
  assert.throws(() => validate(fresh, { ...index, key: index.contentKey }), { code: "INSTALLER_CACHE_INVALID" });
  for (const mutate of [value => { value.legacyGeneration.helperIdentity = "invalid"; },
    value => { value.legacyGeneration.key = "e".repeat(64); }, value => { value.files[0].sha256 = "invalid"; }]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => validate(changed), { code: "INSTALLER_CACHE_INVALID" });
  }
});

test("an atomic pointer failure preserves original metadata/game and is recorded once without automatic retry", async t => {
  const f = fixture(t), indexBefore = fs.readFileSync(f.indexFile), receiptBefore = fs.readFileSync(f.receiptFile);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (from, to) {
    if (to === f.indexFile) throw Object.assign(new Error("Fixture pointer write denied"), { code: "EACCES" });
    return rename.call(this, from, to);
  });
  let settings = {}, calls = 0;
  const migrate = f.manager.migrateLegacyGameData;
  t.mock.method(f.manager, "migrateLegacyGameData", (...args) => { calls++; return migrate(...args); });
  const run = () => runDataMigrations({ settings, games: [f.entry], registry: f.registry, userDataDir: f.userDataDir,
    saveSettings: next => { settings = next; }, saveEntry: () => {}, logger: { warn() {} } });
  const result = await run(); assert.deepEqual(result.pendingIds, [f.entry.gameId]);
  assert.deepEqual(fs.readFileSync(f.indexFile), indexBefore); assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore);
  assert.equal(f.entry.containerData.sources[0].sha256, undefined);
  assert.equal(fs.readFileSync(path.join(f.game, "save/slot1"), "utf8"), "sole player progress");
  await run(); assert.equal(calls, 1);
  await assert.rejects(Inno.prepareInstaller(f.file, f.options), { code: "INSTALLER_CACHE_RECHECK_REQUIRED" });
});
