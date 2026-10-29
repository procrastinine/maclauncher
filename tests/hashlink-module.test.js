const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/hashlink/main");
const { inspectBytecode } = require("../src/modules/hashlink/bytecode");
const { nativeLibrary } = require("./helpers/hashlink-native");

// Serialized metadata fixture; these are not executable function bodies.
function bytecode(libraries = ["std"], version = 5, { name = "native_function", argumentKind } = {}) {
  const strings = [...libraries, name];
  const raw = Buffer.from(strings.map(value => value + "\0").join(""));
  const size = Buffer.alloc(4); size.writeInt32LE(raw.length);
  const header = [72, 76, 66, version, 0, 0, 0, strings.length];
  if (version >= 5) header.push(0);
  header.push(argumentKind === undefined ? 2 : argumentKind === 11 ? 5 : argumentKind === 9 ? 4 : 3, 0, libraries.length, 1);
  if (version >= 4) header.push(0);
  header.push(0);
  const pieces = [Buffer.from(header), size, raw, Buffer.from(strings.map(value => Buffer.byteLength(value)))];
  if (version >= 5) pieces.push(Buffer.alloc(4));
  pieces.push(Buffer.from(argumentKind === undefined ? [0, 10, 0, 0]
    : argumentKind === 11 ? [0, 10, 1, 2, 4, 11, strings.length - 1, 160, 1, 0, 13, 0, 0,
      ...Array.from({ length: 13 }, (_, i) => [strings.length - 1, i === 9 ? 4 : 3]).flat(), 3, 7]
    : argumentKind === 9 ? [0, 10, 1, 2, 3, 9, 7] : [0, 10, 1, 2, 0, argumentKind]));
  for (let i = 0; i < libraries.length; i += 1) pieces.push(Buffer.from([i, strings.length - 1, 1, i + 1]));
  return Buffer.concat(pieces);
}
function registerFixture(manager, options) {
  manager.core.rememberResolvedVersion({userDataDir:options.userDataDir,entry:{version:options.version,upstreamRevision:"a".repeat(40),architecture:"x86_64",
    supportedBytecodeVersions:[2,3,4,5],nativeAbi:{sdlEventLoop:options.version==="1.9"?"typed-event":"dynamic"}}});
  return manager.core.registerLocal(options);
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function machO(architecture, fileType = 2) {
  const data = Buffer.alloc(32); data.writeUInt32LE(0xfeedfacf);
  data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(fileType, 12);
  return data;
}
function mp3Bytecode(legacy = true) {
  const strings = ["fmt", "mp3_open", "fmt_mp3"], raw = Buffer.from(strings.map(value => value + "\0").join(""));
  const length = Buffer.alloc(4); length.writeInt32LE(raw.length);
  const types = [8, 3, 17, 2, 10, ...(legacy ? [2, 0, 1] : [0]), 2];
  return Buffer.concat([Buffer.from([72, 76, 66, 5, 0, 0, 0, 3, 0, 4, 0, 1, 1, 0, 0]), length, raw,
    Buffer.from(strings.map(value => Buffer.byteLength(value))), Buffer.alloc(4), Buffer.from(types), Buffer.from([0, 1, 3, 1])]);
}

function universalVm() {
  const data = Buffer.alloc(112); data.writeUInt32BE(0xcafebabe); data.writeUInt32BE(2, 4);
  for (const [i, architecture] of ["arm64", "x86_64"].entries()) {
    const slice = machO(architecture), offset = 48 + i * 32, table = 8 + i * 20;
    data.writeUInt32BE(slice.readUInt32LE(4), table); data.writeUInt32BE(offset, table + 8); data.writeUInt32BE(32, table + 12); slice.copy(data, offset);
  }
  return data;
}

test("HashLink inspects versions 2–6 and native import tables without executing code", () => {
  for (let version = 2; version <= 6; version += 1) {
    const parsed = inspectBytecode(bytecode(["std", "sdl", "?optional"], version));
    assert.equal(parsed.version, version);
    assert.deepEqual(parsed.nativeLibraries, ["std", "sdl", "?optional"]);
    assert.equal(parsed.inspectionScope, "metadata-and-native-imports");
  }
  const unknown = bytecode(); unknown[3] = 7;
  assert.throws(() => inspectBytecode(unknown), /Unsupported/);
  const invalid = bytecode(); invalid[7] = 127;
  assert.throws(() => inspectBytecode(invalid), /HashLink/);
  assert.throws(() => inspectBytecode(bytecode().subarray(0, 20)), /Truncated/);
});

test("HashLink detection validates bytecode signatures and keeps ambiguous .hl folders unknown", t => {
  const root = temporary(t), boot = path.join(root, "hlboot.dat");
  fs.writeFileSync(boot, "not bytecode");
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
  fs.writeFileSync(boot, bytecode());
  const detected = Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  assert.equal(detected.moduleData.bytecodePath, boot);
  const future = bytecode(); future[3] = 7; fs.writeFileSync(boot, future);
  const unsupported = Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  assert.equal(unsupported.moduleData.detectedVersion, "7");
  assert.equal(unsupported.moduleData.compatibility, "unsupported-bytecode-version");
  fs.rmSync(boot);
  fs.writeFileSync(path.join(root, "one.hl"), bytecode());
  fs.writeFileSync(path.join(root, "two.hl"), bytecode());
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
  assert.ok(Module.detectGame({ inputPath: path.join(root, "one.hl"), rootDir: root, stat: fs.statSync(path.join(root, "one.hl")) }));
});

test("HashLink preflight rejects Windows/mismatched native modules and preserves optional imports", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), runtime = path.join(root, "runtime"), game = path.join(root, "game");
  fs.mkdirSync(runtime); fs.mkdirSync(game);
  const executable = path.join(runtime, "hl");
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, "libhl.dylib"), nativeLibrary());
  const manager = Module.runtimeManagers[0];
  registerFixture(manager, { userDataDir: root, version: "1.16", runtimePath: executable });
  const boot = path.join(game, "hlboot.dat"); fs.writeFileSync(boot, bytecode(["std", "sdl", "?optional"]));
  const entry = { gamePath: game, moduleData: { bytecodePath: boot } };
  const context = { userDataDir: root, settings: { runtimes: { hashlink: { defaultVersion: "1.16" } } } };
  assert.deepEqual(Module.__test.inspectDependencies(entry, context).missingLibraries, ["sdl"]);
  fs.writeFileSync(path.join(runtime, "sdl.hdll"), "MZwindows-module");
  assert.deepEqual(Module.__test.inspectDependencies(entry, context).incompatibleLibraries, ["sdl"]);
  fs.writeFileSync(path.join(runtime, "sdl.hdll"), machO("arm64", 6));
  assert.equal(Module.__test.inspectDependencies(entry, context).ready, false);
  fs.writeFileSync(path.join(runtime, "sdl.hdll"), nativeLibrary());
  assert.equal(Module.__test.inspectDependencies(entry, context).ready, true);
});

