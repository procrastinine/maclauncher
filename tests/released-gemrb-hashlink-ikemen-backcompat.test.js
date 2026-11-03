const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
const GemRB = require("../src/modules/gemrb/main"), HashLink = require("../src/modules/hashlink/main"), Ikemen = require("../src/modules/ikemen/main");
const modules = Object.fromEntries(["gemrb", "hashlink", "ikemen"].map(id => [id, require(`../src/modules/${id}/backcompat`)]));

function fixture(t, moduleId, { original = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "released-engine-backcompat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), sourceRoot = path.join(root, "original"), moduleRoot = path.join(userDataDir, "games", "example", "modules", moduleId);
  fs.mkdirSync(moduleRoot, { recursive: true });if (original) fs.mkdirSync(sourceRoot);
  return {root, userDataDir, sourceRoot, moduleRoot, entry: {gameId: "example", moduleId, gamePath: sourceRoot, contentRootDir: sourceRoot}};
}
function write(file, value) {fs.mkdirSync(path.dirname(file), {recursive:true});fs.writeFileSync(file, value);}
async function retire(mod, entry, context, root) {
  const descriptor = modules[mod].legacyGameMirrors(entry, context).find(row => row.mirrorRoot === root);
  assert.ok(descriptor, "released root must be declared");return retireLegacyGameMirror(descriptor, context);
}
async function persistMigration(id, context, entry = context.entry) {
  let saved, settings;
  const result = await runDataMigrations({settings:{},games:[entry],userDataDir:context.userDataDir,
    registry:{getModule:()=>modules[id]},saveSettings:async value=>{settings=JSON.parse(JSON.stringify(value));},
    saveEntry:async value=>{saved=JSON.parse(JSON.stringify(value));}});
  assert.deepEqual(result.pendingIds,[],JSON.stringify(result.retained));assert.ok(saved,"entry passed through real persistence");
  await runDataMigrations({settings,games:[saved],userDataDir:context.userDataDir,
    registry:{getModule:()=>assert.fail("completed migration must never consult old paths again")},
    saveSettings:async()=>assert.fail("completed migration is a no-op"),saveEntry:async()=>assert.fail("completed migration must not resave entry")});
  return saved;
}
function conflict(original, old) {
  const copies = fs.readdirSync(path.dirname(original)).filter(name => name.startsWith(path.basename(original) + ".MacLauncher-conflict-"));
  assert.equal(copies.length, 1);assert.equal(fs.readFileSync(path.join(path.dirname(original), copies[0]), "utf8"), old);
}
function gemrbGame(root) {
  const key = Buffer.alloc(38);key.write("KEY V1  ");key.writeUInt32LE(1,12);key.writeUInt32LE(24,20);
  write(path.join(root,"CHITIN.KEY"),key);write(path.join(root,"DIALOG.TLK"),"TLK V1  ");
}

test("released GemRB game and SavePath parent bytes reach the actual new game/save load paths with conflicts preserved", async t => {
  const f=fixture(t,"gemrb");gemrbGame(f.sourceRoot);
  const game=path.join(f.moduleRoot,"game"), saves=path.join(f.moduleRoot,"saves");
  write(path.join(game,"mod-state.ini"),"released state");write(path.join(game,"baldur.ini"),"released settings");write(path.join(f.sourceRoot,"baldur.ini"),"original settings");
  write(path.join(saves,"save","000000001-Slot","BALDUR.GAM"),"released progress");write(path.join(saves,"mpsave","multi.gam"),"multiplayer progress");
  assert.equal((await retire("gemrb",f.entry,f,game)).complete,true);assert.equal((await retire("gemrb",f.entry,f,saves)).complete,true);
  const launch=GemRB.__test.prepareLaunch(f.entry,f);
  assert.equal(launch.config.GamePath,f.sourceRoot);assert.equal(launch.config.SavePath,f.sourceRoot);
  assert.equal(fs.readFileSync(path.join(launch.config.GamePath,"mod-state.ini"),"utf8"),"released state");
  assert.equal(fs.readFileSync(path.join(launch.config.SavePath,"save","000000001-Slot","BALDUR.GAM"),"utf8"),"released progress");
  assert.equal(fs.readFileSync(path.join(launch.config.SavePath,"mpsave","multi.gam"),"utf8"),"multiplayer progress");
  assert.equal(fs.readFileSync(path.join(f.sourceRoot,"baldur.ini"),"utf8"),"original settings");conflict(path.join(f.sourceRoot,"baldur.ini"),"released settings");
  assert.equal(fs.existsSync(game),false);assert.equal(fs.existsSync(saves),false);
});

test("released GemRB GUI script writes return to the actual direct script tree", async t => {
  const f=fixture(t,"gemrb");gemrbGame(f.sourceRoot);const scriptsRoot=path.join(f.root,"profile-source"), scripts=path.join(scriptsRoot,"GUIScripts");fs.mkdirSync(scripts,{recursive:true});
  write(path.join(f.moduleRoot,"scripts-source.json"),JSON.stringify({source:scripts}));const old=path.join(f.moduleRoot,"scripts","GUIScripts");
  write(path.join(old,"example","Start.py"),"# released script\n");write(path.join(old,"example","state.json"),"released script state");
  assert.equal((await retire("gemrb",f.entry,f,old)).complete,true);
  const launch=GemRB.__test.prepareLaunch(f.entry,{...f,runtimeSettings:{scriptsDir:scriptsRoot,customGameType:"example"}});
  assert.equal(launch.config.GUIScriptsPath,scriptsRoot);assert.equal(fs.readFileSync(path.join(launch.config.GUIScriptsPath,"GUIScripts","example","state.json"),"utf8"),"released script state");
});

test("released HashLink cwd sidecars return beside the original bytecode and preserve conflicting originals", async t => {
  const f=fixture(t,"hashlink"), boot=path.join(f.sourceRoot,"game.hl");write(boot,"original bytecode");f.entry.moduleData={bytecodePath:boot};
  const old=path.join(f.moduleRoot,"game");write(path.join(old,"player-save.json"),"released progress");write(path.join(old,"config.ini"),"released options");write(path.join(f.sourceRoot,"config.ini"),"original options");
  assert.equal((await retire("hashlink",f.entry,f,old)).complete,true);
  const launch=HashLink.__test.prepareLaunch(f.entry);
  assert.equal(launch.bytecodePath,boot);assert.equal(fs.readFileSync(path.join(launch.root,"player-save.json"),"utf8"),"released progress");
  assert.equal(fs.readFileSync(path.join(launch.root,"config.ini"),"utf8"),"original options");conflict(path.join(launch.root,"config.ini"),"released options");
});

function sameIkemen(t,f) {
  const install={executablePath:path.join(f.sourceRoot,"Ikemen_GO"),version:"1.0.0"};f.entry.runtimeData={ikemen:{version:"1.0.0"}};
  t.mock.method(Ikemen.runtimeManagers[0],"resolveSelection",()=>({ready:true,install}));return install;
}
test("released Ikemen SavePath bytes reach original save after the same-distribution branch, with config conflicts preserved", async t => {
  const f=fixture(t,"ikemen"), install=sameIkemen(t,f);write(install.executablePath,"native fixture");write(path.join(f.sourceRoot,"external","script","main.lua"),"runtime script");
  write(path.join(f.sourceRoot,"data","system.def"),"[Info]\nmugenversion=1.1\n[Files]\nselect=select.def\n");write(path.join(f.sourceRoot,"data","select.def"),"[Characters]\n");
  const save=path.join(f.sourceRoot,"save"), old=path.join(f.moduleRoot,"saves");write(path.join(save,"config.ini"),"original config");write(path.join(old,"config.ini"),"released config");write(path.join(old,"stats.json"),"released statistics");
  f.entry.moduleData={motifRelative:path.join("data","system.def")};
  assert.equal((await retire("ikemen",f.entry,f,old)).complete,true);
  const launch=Ikemen.__test.prepareLaunch(f.entry,f,install);assert.equal(launch.originalPaths,true);assert.equal(launch.saveRoot,save);
  assert.equal(fs.readFileSync(path.join(launch.saveRoot,"stats.json"),"utf8"),"released statistics");assert.equal(fs.readFileSync(path.join(launch.saveRoot,"config.ini"),"utf8"),"original config");conflict(path.join(save,"config.ini"),"released config");
});

test("released missing game roots stay blocked while Ikemen creates only its anchored save folder", async t => {
  for(const id of ["gemrb","hashlink","ikemen"]){
    const f=fixture(t,id,{original:false});
    if(id==="hashlink")f.entry.moduleData={bytecodePath:path.join(f.sourceRoot,"game.hl")};if(id==="ikemen")sameIkemen(t,f);
    const old=path.join(f.moduleRoot,id==="ikemen"?"saves":"game");write(path.join(old,"progress.dat"),"released progress");
    const result=await retire(id,f.entry,f,old);assert.equal(result.complete,false,id);assert.ok(result.reason);assert.equal(fs.readFileSync(path.join(old,"progress.dat"),"utf8"),"released progress");
    assert.equal(fs.existsSync(f.sourceRoot),false,"never recreate an unavailable original game root");
  }
  const f=fixture(t,"ikemen"), install=sameIkemen(t,f), old=path.join(f.moduleRoot,"saves"), save=path.join(f.sourceRoot,"save");
  write(install.executablePath,"native fixture");write(path.join(f.sourceRoot,"external","script","main.lua"),"runtime script");
  write(path.join(f.sourceRoot,"data","system.def"),"[Info]\nmugenversion=1.1\n[Files]\nselect=select.def\n");write(path.join(f.sourceRoot,"data","select.def"),"[Characters]\n");
  write(path.join(old,"stats.json"),"released progress");f.entry.moduleData={motifRelative:path.join("data","system.def")};
  f.entry.defaultSaveDir=old;f.entry.saveLocations=[{id:"engine",directory:old}];
  assert.equal(fs.existsSync(save),false);
  const descriptor=modules.ikemen.legacyGameMirrors(f.entry,f).find(row=>row.mirrorRoot===old);
  assert.equal(descriptor.createSourceWithin,f.sourceRoot);
  const persisted=await persistMigration("ikemen",f);
  assert.equal(fs.readFileSync(path.join(save,"stats.json"),"utf8"),"released progress");assert.equal(fs.existsSync(old),false);
  assert.equal(persisted.defaultSaveDir,save);assert.equal(persisted.saveLocations[0].directory,save);
  const launch=Ikemen.__test.prepareLaunch(persisted,f,install);assert.equal(launch.originalPaths,true);assert.equal(launch.wrapper,f.sourceRoot);assert.equal(launch.saveRoot,save);
  assert.equal(fs.readFileSync(path.join(launch.saveRoot,"stats.json"),"utf8"),"released progress");
});

test("released Ikemen save alias and unknown aliases block mirror retirement instead of claiming restoration", async t => {
  for(const id of ["gemrb","hashlink","ikemen"]){
    const f=fixture(t,id);if(id==="hashlink")f.entry.moduleData={bytecodePath:path.join(f.sourceRoot,"game.hl")};if(id==="ikemen")sameIkemen(t,f);
    const old=path.join(f.moduleRoot,"game"), target=path.join(f.moduleRoot,"saves");fs.mkdirSync(old);fs.mkdirSync(target);fs.symlinkSync(target,path.join(old,id==="ikemen"?"save":"unknown-link"));write(path.join(old,"progress.dat"),"retained progress");
    const result=await retire(id,f.entry,f,old);assert.equal(result.complete,false,id);assert.match(result.reason,/symbolic link that does not point to the matching file/);assert.equal(fs.readFileSync(path.join(old,"progress.dat"),"utf8"),"retained progress");
  }
});

test("an existing orphan GemRB script mirror is declared blocked rather than silently omitted", async t => {
  const f=fixture(t,"gemrb"), old=path.join(f.moduleRoot,"scripts","GUIScripts");write(path.join(old,"state.json"),"script state");
  const result=await retire("gemrb",f.entry,f,old);assert.equal(result.complete,false);assert.match(result.reason,/original game folder for these files is unknown/);assert.equal(fs.readFileSync(path.join(old,"state.json"),"utf8"),"script state");
});

test("module backcompat boundary keeps released descriptors out of current launch implementations", () => {
  for(const id of ["gemrb","hashlink","ikemen"]){
    const current=require(`../src/modules/${id}/main`);assert.equal(current.legacyGameMirrors,undefined,id);assert.equal(typeof modules[id].legacyGameMirrors,"function");
    const text=fs.readFileSync(path.join(__dirname,`../src/modules/${id}/main.js`),"utf8");assert.doesNotMatch(text,/function legacyGameMirrors|scripts-source\.json|writableInput/);
  }
  const currentPaths=require("../src/modules/ikemen/original-paths");assert.equal(typeof currentPaths.originalSaveDirectory,"function");assert.equal(typeof currentPaths.distributionRoot,"function");
});

test("released GemRB arbitrary cwd state reports a blocked mixed root instead of silently leaving progress behind", async t => {
  const f=fixture(t,"gemrb");gemrbGame(f.sourceRoot);write(path.join(f.moduleRoot,"relative-player-state.json"),"released cwd state");
  write(path.join(f.moduleRoot,"GemRB.cfg"),"current config");write(path.join(f.moduleRoot,"cache","derived.dat"),"current cache");
  const result=await retire("gemrb",f.entry,f,f.moduleRoot);assert.equal(result.complete,false);assert.match(result.reason,/original game folder for these files is unknown/);
  assert.equal(fs.existsSync(path.join(f.sourceRoot,"relative-player-state.json")),false,"retained is not restored");
  assert.equal(fs.readFileSync(path.join(f.moduleRoot,"relative-player-state.json"),"utf8"),"released cwd state");
  assert.equal(fs.readFileSync(path.join(f.moduleRoot,"GemRB.cfg"),"utf8"),"current config");
  assert.equal(fs.readFileSync(path.join(f.moduleRoot,"cache","derived.dat"),"utf8"),"current cache");
});

function releasedIkemenReceipt(f, layoutVersion) {
  const executableRelative=path.join("Engine.app","Contents","MacOS","runner"), executable=path.join(f.moduleRoot,"game",executableRelative), binary="released runtime executable";
  write(executable,binary);write(path.join(f.moduleRoot,"game","data","stage.glb"),"private model bytes");write(path.join(f.moduleRoot,"saves","stats.json"),"private progress");
  const record={layoutVersion,version:"1.0.0",binarySha256:require("node:crypto").createHash("sha256").update(binary).digest("hex"),gameRoot:f.sourceRoot,executableRelative,assetRepairs:[{reference:"data/x.snd",asset:"data/moved/x.snd"}],privateFact:"retained metadata"};
  const file=path.join(f.moduleRoot,"staged-runtime.json");write(file,JSON.stringify(record));return {file,record,executable};
}
test("Ikemen once-only backcompat normalizes released4/5 receipts without touching game or player bytes", t => {
  t.mock.method(Ikemen.runtimeManagers[0],"resolveSelection",()=>assert.fail("receipt format conversion uses its own pinned identity"));
  for(const version of [4,5]){
    const f=fixture(t,"ikemen"), old=releasedIkemenReceipt(f,version), stat=fs.statSync(old.executable,{bigint:true});
    assert.deepEqual(modules.ikemen.migrateLegacyGameData(f.entry,f),{complete:true,converted:true});
    assert.deepEqual(JSON.parse(fs.readFileSync(old.file)),{...old.record,layoutVersion:6});
    assert.equal(fs.readFileSync(old.executable,"utf8"),"released runtime executable");assert.equal(fs.statSync(old.executable,{bigint:true}).mtimeNs,stat.mtimeNs);
    assert.equal(fs.lstatSync(path.join(f.moduleRoot,"game","data","stage.glb")).isSymbolicLink(),false);
    assert.equal(fs.readFileSync(path.join(f.moduleRoot,"saves","stats.json"),"utf8"),"private progress");
    const current=fs.statSync(old.file,{bigint:true});assert.deepEqual(modules.ikemen.migrateLegacyGameData(f.entry,f),{complete:true});assert.equal(fs.statSync(old.file,{bigint:true}).mtimeNs,current.mtimeNs);
  }
});
test("Ikemen once-only backcompat refuses corrupt pinned executables or unsafe receipts without blessing or deleting state", t => {
  for(const damage of ["binary","path","identity"]){
    const f=fixture(t,"ikemen"), old=releasedIkemenReceipt(f,5);
    if(damage==="binary")write(old.executable,"changed runtime");
    if(damage==="path")write(old.file,JSON.stringify({...old.record,executableRelative:"../outside"}));
    if(damage==="identity")write(old.file,JSON.stringify({...old.record,gameRoot:path.join(f.root,"other-game")}));
    const before=fs.readFileSync(old.file);const result=modules.ikemen.migrateLegacyGameData(f.entry,f);assert.equal(result.complete,false);assert.ok(result.reason);assert.deepEqual(fs.readFileSync(old.file),before);
    assert.equal(fs.readFileSync(path.join(f.moduleRoot,"saves","stats.json"),"utf8"),"private progress");
  }
});
test("Ikemen current-format launch has no released-layout conversion or per-Play backcompat callback", () => {
  const text=fs.readFileSync(path.join(__dirname,"../src/modules/ikemen/main.js"),"utf8");
  assert.doesNotMatch(text,/minimizeLegacyResources|layoutVersion\s*===\s*[45]|migrateLegacyGameData|backcompat/);
  assert.match(text,/prior\?\.layoutVersion !== 6/);
  assert.equal(Ikemen.migrateLegacyGameData,undefined);assert.equal(typeof modules.ikemen.migrateLegacyGameData,"function");
});
test("Ikemen once-only callback ignores obsolete receipt after direct-distribution mirror retirement", t => {
  const f=fixture(t,"ikemen");sameIkemen(t,f);const old=releasedIkemenReceipt(f,5), before=fs.readFileSync(old.file);
  fs.rmSync(path.join(f.moduleRoot,"game"),{recursive:true});
  assert.deepEqual(modules.ikemen.migrateLegacyGameData(f.entry,f),{complete:true});
  assert.deepEqual(fs.readFileSync(old.file),before,"obsolete receipt is neither used nor rewritten");
  assert.equal(fs.readFileSync(path.join(f.moduleRoot,"saves","stats.json"),"utf8"),"private progress");
});

test("GemRB post-copy descriptors persist original save fields without changing explicit or provider paths", async t => {
  const f=fixture(t,"gemrb");gemrbGame(f.sourceRoot);
  const old=path.join(f.moduleRoot,"saves"), external=path.join(f.root,"authored-save");
  write(path.join(old,"save","slot","BALDUR.GAM"),"released progress");
  f.entry.defaultSaveDir=old;f.entry.saveDirOverride=external;
  f.entry.saveLocations=[{id:"engine",directory:old},{id:"slot",directory:path.join(old,"save","slot")},{id:"provider",directory:external,provider:"authored"}];
  const persisted=await persistMigration("gemrb",f);assert.equal(fs.existsSync(old),false);
  assert.equal(persisted.defaultSaveDir,f.sourceRoot,"persisted before current preparation");
  const launch=GemRB.__test.prepareLaunch(persisted,f);
  assert.equal(persisted.defaultSaveDir,f.sourceRoot);assert.equal(persisted.saveDirOverride,external);
  assert.deepEqual(persisted.saveLocations,[{id:"engine",directory:f.sourceRoot},{id:"slot",directory:path.join(f.sourceRoot,"save","slot")},{id:"provider",directory:external,provider:"authored"}]);
  assert.equal(launch.config.SavePath,external);assert.equal(launch.config.GamePath,f.sourceRoot);
  const preserved={...persisted,defaultSaveDir:old,saveDirOverride:old,saveLocations:[{directory:old}]};
  const protectedEntry=await persistMigration("gemrb",f,preserved);
  assert.equal(protectedEntry.defaultSaveDir,old);assert.equal(protectedEntry.saveLocations[0].directory,old);
  assert.equal(modules.gemrb.migrateLegacyGameData,undefined);
});

test("HashLink post-copy descriptors persist original nested bytecode and cwd saves before current preparation", async t => {
  const f=fixture(t,"hashlink"), view=path.join(f.moduleRoot,"writable-input","files"), boot=path.join(f.sourceRoot,"nested","game.hl"), old=path.join(f.moduleRoot,"game"), external=path.join(f.root,"provider");
  write(boot,"original bytecode");write(path.join(view,"nested","game.hl"),"original bytecode");write(path.join(old,"progress.json"),"released progress");
  f.entry.contentRootDir=view;f.entry.moduleData={writableInput:{schemaVersion:1,root:view,sourceRoot:f.sourceRoot},bytecodePath:path.join(view,"nested","game.hl"),authoredFact:"keep"};
  f.entry.defaultSaveDir=old;f.entry.saveDirOverride=external;
  f.entry.saveLocations=[{directory:path.join(old,"progress.json")},{directory:path.join(view,"nested")},{directory:external,provider:"authored"}];
  const persisted=await persistMigration("hashlink",f);
  assert.equal(fs.existsSync(path.join(view,"nested","game.hl")),false,"old bytecode path really was retired");
  const launch=HashLink.__test.prepareLaunch(persisted);
  assert.equal(launch.bytecodePath,boot);assert.equal(launch.root,path.dirname(boot));assert.equal(fs.readFileSync(path.join(launch.root,"progress.json"),"utf8"),"released progress");
  assert.equal(persisted.defaultSaveDir,path.dirname(boot));assert.equal(persisted.saveDirOverride,external);assert.equal(persisted.moduleData.authoredFact,"keep");
  assert.deepEqual(persisted.saveLocations,[{directory:path.join(path.dirname(boot),"progress.json")},{directory:path.dirname(boot)},{directory:external,provider:"authored"}]);
  const preserved={...persisted,defaultSaveDir:old,saveDirOverride:old,saveLocations:[{directory:old}]};
  const protectedEntry=await persistMigration("hashlink",f,preserved);assert.equal(protectedEntry.defaultSaveDir,old);assert.equal(protectedEntry.saveLocations[0].directory,old);
  assert.equal(modules.hashlink.migrateLegacyGameData,undefined);
});

test("Ikemen post-copy descriptors persist direct save fields and leaves a live separate runtime unchanged", async t => {
  const f=fixture(t,"ikemen"), install=sameIkemen(t,f), old=path.join(f.moduleRoot,"saves"), save=path.join(f.sourceRoot,"save"), external=path.join(f.root,"provider");
  write(install.executablePath,"native fixture");write(path.join(f.sourceRoot,"external","script","main.lua"),"runtime script");
  write(path.join(f.sourceRoot,"data","system.def"),"[Info]\nmugenversion=1.1\n[Files]\nselect=select.def\n");write(path.join(f.sourceRoot,"data","select.def"),"[Characters]\n");
  fs.mkdirSync(save);write(path.join(old,"stats.json"),"released statistics");
  f.entry.moduleData={motifRelative:path.join("data","system.def")};f.entry.defaultSaveDir=old;f.entry.saveDirOverride=save;
  f.entry.saveLocations=[{directory:old},{directory:path.join(f.moduleRoot,"game","save","stats.json")},{directory:external,provider:"authored"}];
  const persisted=await persistMigration("ikemen",f);assert.equal(fs.existsSync(old),false);
  assert.equal(persisted.defaultSaveDir,save,"persisted before current preparation");
  const launch=Ikemen.__test.prepareLaunch(persisted,f,install);
  assert.equal(persisted.defaultSaveDir,save);assert.equal(persisted.saveDirOverride,save);assert.equal(launch.saveRoot,save);
  assert.deepEqual(persisted.saveLocations,[{directory:save},{directory:path.join(save,"stats.json")},{directory:external,provider:"authored"}]);
  assert.equal(fs.readFileSync(path.join(launch.saveRoot,"stats.json"),"utf8"),"released statistics");
  t.mock.method(Ikemen.runtimeManagers[0],"resolveSelection",()=>({ready:true,install:{...install,executablePath:path.join(f.root,"separate","runner")}}));
  const live={...persisted,defaultSaveDir:old,saveDirOverride:external,saveLocations:[{directory:old}]};write(path.join(f.moduleRoot,"staged-runtime.json"),JSON.stringify({layoutVersion:6}));const before=JSON.stringify(live);
  const protectedEntry=await persistMigration("ikemen",f,live);assert.equal(JSON.stringify(protectedEntry),before);
});
