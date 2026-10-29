const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Library=require('../src/modules/shared/reshade/xess/library'),{coordinatorFor}=require('../src/core/runtime-coordinator');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xess-components-'))),userDataDir=path.join(root,'profile'),sdk=path.join(root,'sdk','bin');fs.mkdirSync(userDataDir);fs.mkdirSync(sdk,{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const spec of [Library.Source,...Library.Components.files]){const bytes=Buffer.from('Original fixture '+spec.file);t.mock.property(spec,'bytes',bytes.length);t.mock.property(spec,'sha256',digest(bytes));fs.writeFileSync(path.join(sdk,spec.file),bytes);}
 t.mock.method(globalThis,'fetch',()=>assert.fail('Local SDK discovery/import stays offline'));
 return {userDataDir,sdk,sr:path.join(sdk,Library.Source.file),fg:path.join(sdk,'libxess_fg.dll'),ll:path.join(sdk,'libxell.dll')};
}
test('original SDK companions register by reference without copying or downloading an existing runtime',async t=>{
 const f=fixture(t),before=Object.fromEntries(fs.readdirSync(f.sdk).map(name=>[name,fs.readFileSync(path.join(f.sdk,name))]));
 await Library.importRuntime({...f,runtimePath:f.sr});let consent=0;
 const installed=await Library.install({...f,operation:'interpolate',confirmRuntimeInstall:()=>{++consent;assert.fail('Already present SDK companions need no download');}});
 assert.equal(consent,0);assert.equal(installed.external,true);assert.deepEqual(installed.libraries,{frameGeneration:f.fg,latency:f.ll});
 assert.deepEqual(Library.listInstalled(f.userDataDir)[0].capabilities,['superresolution','interpolate']);
 const uses=[];const selected=await Library.resolve(f.userDataDir,{operation:'interpolate',useRuntime:value=>uses.push(value)});
 assert.equal(selected.sourcePath,f.fg);assert.deepEqual(uses.map(value=>[value.sectionId,value.sourcePath]),[['interpolation',f.fg],['interpolation',f.ll]]);
 const managed=Library.directory(f.userDataDir);for(const name of ['libxess.dll','libxess_fg.dll','libxell.dll'])assert.equal(fs.existsSync(path.join(managed,name)),false);
 for(const [name,bytes]of Object.entries(before))assert.deepEqual(fs.readFileSync(path.join(f.sdk,name)),bytes);
 fs.writeFileSync(f.ll,Buffer.alloc(before['libxell.dll'].length,7));await assert.rejects(Library.resolve(f.userDataDir,{operation:'interpolate'}),/does not match/);
});
test('adding verified FG companions remains possible beside a live SR lease and removal protects both component leases',async t=>{
 const f=fixture(t);await Library.importRuntime({...f,runtimePath:f.sr});const client=coordinatorFor(f.userDataDir).client(),tokens=[];
 const sr=await client.acquireUse({managerId:Library.Source.managerId,sectionId:'default',version:Library.Source.version,sourcePath:f.sr});tokens.push(sr);await client.bindUse(sr,process.pid);t.after(async()=>{for(const token of tokens)await client.release(token);client.close();});
 const installed=await Library.install({...f,operation:'interpolate'});assert.equal(installed.sourcePath,f.fg);
 await Library.resolve(f.userDataDir,{operation:'interpolate',useRuntime:async identity=>{const token=await client.acquireUse(identity);tokens.push(token);await client.bindUse(token,process.pid);}});
 const before=fs.readFileSync(path.join(Library.directory(f.userDataDir),'interpolation.json'));
 await Library.importRuntime({...f,runtimePath:path.dirname(f.sdk),operation:'interpolate'});assert.deepEqual(fs.readFileSync(path.join(Library.directory(f.userDataDir),'interpolation.json')),before);
 await assert.rejects(Library.remove(f),{code:'RUNTIME_IN_USE'});
 await client.release(tokens.shift());await assert.rejects(Library.remove(f),{code:'RUNTIME_IN_USE'});
});
test('FG-only registration advertises only interpolation and removal preserves both original libraries',async t=>{
 const f=fixture(t);await Library.importRuntime({...f,runtimePath:f.fg});assert.deepEqual(Library.listInstalled(f.userDataDir)[0].capabilities,['interpolate']);
 await assert.rejects(Library.resolve(f.userDataDir),{code:'GRAPHICS_XESS_RUNTIME_MISSING'});
 assert.equal(await Library.install({...f,confirmRuntimeInstall:async()=>false}),null);assert.deepEqual(Library.listInstalled(f.userDataDir)[0].capabilities,['interpolate']);
 await Library.remove(f);assert.deepEqual(Library.listInstalled(f.userDataDir),[]);assert.equal(fs.existsSync(f.fg),true);assert.equal(fs.existsSync(f.ll),true);
});
test('an incompatible companion publishes no FG receipt and preserves an existing SR registration',async t=>{
 const f=fixture(t);await Library.importRuntime({...f,runtimePath:f.sr});const file=path.join(Library.directory(f.userDataDir),'runtime.json'),before=fs.readFileSync(file);
 fs.writeFileSync(f.ll,Buffer.alloc(fs.statSync(f.ll).size,2));await assert.rejects(Library.importRuntime({...f,runtimePath:f.sdk,operation:'interpolate'}),/does not match/);
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(Library.directory(f.userDataDir),'interpolation.json')),false);assert.deepEqual(Library.listInstalled(f.userDataDir)[0].capabilities,['superresolution']);
});
test('XeSS installation preserves Auto and exact user choices while enforcing the adapter SDK contract',async t=>{
 const f=fixture(t),Manager=require('../src/modules/shared/reshade/runtime/xess-manager');
 await Library.importRuntime({...f,runtimePath:f.sr});
 const installed=Library.listInstalled(f.userDataDir)[0];
 assert.deepEqual(Manager.updateSettingsAfterInstall({},installed),{defaultVersion:null});
 assert.deepEqual(Manager.normalizeSettings({defaultVersion:'another-sdk'}),{defaultVersion:'another-sdk'});
 assert.deepEqual(Manager.updateSettingsAfterInstall({defaultVersion:'another-sdk'},installed),{defaultVersion:'another-sdk'});
 assert.equal(Manager.getState({...f,root:path.join(f.userDataDir,'no-graphics'),settings:{}}).defaultVersion,null);
 const settings={runtimes:{[Library.Source.managerId]:{defaultVersion:'another-sdk'}}};
 await assert.rejects(Library.resolve(f.userDataDir,{settings}),/selected Intel SDK version/);
 await assert.rejects(Manager.installRuntime({...f,settings,confirmRuntimeInstall:()=>assert.fail('An incompatible choice cannot download')}),/selected Intel SDK version/);
 assert.equal((await Library.resolve(f.userDataDir)).version,Library.Source.version);
});