test("HashLink reads original bytecode and isolates relative writes with explicit dylib search and arguments", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "hl"), game = path.join(root, "source"), userDataDir = path.join(root, "managed");
  fs.mkdirSync(game);
  const boot = path.join(game, "game.hl");
  fs.writeFileSync(path.join(root, "libhl.dylib"), nativeLibrary());
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 }); fs.writeFileSync(boot, bytecode());
  registerFixture(Module.runtimeManagers[0], { userDataDir, version: "1.16", runtimePath: executable });
  let call;
  await Module.launchRuntime("hashlink", { gameId: "launch", moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.16" } } }, { settings: {}, userDataDir,
    gameArguments: ["--title", "A quoted game", "", "$(literal)"],
    runtimeSettings: { appArgs: ["literal argument"] }, spawnDetachedChecked: async (...args) => { call = args; return {}; } });
  assert.equal(call[0], executable); assert.equal(path.basename(call[1][0]), "game.hl"); assert.equal(call[1][1], "literal argument");
  assert.deepEqual(call[1].slice(2), ["--title", "A quoted game", "", "$(literal)"]);
  assert.equal(call[1][0], boot); assert.notEqual(call[2].cwd, path.dirname(boot));
  assert.equal(call[2].env.DYLD_LIBRARY_PATH, [root, game].join(path.delimiter));
  fs.writeFileSync(path.join(call[2].cwd, "player-save.json"), "keep player save");
  assert.deepEqual(fs.readFileSync(boot), bytecode());
  const again = Module.__test.prepareLaunch({ gameId: "launch", moduleData: { bytecodePath: boot } }, { userDataDir });
  assert.equal(fs.readFileSync(path.join(again.wrapper, "player-save.json"), "utf8"), "keep player save");
  fs.writeFileSync(boot, bytecode(["std"], 4));
  assert.throws(() => Module.__test.prepareLaunch({ gameId: "launch", moduleData: { bytecodePath: boot } }, { userDataDir }), /bytecode changed/);
});

