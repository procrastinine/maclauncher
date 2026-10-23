const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const Steam = require("../src/modules/renpy/steam-consumer");
const Scripts = require("../src/modules/renpy/script-config");
const Sdk = require("../src/modules/renpy/runtime/sdk");
const Renpy = require("../src/modules/renpy/main");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "renpy-steam-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, "original"), gameDir = path.join(gameRoot, "game");
  fs.mkdirSync(gameDir, { recursive: true });
  const write = (relative, text) => { const file = path.join(gameRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const inspect = () => Steam.inspectGameSteamConsumer({ gameRoot, gameDir });
  return { root, gameRoot, gameDir, write, inspect };
}

function string(value) { const bytes = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32LE(bytes.length); return Buffer.concat([Buffer.from("X"), size, bytes]); }
function compiledPython(source, { python2 = false } = {}) {
  // Inert protocol-2 Ren'Py AST: ([metadata], [Init(block=[Python(PyCode)])]).
  const global = name => Buffer.from(`crenpy.ast\n${name}\n`);
  const field = value => python2 ? Buffer.concat([Buffer.from("T"), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(Buffer.byteLength(value)); return b; })(), Buffer.from(value)]) : string(value);
  // PyCode state is a tuple whose second item is the retained source.
  const code = Buffer.concat([global("PyCode"), Buffer.from(")\x81(N", "latin1"), string(source), Buffer.from("tb")]);
  const python = Buffer.concat([global("Python"), Buffer.from(")\x81}(", "latin1"), field("code"), code, Buffer.from("ub")]);
  const init = Buffer.concat([global("Init"), Buffer.from(")\x81}(", "latin1"), field("block"), Buffer.from("]("), python, Buffer.from("eub")]);
  const ast = Buffer.concat([Buffer.from("\x80\x02(}", "latin1"), Buffer.from("]("), init, Buffer.from("et.")]);
  const bytes = zlib.deflateSync(ast), header = Buffer.alloc(46);
  header.write("RENPY RPC2"); header.writeUInt32LE(1, 10); header.writeUInt32LE(46, 14); header.writeUInt32LE(bytes.length, 18);
  return Buffer.concat([header, bytes]);
}

test("Ren'Py Steam detection needs actual game Python calls, excluding common code, dialogue and comments", t => {
  const f = fixture(t);
  f.write("renpy/common/00steam.rpy", "init python:\n    steamapi.InitFlat(error)\n");
  f.write("game/00steam.rpy", "init python:\n    steamapi.InitFlat(error)\n");
  f.write("game/script.rpy", 'label start:\n    "achievement.steam.get_account_id()"\n    # $ achievement.steam.get_account_id()\ninit python:\n    documentation = """\nsteamapi.InitFlat(error)\n"""\n');
  assert.equal(f.inspect().required, false);
  f.write("game/script.rpy", "label start:\n    $ account = achievement.steam.get_account_id()\ninit python:\n    def stats():\n        return _renpysteam.get_stat_int('score')\n");
  const result = f.inspect();
  assert.equal(result.required, true); assert.deepEqual(result.calls.map(call => call.method), ["get_account_id", "get_stat_int"]);
  assert.equal(result.appId.status, "missing");
});

test("Ren'Py AppID comes from literal game configuration or scoped metadata and conflicts remain unresolved", t => {
  const f = fixture(t);
  f.write("game/script.rpy", "define config.steam_appid = 264380\nlabel start:\n    $ achievement.steam.get_account_id()\n");
  assert.equal(f.inspect().appId.value, 264380);
  f.write("game/steam_appid.txt", "303310\n");
  assert.equal(f.inspect().appId.status, "conflict"); assert.equal(f.inspect().appId.value, null);
  f.write("game/steam_appid.txt", "264380\n");
  f.write("game/options.rpy", "define config.enable_steam = False\n");
  assert.equal(f.inspect().required, false); assert.equal(f.inspect().disabled, true);
  f.write("game/options.rpy", "init python:\n    if platform_specific:\n        config.enable_steam = False\n");
  assert.equal(f.inspect().required, true);
});

