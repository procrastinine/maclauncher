const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const Prepare=require('../src/modules/anyps5/prepare'),Application=require('../src/modules/shared/native-application'),Dock=require('../src/modules/shared/dock-icon');
const {fixture}=require('./helpers/anyps5-preparation-fixture.cjs');
test('both AnyPS5 backends prepare game bundle identity and original artwork without modifying runtime or imports',async t=>{
 for(const route of ['rosetta','fex'])await t.test(route,async t=>{
  const f=fixture(t),art=path.join(f.assets,'sce_sys/icon0.png');fs.mkdirSync(path.dirname(art),{recursive:true});fs.writeFileSync(art,await f.renderIcon());
  f.entry.iconSource='module-default';f.entry.iconPath=path.join(__dirname,'../src/modules/anyps5/resources/icon.png');
  const seen=[];const render=async source=>{seen.push(source);return f.renderIcon();};t.mock.method(Dock,'render',render);
  let prepared;
  if(route==='rosetta')prepared=await Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand,renderIcon:render});
  else {
   assert.equal(typeof Prepare.prepareFexGame,'function','FEX must consume the shared game identity in a game-owned native bundle');
   const bin=path.join(f.runtime,'AnyPS5.app/Contents/MacOS');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'anyps5-fex-start'),'unchanged signed host');fs.writeFileSync(path.join(bin,'libSDL2.dylib'),'unchanged native closure');
   const before=fs.readFileSync(path.join(bin,'anyps5-fex-start'));
   prepared=await Prepare.prepareFexGame(f.entry,f.context,{...f.install,executablePath:path.join(bin,'anyps5-fex-start')},{runApplicationCommand:async()=>({stdout:''})});
   assert.notEqual(prepared.executable,path.join(bin,'anyps5-fex-start'));
   assert.deepEqual(fs.readFileSync(prepared.executable),before);
   assert.deepEqual(fs.readFileSync(path.join(bin,'anyps5-fex-start')),before,'sealed supplier bytes unchanged');
   assert.equal(fs.readlinkSync(path.join(path.dirname(prepared.executable),'libSDL2.dylib')),path.join(bin,'libSDL2.dylib'));
   assert.deepEqual(prepared.args,[path.join(prepared.directory,'app0'),prepared.directory,'0','run',fs.realpathSync(f.programs)]);
  }
  const plist=fs.readFileSync(path.join(prepared.app,'Contents/Info.plist'),'utf8');
  assert.match(plist,/<key>CFBundleName<\/key><string>Fixture Game<\/string>/);
  assert.match(plist,/<key>CFBundleDisplayName<\/key><string>Fixture Game<\/string>/);
  assert.match(plist,/<key>LSUIElement<\/key><false\/>/);
  const iconName=/<key>CFBundleIconFile<\/key><string>([^<]+)<\/string>/.exec(plist)?.[1];assert.ok(iconName);
  assert.ok(fs.statSync(path.join(prepared.app,'Contents/Resources',iconName)).size>16);
  assert.ok(seen.includes(art),'original game artwork wins over module-default runtime artwork on both backends');
  assert.equal(fs.readlinkSync(path.join(prepared.directory,'data')),Prepare.saveDirectory(f.entry,f.context));
  assert.equal(fs.readlinkSync(path.join(prepared.directory,'_sd')),path.join(Prepare.saveDirectory(f.entry,f.context),'_sd'));
  assert.equal(fs.readFileSync(path.join(f.assets,'assets/data.bin'),'utf8'),'original game data');
 });
});
test('explicit library artwork remains the common identity source',t=>{
 const f=fixture(t);f.entry.iconSource='custom';f.entry.iconPath=path.join(f.root,'custom.png');fs.writeFileSync(f.entry.iconPath,'custom');
 assert.equal(typeof Prepare.applicationIdentity,'function');
 assert.equal(Prepare.applicationIdentity(f.entry,f.context,Prepare.resolveProgram(f.entry)).iconFile,f.entry.iconPath);
});