test("HashLink identifies native SDL ABI independently of the shared bytecode format", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "hl"), boot = path.join(root, "game.hl");
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 });
  registerFixture(Module.runtimeManagers[0], { userDataDir: root, version: "1.16", runtimePath: executable });
  const typed = bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 });
  const dynamic = bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 9 });
  assert.equal(inspectBytecode(typed).version, inspectBytecode(dynamic).version);
  assert.equal(inspectBytecode(typed).nativeAbi.sdlEventLoop, "typed-event");
  assert.equal(inspectBytecode(dynamic).nativeAbi.sdlEventLoop, "dynamic");
  assert.equal(inspectBytecode(typed).natives[0].signature, "POiiiiiiiiibiii__b");
  assert.equal(inspectBytecode(dynamic).natives[0].signature, "PD_b");
  const entry = { moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.16" } } };
  fs.writeFileSync(boot, typed);
  assert.equal(Module.__test.inspectDependencies(entry, { userDataDir: root, settings: {} }).ready, false);
  assert.match(Module.__test.inspectDependencies(entry, { userDataDir: root, settings: {} }).reason, /incompatible runtime profile/);
  fs.writeFileSync(boot, dynamic);
  assert.deepEqual(Module.__test.inspectDependencies(entry, { userDataDir: root, settings: {} }).missingLibraries, ["sdl"]);
});

test("unconfigured HashLink Play requests discovery without persisting a package choice", t => {
  const root=temporary(t),boot=path.join(root,"game.hl");fs.writeFileSync(boot,mp3Bytecode(true));
  const entry={moduleData:{bytecodePath:boot}},context={userDataDir:path.join(root,"data"),settings:{}};
  const required=Module.ensureRuntime(entry,context);
  assert.equal(required.version,null);assert.equal(required.discoveryRequired,true);assert.equal(entry.runtimeData,undefined);
});

test("explicit global HashLink choices remain exact when incompatible", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), boot = path.join(root, "game.hl");
  fs.writeFileSync(boot, bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 }));
  const entry = { moduleData: { bytecodePath: boot } }, context = { userDataDir: path.join(root, "data"),
    settings: { runtimes: { hashlink: { defaultVersion: "1.16" } } },
    onEntryChange: () => {} };
  Module.runtimeManagers[0].core.rememberResolvedVersion({userDataDir:context.userDataDir,entry:{version:"1.16",upstreamRevision:"a".repeat(40),supportedBytecodeVersions:[5],nativeAbi:{sdlEventLoop:"dynamic"}}});
  assert.throws(()=>Module.ensureRuntime(entry,context),/incompatible SDL primitive ABI/);
  assert.equal(entry.runtimeData, undefined);
  assert.equal(context.settings.runtimes.hashlink.defaultVersion, "1.16");
});