test("explicit Steam achievement registrations establish optional intent; ordinary registrations and textual examples remain negative", t => {
  const f = fixture(t);
  const negatives = [
    'init python:\n    achievement.register("Local only")\n',
    'init python:\n    achievement.register("Local", steam=None)\n',
    'init python:\n    achievement.register("Local", steam="")\n',
    'init python:\n    achievement.register("Local", nested=example(steam="unrelated"))\n',
    '# achievement.register("Example", steam="FAKE")\nlabel start:\n    "achievement.register(name, steam=identifier)"\n',
    'init python:\n    examples = """achievement.register(name, steam=identifier)"""\n',
    'init python:\n    another.achievement.register("Local", steam="unrelated")\n'
  ];
  for (const text of negatives) { f.write("game/script.rpy", text); assert.equal(f.inspect().required, false); assert.equal(f.inspect().calls.length, 0); }
  f.write("game/script.rpy", 'init python:\r\n    achievement.register(\r\n        "Finish",\r\n        steam="FINISH_GAME",\r\n    )\r\n');
  const missing = f.inspect(); assert.equal(missing.required, false); assert.equal(missing.optional, true);
  assert.equal(missing.appId.status, "missing"); assert.equal(missing.calls[0].intent, "steam-achievement-registration");
  f.write("steam_appid.txt", "264380\n");
  const positive = f.inspect(); assert.equal(positive.required, true); assert.equal(positive.optional, true); assert.equal(positive.appId.value, 264380);
});

test("Python 2/3 compiled game Steam calls are read as inert AST and configuration-only cache does not hide them", t => {
  for (const python2 of [false, true]) {
    const f = fixture(t), file = f.write("game/script.rpyc", compiledPython("achievement.steam.get_account_id()", { python2 }));
    const configuration = Scripts.readGameConfigurationSources([f.gameDir], { keys: ["steam_appid", "enable_steam"] });
    assert.deepEqual(configuration.errors, []);
    assert.deepEqual(configuration.sources[0].compiledAssignments, []);
    f.write("steam_appid.txt", "264380\n");
    const before = sha(fs.readFileSync(file)), result = f.inspect();
    assert.equal(result.required, true); assert.equal(result.appId.value, 264380);
    assert.equal(result.calls[0].method, "get_account_id"); assert.equal(sha(fs.readFileSync(file)), before);
    fs.writeFileSync(file, compiledPython('achievement.register("Finish", steam="FINISH_GAME")', { python2 }));
    const registration = f.inspect();
    assert.equal(registration.required, true); assert.equal(registration.optional, true);
    assert.equal(registration.calls[0].intent, "steam-achievement-registration");
  }
});

test("selected SDK ABI inspection is deduplicated, cached by provider identity and never imports game code", async t => {
  const f = fixture(t), lib = path.join(f.root, "sdk/lib"), python = path.join(lib, "py3-mac-universal/python"), provider = path.join(lib, "python3.12/steamapi.pyc");
  fs.mkdirSync(path.dirname(python), { recursive: true }); fs.mkdirSync(path.dirname(provider), { recursive: true });
  fs.writeFileSync(python, "native runtime"); fs.writeFileSync(provider, "provider1");
  let calls = 0;
  const run = async (binary, args, options) => {
    calls++; assert.equal(binary, python); assert.equal(args[0], "-B"); assert.equal(args[1], "-c"); assert.match(args[2], /import steamapi/); assert.equal(args[3], lib);
    assert.equal(options.env.PYTHONDONTWRITEBYTECODE, "1"); assert.equal(options.env.PYTHONPATH, undefined);
    return JSON.stringify({ provider, executable: python, sha256: sha(fs.readFileSync(provider)), python: [3, 12, 8], symbols: ["SteamAPI_InitFlat"] });
  };
  const [first, second] = await Promise.all([Steam.inspectRuntimeSteamAbi(python, { major: 8, run }), Steam.inspectRuntimeSteamAbi(python, { major: 8, run })]);
  assert.equal(calls, 1); first.symbols.push("changed"); assert.deepEqual(second.symbols, ["SteamAPI_InitFlat"]);
  fs.writeFileSync(provider, "provider2"); await Steam.inspectRuntimeSteamAbi(python, { major: 8, run }); assert.equal(calls, 2);
  fs.writeFileSync(provider, "provider3");
  await assert.rejects(Steam.inspectRuntimeSteamAbi(python, { major: 8, run: async () => JSON.stringify({ provider: path.join(f.gameRoot, "steamapi.py"), sha256: sha("provider3"), python: [3, 12], symbols: ["SteamAPI_InitFlat"] }) }), /changed during inspection/);
});

