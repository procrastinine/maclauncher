const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { writeZipArchive } = require("./helpers/zip-fixture");
const Source = require("../src/modules/love/tools/source");
const Unluac = require("../src/modules/love/tools/unluac-manager");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "love-source-tools-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "original"); fs.mkdirSync(game); fs.writeFileSync(path.join(game, "main.lua"), "return 7\n");
  return { root, game, entry: { gameId: "source-game", gamePath: game, moduleData: { retained: true } }, context: { userDataDir: path.join(root, "profile") } };
}

test("LÖVE plaintext source exports offline without acquiring a decompiler", async t => {
  const { game, entry, context } = setup(t);
  const Registry = require("../src/modules/registry");
  for (const id of ["ljd", "unluac"]) assert.equal(Registry.getRuntimeManagerUi(id).groupId, "love");
  const result = await Source.exportSource(entry, {}, context, { resolveSource: async () => game,
    ljd: { ensureTool: () => assert.fail("No LuaJIT tool is needed") }, unluac: { core: { run: () => assert.fail("No Lua tool is needed") } } });
  assert.equal(result.copied, 1); assert.equal(result.recovered, 0); assert.equal(result.failed, 0);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "source", "main.lua"), "utf8"), "return 7\n");
  assert.equal(fs.readFileSync(path.join(game, "main.lua"), "utf8"), "return 7\n");
  assert.equal(entry.moduleData.retained, true);
});

test("LÖVE selects decompilers from bytecode headers and retains failures and original bytecode", async t => {
  const { game, entry, context } = setup(t);
  const jit = Buffer.from([0x1b, 0x4c, 0x4a, 2, 0]), standard = Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x55]);
  fs.writeFileSync(path.join(game, "compiled.lua"), jit); fs.writeFileSync(path.join(game, "legacy.luac"), standard);
  let calls = 0;
  const result = await Source.exportSource(entry, {}, context, { resolveSource: async () => game,
    ljd: { ensureTool: async () => ({ version: "fixture" }), run: async (_context, args) => {
      calls++; assert.deepEqual(fs.readFileSync(args[1]), jit); fs.writeFileSync(args[3], "return 21\n");
    } }, unluac: { core: { run: async () => { throw new Error("Unsupported Lua bytecode version"); } } } });
  assert.equal(calls, 1); assert.equal(result.copied, 1); assert.equal(result.recovered, 1); assert.equal(result.failed, 1);
  assert.deepEqual(fs.readFileSync(path.join(result.outputDir, "bytecode", "legacy.luac")), standard);
  assert.deepEqual(fs.readFileSync(path.join(game, "compiled.lua")), jit);
  assert.match(JSON.parse(fs.readFileSync(path.join(result.outputDir, "export.json"))).failures[0].reason, /Unsupported/);
});

test("LÖVE root and fused ZIP source exports reject traversal while preserving prior output", async t => {
  const { root, entry, context } = setup(t), archive = path.join(root, "game.love");
  writeZipArchive(archive, [{ name: "main.lua", data: "return 1\n" }, { name: "code/extra.lua", data: "return 2\n" }]);
  const originalZip = fs.readFileSync(archive); fs.writeFileSync(archive, Buffer.concat([Buffer.alloc(64), originalZip]));
  const result = await Source.exportSource(entry, {}, context, { resolveSource: async () => archive });
  assert.equal(result.copied, 2); assert.equal(fs.readFileSync(path.join(result.outputDir, "source", "code", "extra.lua"), "utf8"), "return 2\n");
  writeZipArchive(archive, [{ name: "main.lua", data: "return 3\n" }, { name: "../escape.lua", data: "unsafe" }]);
  await assert.rejects(Source.exportSource(entry, {}, context, { resolveSource: async () => archive }), /unsafe/);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "source", "main.lua"), "utf8"), "return 1\n");
  assert.equal(fs.existsSync(path.join(root, "escape.lua")), false);
});

