const { finished } = require("node:stream/promises");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const Preparation = require("../src/modules/vnds/prepare");

const moduleRelative = path.join("src", "modules", "vnds");
const engineRelative = path.join(moduleRelative, "resources", Preparation.PROFILE);
const sourceEngine = path.join(__dirname, "..", engineRelative);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vnds-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.join(root, "Resources");
  const engine = path.join(resourcesRoot, "app.asar.unpacked", engineRelative);
  fs.cpSync(sourceEngine, engine, { recursive: true });
  return { root, resourcesRoot, engine, moduleDir: path.join(resourcesRoot, "app.asar", moduleRelative) };
}

function inventory(root) {
  const entries = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) entries.push(...inventory(file).map(([name, hash]) => [item.name + "/" + name, hash]));
    else entries.push([item.name, sha256(fs.readFileSync(file))]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

test("VNDS standalone Node verifies the complete pinned adapter in source resources", () => {
  const engine = Preparation.verifyEngine();
  assert.equal(engine.root, fs.realpathSync(sourceEngine));
  assert.equal(engine.profile.profile, Preparation.PROFILE);
  assert.equal(engine.profile.sourceRevision, Preparation.REVISION);
  assert.equal(engine.profile.loveVersion, "11.5");
  const actual = inventory(sourceEngine);
  const content = actual.filter(([name]) => name !== "bundle-profile.json");
  assert.equal(content.length, 28);
  assert.deepEqual(Object.fromEntries(content), engine.profile.files);
});

test("VNDS resolves a physical packaged adapter from explicit app resources", t => {
  const f = fixture(t), before = inventory(f.engine);
  assert.equal(Preparation.verifyEngine({ resourcesRoot: f.resourcesRoot }).root, f.engine);
  assert.deepEqual(inventory(f.engine), before);
});

test("VNDS derives physical packaged resources without an Electron API", t => {
  const f = fixture(t);
  assert.equal(Preparation.resolveEngineRoot({ moduleDir: f.moduleDir }), f.engine);
  assert.equal(Preparation.verifyEngine({ moduleDir: f.moduleDir }).root, f.engine);
  const unpackedModule = path.join(f.resourcesRoot, "app.asar.unpacked", moduleRelative);
  assert.equal(Preparation.verifyEngine({ moduleDir: unpackedModule }).root, f.engine);
});

test("VNDS refuses missing unpacked resources instead of using a virtual or source adapter", t => {
  const f = fixture(t);
  fs.rmSync(f.engine, { recursive: true });
  fs.cpSync(sourceEngine, path.join(f.moduleDir, "resources", Preparation.PROFILE), { recursive: true });
  assert.throws(() => Preparation.verifyEngine({ moduleDir: f.moduleDir }), /adapter is missing/);
  assert.throws(() => Preparation.verifyEngine({ resourcesRoot: f.resourcesRoot }), /adapter is missing/);
  assert.throws(() => Preparation.resolveEngineRoot({ resourcesRoot: path.join(f.resourcesRoot, "app.asar") }), /adapter is missing/);
});

for (const name of ["bundle-profile.json", "lib/json.lua", "main.lua"]) test(`VNDS rejects changed adapter content: ${name}`, t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.engine, name), "\nchanged");
  assert.throws(() => Preparation.verifyEngine({ resourcesRoot: f.resourcesRoot }), /adapter.*changed/);
});

test("VNDS preparations share one immutable physical adapter and preserve original games", async t => {
  const f = fixture(t), userDataDir = path.join(f.root, "data"), adapterBefore = inventory(f.engine);
  const prepared = [];
  for (const gameId of ["first", "second"]) {
    const gamePath = path.join(f.root, gameId);
    fs.mkdirSync(path.join(gamePath, "script"), { recursive: true });
    fs.writeFileSync(path.join(gamePath, "script", "main.scr"), "text Example\n");
    fs.writeFileSync(path.join(gamePath, "global.json"), JSON.stringify({ flag: gameId }));
    const before = inventory(gamePath);
    prepared.push(await Preparation.prepare({ gameId, gamePath }, { userDataDir, resourcesRoot: f.resourcesRoot }));
    assert.deepEqual(inventory(gamePath), before);
    assert.equal(fs.readFileSync(path.join(prepared.at(-1).saveDirectory, "global.json"), "utf8"), fs.readFileSync(path.join(gamePath, "global.json"), "utf8"));
  }
  assert.deepEqual(prepared.map(item => item.engine), [f.engine, f.engine]);
  assert.notEqual(prepared[0].working, prepared[1].working);
  assert.notEqual(prepared[0].saveDirectory, prepared[1].saveDirectory);
  assert.deepEqual(inventory(f.engine), adapterBefore);
  assert.ok(inventory(userDataDir).every(([name]) => !name.endsWith(".lua") && !name.includes(Preparation.PROFILE)));
});