test("per-game bootstrap owns only private files; assets remain linked, warm scripts are reused, edits and symlinks are rejected", t => {
  const f = fixture(t), script = f.write("game/script.rpy", "label start:\n    'Hello'\n"), archive = f.write("game/archive.rpa", Buffer.alloc(1024 * 1024));
  const before = [sha(fs.readFileSync(script)), sha(fs.readFileSync(archive))];
  const wrapper = Sdk.ensureWrapper({ userDataDir: path.join(f.root, "data"), gameId: "steam-game", gamePath: path.join(f.gameRoot, "Game.exe"), contentRootDir: f.gameRoot, sdkVersion: "8.5.2" });
  const options = { gameRoot: f.gameRoot, python: path.join(f.root, "sdk/python"), libraryPath: path.join(f.root, "helper/libsteam_api.dylib"), appId: 264380, identity: { version: "test" } };
  const first = Steam.ensureBootstrap(wrapper, options), stat = fs.statSync(first.script);
  assert.equal(fs.realpathSync(path.join(wrapper, "game/archive.rpa")), archive);
  assert.equal(Steam.ensureBootstrap(wrapper, options).sha256, first.sha256); assert.equal(fs.statSync(first.script).mtimeMs, stat.mtimeMs);
  assert.deepEqual([sha(fs.readFileSync(script)), sha(fs.readFileSync(archive))], before);
  fs.appendFileSync(first.script, "# user change\n");
  assert.throws(() => Steam.ensureBootstrap(wrapper, options), /modified/); assert.throws(() => Steam.removeBootstrap(wrapper), /modified/);
  fs.writeFileSync(first.script, fs.readFileSync(first.script, "utf8").replace("# user change\n", ""));
  Steam.removeBootstrap(wrapper); assert.equal(fs.existsSync(first.script), false);
  fs.symlinkSync(path.join(f.gameRoot, "missing.rpy"), first.script);
  assert.throws(() => Steam.ensureBootstrap(wrapper, options), /ENOENT|bounded regular/); assert.equal(fs.existsSync(path.join(f.gameRoot, "missing.rpy")), false);
  assert.throws(() => Steam.ensureBootstrap(path.join(f.gameRoot, "own"), options), /outside the original/);
});