test("unluac discovers official RSS artifacts without a launcher version table", async t => {
  const { root, context } = setup(t), jar = path.join(root, "download.jar");
  writeZipArchive(jar, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\n" },
    { name: "LICENSE", data: "Upstream notice" }]);
  const bytes = fs.statSync(jar).size;
  assert.deepEqual(Unluac.getState(context).catalog.versions, []);
  assert.equal(Unluac.core.resolve({ userDataDir: context.userDataDir, version: "2030.03.04" }), null);
  let queries = 0;
  await Unluac.refreshCatalog({ ...context, force: true }, { fetchUrlBuffer: async url => {
    queries++; assert.equal(url, "https://sourceforge.net/projects/unluac/rss?path=/Unstable");
    return { status: 200, body: Buffer.from(`<rss><channel><item><title>Unstable/unluac_2030_03_04.jar</title>
      <enclosure url="https://sourceforge.net/projects/unluac/files/Unstable/unluac_2030_03_04.jar/download" length="${bytes}" /></item>
      <item><title>unluac_2029_01_02.jar</title><media:content fileSize="123" />
      <media:hash algo="sha256">${"b".repeat(64)}</media:hash></item></channel></rss>`) };
  } });
  const catalogFile = path.join(context.userDataDir, "runtimes/unluac/catalog.json");
  const pin = JSON.parse(fs.readFileSync(catalogFile)).entries[0];
  assert.equal(Unluac.__test.validRow(pin), true); assert.equal(pin.sha256, undefined);
  assert.equal(Unluac.__test.validRow({ ...pin, url: pin.url.replace("downloads.sourceforge.net", "example.com") }), false);
  assert.equal(Unluac.__test.validRow({ ...pin, sha256: "malformed" }), false);
  assert.deepEqual(Unluac.getState(context).catalog.versions, ["2030.03.04", "2029.01.02"]);
  let downloads = 0;
  const install = await Unluac.installRuntime({ ...context, version: pin.version, confirmRuntimeInstall: () => true }, {
    downloadToFile: async (url, target) => { downloads++; assert.equal(url, pin.url); fs.copyFileSync(jar, target); }
  });
  assert.equal(downloads, 1); assert.equal(queries, 1);
  assert.match(install.archiveSha256, /^[a-f0-9]{64}$/); assert.deepEqual(fs.readFileSync(install.jarPath), fs.readFileSync(jar));
  fs.rmSync(catalogFile);
  const reused = await Unluac.installRuntime({ ...context, version: pin.version, confirmRuntimeInstall: () => assert.fail("offline reuse prompted") }, {
    downloadToFile: () => assert.fail("offline reuse downloaded") });
  assert.equal(reused.jarPath, install.jarPath);
  fs.appendFileSync(install.jarPath, "tampered");
  assert.equal(Unluac.core.resolve({ userDataDir: context.userDataDir, version: pin.version }), null);
});

test("LJD refresh discovers exact supplier commits and preserves an explicit source choice", async t => {
  const { context } = setup(t), Ljd = require("../src/modules/love/tools/ljd-manager");
  assert.deepEqual(Ljd.getState(context).catalog.versions, []);
  const revisions = ["c".repeat(40), "d".repeat(40)];
  await Ljd.refreshCatalog(context, { fetchGithubCommits: async request => {
    assert.equal(request.owner, "dol"); assert.equal(request.repo, "luajit-decompiler");
    return revisions.map((sha, index) => ({ sha, commit: { message: `Source ${index}`, committer: { date: `2030-01-0${2-index}T00:00:00Z` } } }));
  } });
  assert.deepEqual(Ljd.getState(context).catalog.versions, revisions.map(revision => "git-" + revision));
  assert.equal(Ljd.normalizeSettings({ defaultVersion: "git-" + revisions[1] }).defaultVersion, "git-" + revisions[1]);
});