let electron;
try { electron = require("electron"); } catch {}
const electronAvailable = typeof electron === "string" && fs.existsSync(electron);

for (const unpacked of [true, false]) test(`VNDS actual Electron ASAR ${unpacked ? "unpacked adapter uses physical native arguments" : "packed-only adapter is rejected"}`, { skip: !electronAvailable, timeout: 20000 }, async t => {
  const f = fixture(t), source = path.join(f.root, "source"), archive = path.join(f.resourcesRoot, "app.asar");
  fs.rmSync(path.join(f.resourcesRoot, "app.asar.unpacked"), { recursive: true });
  const files = ["src/modules/vnds/prepare.js", "src/modules/vnds/save.js", "src/modules/shared/game-data.js", "src/modules/shared/runtime/zip.js",
    "src/core/coordinated-runtime-managers.js", "src/core/runtime-coordinator.js", "src/core/json-files.js", "src/core/settings-merge.js"];
  for (const relative of files) {
    const destination = path.join(source, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", relative), destination);
  }
  fs.cpSync(sourceEngine, path.join(source, engineRelative), { recursive: true });
  const unpackPattern = require("../package.json").build.asarUnpack.find(item => item === engineRelative.split(path.sep).join("/") + "/**");
  assert.ok(unpackPattern, "The complete immutable adapter must be explicitly unpacked by the app build");
  await finished(await require("@electron/asar").createPackageWithOptions(source, archive, unpacked ? { unpackDir: unpackPattern.slice(0, -3) } : {}));
  const runner = path.join(f.root, "check.cjs");
  fs.writeFileSync(runner, `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const options=JSON.parse(process.argv[2]),Preparation=require(options.archive+'/src/modules/vnds/prepare.js');
(async()=>{
delete process.resourcesPath;
if(!options.unpacked){
  assert.ok(fs.existsSync(options.archive+'/'+options.engineRelative+'/main.lua'));
  assert.throws(()=>Preparation.verifyEngine(),/adapter is missing/);
  console.log(JSON.stringify({passed:true,unpacked:false}));return;
}
const engine=Preparation.verifyEngine();assert.equal(engine.root,options.engine);
assert.ok(!/[\\/]app\\.asar[\\/]/.test(engine.root));
process.resourcesPath=options.resourcesRoot;
assert.equal(Preparation.verifyEngine().root,engine.root);
const conf=path.join(engine.root,'conf.lua'),nativeRead=spawnSync('/bin/cat',[conf],{encoding:'utf8'});
assert.equal(nativeRead.status,0,nativeRead.stderr);assert.equal(nativeRead.stdout,fs.readFileSync(conf,'utf8'));
const virtual=options.archive+'/'+options.engineRelative,first=fs.statSync(virtual).ino,second=fs.statSync(virtual).ino;
assert.notEqual(first,second,'Exercise Electron synthetic ASAR inodes');
const command=path.join(options.root,'LÖVE.app','Contents','MacOS','love');fs.mkdirSync(path.dirname(command),{recursive:true});fs.writeFileSync(command,'fixture');
const coordinator=require(options.archive+'/src/core/runtime-coordinator.js').createRuntimeCoordinator(),client=coordinator.client();
const manager={id:'love',getState:()=>({installed:[{version:'11.5',appPath:path.join(options.root,'LÖVE.app')} ]})};
const scope=require(options.archive+'/src/core/coordinated-runtime-managers.js').createRuntimeUseScope({coordinator:client,managers:[manager],userDataDir:options.root});
try{
  await scope.useProcessArtifacts(command,[engine.root]);
  assert.equal(coordinator.snapshot().active.length,1);
  assert.equal(coordinator.snapshot().active[0].identities[0].managerId,'love');
  assert.equal(coordinator.snapshot().active[0].identities[0].version,'11.5');
}finally{await scope.release();client.close();}
assert.equal(coordinator.snapshot().active.length,0);
const before=fs.readFileSync(conf);fs.appendFileSync(conf,'\\nchanged');
assert.throws(()=>Preparation.verifyEngine(),/adapter.*changed/);fs.writeFileSync(conf,before);
assert.equal(Preparation.verifyEngine().root,engine.root);
console.log(JSON.stringify({passed:true,unpacked:true,virtualInodeChanged:true,nativeReadsPhysicalAdapter:true,runtimeLeasePassed:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
  const result = spawnSync(electron, [runner, JSON.stringify({ ...f, archive, engineRelative, unpacked })], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).passed, true);
});