test("existing exact 1.9 registrations and explicit choices retain their identity", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), runtime = path.join(root, "old-runtime"), data = path.join(root, "data");
  fs.mkdirSync(runtime); const executable = path.join(runtime, "hl"), boot = path.join(root, "old-game.hl");
  fs.writeFileSync(executable, machO("x86_64"), { mode: 0o755 });
  fs.writeFileSync(boot, bytecode(["sdl"], 5, { name: "event_loop", argumentKind: 11 }));
  const manager = Module.runtimeManagers[0], installed = registerFixture(manager, { userDataDir: data, version: "1.9", runtimePath: executable });
  const entry = { moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.9" } } };
  const context = { userDataDir: data, settings: {}, onEntryChange: () => assert.fail("Exact stored choices must not change") };
  assert.equal(Module.ensureRuntime(entry, context), null);
  const selected = manager.resolveSelection(entry, context.settings, data);
  assert.equal(selected.version, "1.9"); assert.equal(selected.install.binarySha256, installed.binarySha256);
  assert.equal(selected.install.upstreamRevision, "a".repeat(40));
  const globalEntry = { moduleData: { bytecodePath: boot } };
  assert.equal(Module.ensureRuntime(globalEntry, { ...context, settings: { runtimes: { hashlink: { defaultVersion: "1.9" } } }, onEntryChange() {} }), null);
  assert.equal(globalEntry.runtimeData, undefined);
  fs.appendFileSync(executable, "changed");
  assert.equal(manager.resolveSelection(entry, {}, data).ready, false);
  assert.equal(entry.runtimeData.hashlink.version, "1.9");
  assert.equal(entry.runtimeData.hashlink.version, "1.9");
});

test("HashLink resource overlay aliases static assets and isolates unknown writable sidecars", t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  const boot = path.join(source, "game.hl"); fs.writeFileSync(boot, bytecode());
  fs.writeFileSync(path.join(source, "assets.pak"), "large immutable resource");
  fs.writeFileSync(path.join(source, "config.json"), "author setting");
  fs.writeFileSync(path.join(source, "sdl.hdll"), "MZwindows-module");
  fs.writeFileSync(path.join(source, "game.exe"), "MZwindows-launcher");
  const launch = Module.__test.prepareLaunch({ gameId: "overlay", moduleData: { bytecodePath: boot } }, { userDataDir: path.join(root, "data") });
  assert.equal(fs.lstatSync(path.join(launch.wrapper, "assets.pak")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(launch.wrapper, "config.json")).isSymbolicLink(), false);
  assert.equal(launch.bytecodePath, boot);
  assert.deepEqual(fs.readdirSync(launch.wrapper).sort(), ["assets.pak", "config.json"]);
  fs.writeFileSync(path.join(launch.wrapper, "config.json"), "player setting");
  assert.equal(fs.readFileSync(path.join(source, "config.json"), "utf8"), "author setting");
});

test("HashLink requires an Intel bytecode slice before accepting or launching a local runtime", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
  const root = temporary(t), runtime = path.join(root, "runtime"), source = path.join(root, "source"), userDataDir = path.join(root, "data");
  fs.mkdirSync(runtime); fs.mkdirSync(source); const executable = path.join(runtime, "hl"), boot = path.join(source, "game.hl");
  fs.writeFileSync(executable, universalVm(), { mode: 0o755 }); fs.writeFileSync(boot, bytecode());
  fs.writeFileSync(path.join(runtime, "libhl.dylib"), nativeLibrary());
  registerFixture(Module.runtimeManagers[0], { userDataDir, version: "1.16", runtimePath: executable });
  let call; const entry = { gameId: "universal", moduleData: { bytecodePath: boot }, runtimeData: { hashlink: { version: "1.16" } } };
  await Module.launchRuntime("hashlink", entry, { userDataDir, settings: {}, spawnDetachedChecked: async (...args) => { call = args; return {}; } });
  assert.equal(call[3], true, "universal executables must force their Intel VM slice");
  await Module.runtimeManagers[0].uninstallRuntime({ userDataDir, version: "1.16" });
  fs.writeFileSync(executable, machO("arm64"), { mode: 0o755 });
  assert.throws(() => registerFixture(Module.runtimeManagers[0], { userDataDir, version: "1.16", runtimePath: executable }), /requires a x86_64 executable/);
  assert.equal(Module.runtimeManagers[0].core.resolveRegistered({ userDataDir, version: "1.16" }), null);
});