test("bootstrap redirects only the two exact runtime Steam paths and preserves existing SDK identity files", t => {
  const f = fixture(t), python = path.resolve(__dirname, "../src/resources/python/bin/python3");
  const sdkPython = path.join(f.root, "sdk/python"), sdkDir = path.dirname(sdkPython), privateDir = path.join(f.root, "private");
  fs.mkdirSync(sdkDir); fs.mkdirSync(privateDir);
  const sdkAppId = path.join(sdkDir, "steam_appid.txt"); fs.writeFileSync(sdkAppId, "preserve original SDK metadata\n");
  const appIdPath = path.join(privateDir, "steam_appid.txt"), libraryPath = path.join(privateDir, "libsteam_api.dylib");
  const source = Steam.bootstrapPython({ python: sdkPython, libraryPath, appId: 264380, appIdPath });
  const testCode = ["import os,sys,types,ctypes", `sys.executable = ${JSON.stringify(sdkPython)}`,
    "provider = types.ModuleType('renpy.store'); provider.config = types.SimpleNamespace(); sys.modules['renpy.store'] = provider",
    "old_join, old_exists, old_cdll = os.path.join, os.path.exists, ctypes.cdll", source, source,
    `assert os.path.join(${JSON.stringify(sdkDir)}, 'libsteam_api.dylib') == ${JSON.stringify(libraryPath)}`,
    `assert os.path.join(${JSON.stringify(sdkDir)}, 'steam_appid.txt') == ${JSON.stringify(appIdPath)}`,
    "assert os.path.join('/elsewhere', 'libsteam_api.dylib') == '/elsewhere/libsteam_api.dylib'",
    "assert os.path.join('relative', 'steam_appid.txt') == old_join('relative', 'steam_appid.txt')",
    "assert os.path.exists is old_exists and ctypes.cdll is old_cdll",
    "with open(os.path.join(os.path.dirname(sys.executable), 'steam_appid.txt'), 'w') as output: output.write(str(provider.config.steam_appid))",
    "os.unlink(os.path.join(os.path.dirname(sys.executable), 'steam_appid.txt'))",
    `assert open(${JSON.stringify(sdkAppId)}).read() == 'preserve original SDK metadata\\n'`, "print('paths preserved')"].join("\n");
  assert.match(execFileSync(python, ["-B", "-c", testCode], { encoding: "utf8", timeout: 15000 }), /paths preserved/);
});

test("negative or explicitly disabled Steam launch requires no callback or ABI process", async t => {
  const f = fixture(t);
  assert.equal(await Steam.prepareGameSteam({ consumer: { required: false }, context: { prepareSteamApi: () => { throw Error("unused"); } } }), null);
  assert.equal(await Steam.prepareGameSteam({ consumer: { required: true }, baseEnvironment: { RENPY_NO_STEAM: "1" } }), null);
  await assert.rejects(Steam.prepareGameSteam({ consumer: { required: true, appId: { status: "missing", value: null } }, context: {} }), /application ID is missing/);
});

test("positive launch passes exact provider bindings and identity to the common service, using returned child-only state", async t => {
  const f = fixture(t);
  f.write("game/script.rpy", "define config.steam_appid = 264380\nlabel start:\n    $ achievement.steam.get_account_id()\n");
  const wrapperDir = Sdk.ensureWrapper({ userDataDir: path.join(f.root, "data"), gameId: "positive", gamePath: path.join(f.gameRoot, "Game.exe"), contentRootDir: f.gameRoot, sdkVersion: "7.8.7" });
  const python = path.join(f.root, "sdk/lib/py2-mac-universal/python"), observedExecutable = path.join(path.dirname(python), "pythonw");
  const libraryPath = path.join(f.root, "helper/libsteam_api.dylib"), baseEnvironment = { RENPY_PLATFORM: "mac-universal" };
  let calls = 0;
  const context = { prepareSteamApi: async (request, options) => {
    calls++; assert.equal(request.required, true); assert.equal(request.appId.value, 264380); assert.equal(request.arch, "arm64");
    assert.deepEqual(request.symbols, ["SteamAPI_InitFlat", "SteamAPI_SteamTimeline_v004"]); assert.equal(options.baseEnvironment, baseEnvironment);
    return { libraryPath, environment: { ...baseEnvironment, SteamAppId: "264380" }, identity: { version: "exact-fixture-version" } };
  } };
  const prepared = await Steam.prepareGameSteam({ consumer: f.inspect(), gameRoot: f.gameRoot, python, major: 7, arch: "arm64", wrapperDir, context, baseEnvironment },
    { inspectAbi: async (binary, { major }) => { assert.equal(binary, python); assert.equal(major, 7); return { executable: observedExecutable, sha256: "f".repeat(64), symbols: ["SteamAPI_InitFlat", "SteamAPI_SteamTimeline_v004"] }; } });
  assert.equal(calls, 1); assert.equal(prepared.environment.SteamAppId, "264380"); assert.deepEqual(baseEnvironment, { RENPY_PLATFORM: "mac-universal" });
  assert.match(fs.readFileSync(prepared.bootstrap.script, "utf8"), /pythonw/); assert.match(fs.readFileSync(prepared.bootstrap.script, "utf8"), /init -1500/);
  assert.equal(fs.existsSync(path.join(f.gameDir, Steam.BOOTSTRAP)), false);
  await Steam.prepareGameSteam({ consumer: { required: false }, wrapperDir, context }); assert.equal(fs.existsSync(prepared.bootstrap.script), false);
});

