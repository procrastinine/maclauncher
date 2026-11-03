const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const Prepare=require('../src/modules/anyps5/prepare');
const {fixture}=require('./helpers/anyps5-preparation-fixture.cjs');
test('AnyPS5 current container preserves flat, prepared and custom-save operation',async t=>{
 for(const options of [{prepared:false},{prepared:true},{prepared:true,override:true}])await t.test(JSON.stringify(options),async t=>{
  const f=fixture(t,options),launch=await Prepare.prepareGame(f.entry,f.context,f.install,{runCommand:f.runCommand}),saves=f.entry.saveDirOverride||path.join(Prepare.gameDirectory(f.entry,f.context),'saves');
  assert.equal(f.calls(),1);assert.equal(fs.existsSync(path.join(launch.directory,'eboot')),true);assert.equal(fs.readFileSync(path.join(launch.directory,'app0/assets/data.bin'),'utf8'),'original game data');assert.equal(fs.readlinkSync(path.join(launch.directory,'data')),saves);assert.equal(fs.readlinkSync(path.join(launch.directory,'_sd')),path.join(saves,'_sd'));assert.equal(f.entry.defaultSaveDir,saves);assert.equal(fs.readFileSync(path.join(f.assets,'assets/data.bin'),'utf8'),'original game data');
  const privateAsset=path.join(launch.directory,'app0/assets/data.bin');fs.writeFileSync(privateAsset,'private edited asset');const replacement={...f.install,version:'updated-runtime'};await Prepare.prepareGame(f.entry,f.context,replacement,{runCommand:f.runCommand});assert.equal(fs.readFileSync(privateAsset,'utf8'),'private edited asset');assert.equal(fs.readFileSync(path.join(f.assets,'assets/data.bin'),'utf8'),'original game data');
  for(const name of ['statSync','lstatSync','readdirSync','mkdirSync'])t.mock.method(fs,name,()=>{throw Error('Save metadata must not probe directories.');});const locations=Prepare.resolveSaveLocations(f.entry,f.context);assert.equal(locations.primaryDirectory,saves);assert.deepEqual(locations.directories.map(item=>item.directory),[saves,path.join(saves,'_sd'),path.join(Prepare.gameDirectory(f.entry,f.context),'launch/_sd_mem')]);assert.ok(!locations.directories.some(item=>item.directory.endsWith('download0')));
 });
});