test("HashLink removes obsolete copies while retaining player saves and rejecting changed private bytecode", t => {
  const root = temporary(t), source = path.join(root, "source"), userDataDir = path.join(root, "data"); fs.mkdirSync(source);
  const boot = path.join(source, "game.hl"), modulePath = path.join(source, "sdl.hdll");
  fs.writeFileSync(boot, bytecode()); fs.writeFileSync(modulePath, "MZwindows-module");
  const entry = { gameId: "migrate", moduleData: { bytecodePath: boot } };
  const launch = Module.__test.prepareLaunch(entry, { userDataDir });
  const recordPath = path.join(launch.directory, "game-source.json"), record = JSON.parse(fs.readFileSync(recordPath));
  delete record.layoutVersion; fs.writeFileSync(recordPath, JSON.stringify(record));
  const oldBytecode = path.join(launch.wrapper, "game.hl");
  fs.writeFileSync(oldBytecode, "modified private program");
  fs.copyFileSync(modulePath, path.join(launch.wrapper, "sdl.hdll"));
  fs.writeFileSync(path.join(launch.wrapper, "player-save.json"), "player state");
  assert.throws(() => Module.__test.prepareLaunch(entry, { userDataDir }), /Managed HashLink bytecode changed/);
  assert.equal(fs.readFileSync(path.join(launch.wrapper, "player-save.json"), "utf8"), "player state");
  fs.copyFileSync(boot, oldBytecode);
  const migrated = Module.__test.prepareLaunch(entry, { userDataDir });
  assert.equal(migrated.bytecodePath, boot);
  assert.deepEqual(fs.readdirSync(migrated.wrapper), ["player-save.json"]);
  assert.equal(fs.readFileSync(path.join(migrated.wrapper, "player-save.json"), "utf8"), "player state");
});

test('hosted HashLink selections retain project validation instead of requiring stock archive metadata',t=>{
 const root=temporary(t),boot=path.join(root,'game.hl'),exe=path.join(root,'hl');fs.writeFileSync(boot,bytecode([]));fs.writeFileSync(exe,machO('x86_64'),{mode:0o755});
 const manager=Module.runtimeManagers[0],pin={version:'fixture-host',upstreamRevision:'a'.repeat(40),supportedBytecodeVersions:[5],nativeAbi:{sdlEventLoop:'dynamic'}},download=require('../src/modules/hashlink/runtime/download');let stockChecks=0;
 t.mock.method(download,'verifyInstalled',()=>{stockChecks++});
 const install={version:pin.version,upstreamRevision:pin.upstreamRevision,source:'download',executablePath:exe,architectures:['x86_64'],catalogEntry:{...pin,projectPackage:{id:'hashlink'}}};
 t.mock.method(manager,'resolveSelection',()=>({version:pin.version,ready:true,install}));
 assert.equal(Module.__test.inspectDependencies({moduleData:{bytecodePath:boot}},{settings:{},userDataDir:root}).ready,true);assert.equal(stockChecks,0);
 delete install.catalogEntry.projectPackage;
 assert.equal(Module.__test.inspectDependencies({moduleData:{bytecodePath:boot}},{settings:{},userDataDir:root}).ready,true);assert.equal(stockChecks,1);
});