test("optional Steam achievements keep a normal launch when identity, provider or native helper is unavailable", async t => {
  const f = fixture(t);
  f.write("game/script.rpy", 'init python:\n    achievement.register("Finish", steam="FINISH_GAME")\n');
  const context = { prepareSteamApi: () => assert.fail("No identity means no helper setup") };
  assert.equal(await Steam.prepareGameSteam({ consumer: f.inspect(), context }), null);
  f.write("steam_appid.txt", "264380\n");
  const args = { consumer: f.inspect(), gameRoot: f.gameRoot, context: {}, python: path.join(f.root, "sdk/python") };
  assert.equal(await Steam.prepareGameSteam(args), null);
  args.context = { prepareSteamApi: async () => { throw Object.assign(Error("Not bundled"), { code: "STEAM_API_UNAVAILABLE" }); } };
  assert.equal(await Steam.prepareGameSteam(args, { inspectAbi: async () => ({ symbols: ["SteamAPI_InitFlat"] }) }), null);
  assert.equal(await Steam.prepareGameSteam(args, { inspectAbi: async () => { throw Object.assign(Error("Old runtime"), { code: "RENPY_STEAM_PROVIDER_UNAVAILABLE" }); } }), null);
  args.context.prepareSteamApi = async () => { throw Object.assign(Error("Configuration changed"), { code: "STEAM_API_STATE_INVALID" }); };
  await assert.rejects(Steam.prepareGameSteam(args, { inspectAbi: async () => ({ symbols: ["SteamAPI_InitFlat"] }) }), /Configuration changed/);
});

test("patched Steam project saves are discoverable and return to original paths after the owned bootstrap is removed", t => {
  const f = fixture(t), userDataDir = path.join(f.root, "data");
  f.write("game/options.rpy", "define config.save_directory = None\n");
  f.write("game/saves/existing.save", "original save");
  const entry = { gameId: "patched-steam", contentRootDir: f.gameRoot, gamePath: f.gameRoot, runtimeId: "patched",
    moduleData: { major: 8, version: "8.5.2" } };
  const wrapper = Sdk.ensureWrapper({ userDataDir, gameId: entry.gameId, gamePath: entry.gamePath, contentRootDir: f.gameRoot, sdkVersion: "patched-8.5.2" });
  Steam.ensureBootstrap(wrapper, { gameRoot: f.gameRoot, python: path.join(f.root, "sdk/python"), libraryPath: path.join(f.root, "helper/libsteam_api.dylib"), appId: 264380 });
  const first = Renpy.resolveSaveLocations(entry, { userDataDir, env: {} });
  assert.equal(first.primaryDirectory, path.join(wrapper, "game/saves"));
  assert.equal(first.directories.some(item => item.role === "original" && item.directory === path.join(f.gameDir, "saves")), true);
  Steam.removeBootstrap(wrapper);
  assert.equal(Renpy.resolveSaveLocations(entry, { userDataDir, env: {} }).primaryDirectory, path.join(f.gameDir, "saves"));
  assert.equal(fs.readFileSync(path.join(f.gameDir, "saves/existing.save"), "utf8"), "original save");
});
