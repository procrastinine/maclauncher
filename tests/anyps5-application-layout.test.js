const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Prepare=require('../src/modules/anyps5/prepare');
const {fixture}=require('./helpers/anyps5-preparation-fixture.cjs');
const Icons=require('../src/core/icon-utils');
const png=Icons.encodePngBitmap({width:256,height:256,buffer:Buffer.alloc(256*256*4,255)});
const renderIcon=async()=>png;

test('AnyPS5 converts directly into a game-named bundle entry and reuses it',async t=>{
 const f=fixture(t);f.entry.name='Hollow Knight';
 const prepare=()=>Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon});
 const first=await prepare();assert.equal(first.cached,false);
 assert.equal(first.executable,path.join(first.app,'Contents/MacOS/Hollow Knight'));
 assert.equal(fs.lstatSync(first.executable).isSymbolicLink(),false);
 assert.ok(fs.existsSync(path.join(first.directory,'app0/assets/data.bin')));
 assert.ok(fs.existsSync(path.join(first.directory,'sce_module/helper.guest.prx')));
 assert.equal(fs.readlinkSync(path.join(first.directory,'libs')),path.join(f.runtime,'libs'));
 const plist=fs.readFileSync(path.join(first.app,'Contents/Info.plist'),'utf8');
 for(const key of ['CFBundleName','CFBundleDisplayName','CFBundleExecutable'])assert.ok(plist.includes(`<key>${key}</key><string>Hollow Knight</string>`));
 assert.match(plist,/com.maclauncher.anyps5.fixture/);assert.match(plist,/Game.icns/);
 assert.ok(fs.existsSync(path.join(first.app,'Contents/Resources/Game.icns')));
 const stat=fs.statSync(first.executable);assert.equal((await prepare()).cached,true);assert.equal(f.calls(),1);assert.equal(fs.statSync(first.executable).ino,stat.ino);
 f.entry.name='A renamed game';const renamed=await prepare();assert.equal(renamed.cached,true);assert.equal(f.calls(),1);
 assert.equal(fs.existsSync(first.executable),false);assert.equal(fs.statSync(renamed.executable).ino,stat.ino);
});

test('legacy eboot preparation migrates in place without conversion, payload copies or lost private writes',async t=>{
 const f=fixture(t),prepare=()=>Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon});
 const first=await prepare(),root=Prepare.gameDirectory(f.entry,f.context),legacy=path.join(root,'launch');
 // Reconstitute the exact old layout and schema-2 preparation receipt.
 fs.renameSync(first.executable,path.join(first.directory,'eboot'));
 fs.renameSync(first.directory,legacy);fs.rmSync(first.app,{recursive:true});fs.rmSync(path.join(root,'application.json'));
 const executableStat=fs.statSync(path.join(legacy,'eboot'));
 fs.writeFileSync(path.join(legacy,'app0/assets/data.bin'),'private asset write');
 fs.mkdirSync(path.join(legacy,'_sd_mem'));fs.writeFileSync(path.join(legacy,'_sd_mem/state'),'private state');
 const assetStat=fs.statSync(path.join(legacy,'app0/assets/data.bin'));
 const Copy=require('../src/modules/shared/copy-file');t.mock.method(Copy,'cloneOrCopySync',()=>assert.fail('Migration must not copy'));
 const migrated=await prepare();assert.equal(migrated.cached,true);assert.equal(f.calls(),1);
 assert.equal(fs.statSync(migrated.executable).ino,executableStat.ino);
 assert.equal(fs.statSync(path.join(migrated.directory,'app0/assets/data.bin')).ino,assetStat.ino);
 assert.equal(fs.readFileSync(path.join(migrated.directory,'_sd_mem/state'),'utf8'),'private state');
 assert.equal(fs.readFileSync(path.join(migrated.directory,'app0/assets/data.bin'),'utf8'),'private asset write');
 assert.equal(fs.existsSync(legacy),false);
});

test('an interrupted executable rename resumes and does not retain either old name',async t=>{
 const f=fixture(t),prepare=()=>Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon});
 const initial=await prepare(),receipt=path.join(Prepare.gameDirectory(f.entry,f.context),'application.json');
 fs.writeFileSync(receipt,JSON.stringify({executableName:'Interrupted name',previousExecutableName:'Fixture Game'}));
 f.entry.name='Final name';const next=await prepare();assert.equal(next.cached,true);assert.equal(f.calls(),1);
 assert.equal(fs.existsSync(initial.executable),false);assert.equal(fs.existsSync(path.join(initial.directory,'Interrupted name')),false);
 assert.ok(fs.existsSync(next.executable));assert.equal(path.basename(next.executable),'Final name');
});

test('conflicting legacy and bundle layouts preserve both directories',async t=>{
 const f=fixture(t),current=await Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon});
 const legacy=path.join(Prepare.gameDirectory(f.entry,f.context),'launch');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'keep'),'private');
 await assert.rejects(Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon}),/conflicting directories/);
 assert.ok(fs.existsSync(current.executable));assert.equal(fs.readFileSync(path.join(legacy,'keep'),'utf8'),'private');
});

test('program inspection accepts both legacy and bundled import registries',async t=>{
 const f=fixture(t),Tools=require('../src/modules/anyps5/tools'),root=Prepare.gameDirectory(f.entry,f.context);
 const legacy=path.join(root,'launch');fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'eboot.registry.json'),'[{},{}]');
 assert.equal(Tools.inspectExecutable(f.entry,null,f.context).importCount,2);
 await Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon});
 assert.equal(Tools.inspectExecutable(f.entry,null,f.context).importCount,0);
});