test('HashLink recommendations preserve the game primitive ABI independently of package versions', () => {
  const compatible = Module.__test.runtimeCompatible;
  const game = { version: 5, nativeAbi: { sdlEventLoop: 'typed-event' },
    natives: [{ library: 'std', name: 'alloc_array', signature: 'PTi_A', optional: false }] };
  const pin = { version: 'future-compatible-package', upstreamRevision: '4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6',
    supportedBytecodeVersions: [2, 3, 4, 5], nativeAbi: { sdlEventLoop: 'typed-event' },
    primitiveProfileId: 'typed-1.9-macos-v2',
    primitiveProfileSha256: 'a22d96b6fea6dd8b9031489a1c0d89c091ff8c6ee9a090d2f95795ac30790296' };
  assert.equal(compatible(pin, game), true);
  assert.equal(compatible(pin, { ...game, natives: [{ ...game.natives[0], signature: 'Pi_A' }] }), false);
  assert.equal(compatible({ ...pin, primitiveProfileSha256: '0'.repeat(64) }, game), false);
  assert.equal(compatible({ ...pin, nativeAbi: { sdlEventLoop: 'dynamic' } }, game), false);
  assert.equal(compatible({ ...pin, nativeAbi: { sdlEventLoop: 'unknown' } }, game), true,
    'unknown catalog metadata does not override the verified native primitive profile');
  assert.equal(compatible({ ...pin, primitiveProfileId: 'future-profile' }, game), true,
    'future profile identities still receive actual installed native inspection');
});

test('cold HashLink games recommend exact published SDL and primitive profiles without saving a choice', {skip:process.platform!=="darwin"}, t => {
  const root=temporary(t),boot=path.join(root,'game.hl'),data=path.join(root,'data'),manager=Module.runtimeManagers[0];
  const pin=(id,version,upstreamVersion,sdl)=>{
    const bytes=fs.readFileSync(path.join(__dirname,'../src/modules/hashlink/runtime/profiles',id+'.json')),profile=JSON.parse(bytes);
    return {version,upstreamVersion,upstreamRevision:profile.upstreamRevision,architecture:'x86_64',hostArchitectures:['arm64','x64'],minimumMacOS:'10.13',supportedBytecodeVersions:[2,3,4,5],
      nativeAbi:{sdlEventLoop:sdl,callbackMarker:profile.callbackMarker},primitiveProfileId:id,primitiveProfileSha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
      macPackageVersion:version,projectPackage:{id:'hashlink'},...(profile.archiveSha256?{sourceKind:'commit',asset:{url:'https://example.test/hashlink.tar.gz',filename:'hashlink.tar.gz',sha256:profile.archiveSha256}}:{})};
  };
  const latest=pin('stock-2.0.0-d049add0a84d','2.0-abi-published','2.0','dynamic'),typed=pin('typed-1.9-macos-v2','1.9-abi-published','1.9','typed-event'),legacy=pin('legacy-dynamic-1.12-macos-v1','1.12-abi-published','1.12','dynamic');
  const catalog=[latest,typed,legacy];for(const entry of catalog)manager.core.rememberResolvedVersion({userDataDir:data,entry});
  t.mock.method(manager.core,'listCatalog',()=>catalog);
  const context={userDataDir:data,settings:{runtimes:{hashlink:{defaultVersion:latest.version}}},onEntryChange:()=>assert.fail('Recommendations must not persist game choices')};
  for(const [bytes,expected]of [[bytecode(['sdl'],5,{name:'event_loop',argumentKind:11}),typed.version],[mp3Bytecode(true),legacy.version]]){
    fs.writeFileSync(boot,bytes);const entry={moduleData:{bytecodePath:boot}};
    const required=Module.ensureRuntime(entry,context);assert.equal(required.version,expected);assert.equal(entry.runtimeData,undefined);
    assert.equal(Module.__test.inspectDependencies(entry,context).version,expected,'Launch preflight must use the same recommendation');
    const explicit={...entry,runtimeData:{hashlink:{version:typed.version}}};
    assert.equal(Module.ensureRuntime(explicit,context).version,typed.version);assert.equal(explicit.runtimeData.hashlink.version,typed.version);
  }
  fs.writeFileSync(boot,bytecode([]));
  assert.equal(Module.ensureRuntime({moduleData:{bytecodePath:boot}},{...context,settings:{runtimes:{hashlink:{defaultVersion:typed.version}}}}).version,typed.version,'No native ABI evidence leaves the saved global fallback in place');
});
