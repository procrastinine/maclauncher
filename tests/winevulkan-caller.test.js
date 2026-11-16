const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const Provider = require('../src/modules/crossover/sources/provider');
const Sources = require('../src/modules/crossover/sources');
const Detection = require('../src/modules/crossover/detect');
const Lifecycle = require('../src/core/process-lifecycle');
const Processes = require('../src/modules/shared/runtime/wine-processes');
const { peFixture } = require('./helpers/pe-fixture');
const Graphics = require('../src/modules/crossover/sources/wine-graphics');
const Publication = require('../src/modules/shared/reshade/publication');
const Selection = require('../src/modules/crossover/temporal/vulkan/selection');
const { image, ARM64, X64 } = require('./fixtures/macho-image');
const crypto = require('node:crypto');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function put(file, bytes) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file; }
function builtin(cpu = 0xaa64) {
  const {bytes,peOffset}=peFixture({is64:true});bytes.writeUInt16LE(cpu,peOffset+4);bytes.writeUInt16LE(0x2002,peOffset+22);bytes.write('Wine builtin DLL\0',64);return bytes;
}
function graphicsFixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wine-vulkan-graphics-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const engine=path.join(root,'engine'), component=path.join(root,'graphics');
  const install={engineRoot:engine,executablePath:put(path.join(engine,'bin/wine'),image({cpu:ARM64})),serverPath:put(path.join(engine,'bin/wineserver'),image({cpu:ARM64}))};
  put(path.join(engine,'lib/wine/aarch64-unix/wine'),image({cpu:ARM64}));
  for(const name of ['ntdll.so','win32u.so'])put(path.join(engine,'lib/wine/aarch64-unix',name),image({cpu:ARM64}));
  for(const name of ['ntdll.dll','apisetschema.dll','winevulkan.dll'])put(path.join(engine,'lib/wine/aarch64-windows',name),builtin());
  put(path.join(engine,'share/wine/nls/c_932.nls'),'fixture');
  const client=put(path.join(component,'temporal/vulkan/aarch64-windows/client.dll'),builtin());
  const native=put(path.join(component,'temporal/vulkan/aarch64-unix/client.so'),image({cpu:ARM64,dependencies:['@rpath/ntdll.so','@rpath/win32u.so','/usr/lib/libSystem.B.dylib']}));
  const relative=file=>path.relative(engine,file).split(path.sep).join('/');
  const profileFiles=[path.join(engine,'lib/wine/aarch64-windows/winevulkan.dll'),...['ntdll.so','win32u.so'].map(name=>path.join(engine,'lib/wine/aarch64-unix',name))];
  const pair={client:{file:path.relative(component,client),sha256:digest(client)},native:{file:path.relative(component,native),sha256:digest(native)},runtimeProfile:{files:profileFiles.map(file=>({relative:relative(file),sha256:digest(file)}))}};
  const descriptor=path.join(component,'temporal/vulkan/selection.json');
  const manifest={files:[]};
  const publish=()=>{
    put(descriptor,JSON.stringify({schema:1,pairs:[pair]}));
    manifest.files=[descriptor,client,native].map(file=>({path:path.relative(component,file).split(path.sep).join('/'),size:fs.statSync(file).size,sha256:digest(file)}));
  };
  publish();t.mock.method(Publication,'forRoot',()=>manifest);
  return {root,engine,component,install,pair,publish,client,native};
}

function fixture(t, restore) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-builtin-caller-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'Game.exe');
  const pe=peFixture({ is64: true });pe.bytes.writeUInt16LE(2,pe.peOffset+22);pe.bytes.writeUInt16LE(2,pe.optional+68);
  fs.writeFileSync(executable, pe.bytes);
  const entry = Detection.decorateEntry({gameId:'wine-builtin-caller',moduleId:'crossover',gamePath:directory,importPath:executable});
  const plan = {directory,executablePath:executable,winePath:'/owned/wine',serverPath:'/owned/wineserver',args:[],environment:{},graphics:{restore}};
  const source = Sources.get('sikarugir'), launch = require('../src/modules/crossover/sources/wine-launch').forSource(source);
  const provider = Provider.createProvider({source,platform:'darwin',manager:{},launch:{...launch,prepareLaunch:async()=>plan}});
  const child = Object.assign(new EventEmitter(),{pid:617,stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null});
  return {directory,entry,plan,provider,child};
}

test('Wine builtin restoration follows owned process retirement and runs once', async t => {
  let restored = 0, finish;
  const pending = new Promise(resolve => {finish=resolve;}), f = fixture(t,async()=>{restored++;});
  t.mock.method(Processes,'installStopHandler',context=>{
    const previous=context.onProcessSpawn;
    context.onProcessSpawn=child=>{Lifecycle.bindProcessStop(child,()=>pending);return previous?.(child);};
  });
  const context={spawnDetachedChecked:async function(){await this.onProcessSpawn?.(f.child);return f.child;}};
  assert.equal(await f.provider.launchRuntime('sikarugir',f.entry,context),f.child);
  assert.equal(restored,0);
  const stopping=Lifecycle.requestProcessStop(f.child);await Promise.resolve();
  f.child.exitCode=0;f.child.emit('exit',0,null);f.child.emit('close',0,null);
  await Promise.resolve();assert.equal(restored,0,'an exited root does not precede owned runtime retirement');
  finish(true);await stopping;await f.child.runtimeRetirement;
  assert.equal(restored,1);
  f.child.emit('close',0,null);await Promise.resolve();assert.equal(restored,1);
});

test('Wine builtin restoration runs when launch fails and retains the launch error', async t => {
  const original = new Error('spawn rejected'), conflict = new Error('later replacement preserved');
  let restored=0;const warnings=[],f=fixture(t,async()=>{restored++;throw conflict;});
  await assert.rejects(f.provider.launchRuntime('sikarugir',f.entry,{logger:{warn:(...args)=>warnings.push(args)},spawnDetachedChecked:async()=>{throw original;}}),error=>error===original);
  assert.equal(restored,1);assert.ok(warnings.some(args=>args.join(' ').includes(conflict.message)));
});

test('Wine builtin cleanup failure remains a rejected retirement', async t => {
  const conflict=new Error('later user replacement'),f=fixture(t,async()=>{throw conflict;});
  const warnings=[];await f.provider.launchRuntime('sikarugir',f.entry,{logger:{warn:(...args)=>warnings.push(args)},spawnDetachedChecked:async()=>f.child});
  f.child.exitCode=0;f.child.emit('exit',0,null);f.child.emit('close',0,null);
  await assert.rejects(f.child.runtimeRetirement,error=>error===conflict);
  assert.ok(warnings.some(args=>args.join(' ').includes(conflict.message)));
});

test('WineVulkan graphics pair follows measured Wine CPU and exact publisher ABI files', t => {
  const f=graphicsFixture(t), selected=Graphics.wineVulkanSelection(f.component,f.install);
  assert.equal(selected.client.file,f.client);assert.equal(selected.native.file,f.native);
  assert.deepEqual(selected.native.dependencies.map(row=>row.name),['ntdll.so','win32u.so']);
  assert.equal(selected.client.original.sha256,digest(path.join(f.engine,'lib/wine/aarch64-windows/winevulkan.dll')));
  f.pair.runtimeProfile.files=[];f.publish();assert.equal(Graphics.wineVulkanSelection(f.component,f.install),null,'labels alone are not ABI admission');
  f.pair.runtimeProfile.files=[{relative:'lib/wine/aarch64-unix/ntdll.so',sha256:'0'.repeat(64)}];f.publish();
  assert.equal(Graphics.wineVulkanSelection(f.component,f.install),null,'a different installed ABI preserves the publisher route');
});

test('WineVulkan pair refuses changed package bytes and ignores incompatible native CPU', t => {
  const f=graphicsFixture(t);
  fs.appendFileSync(f.native,'changed');assert.throws(()=>Graphics.wineVulkanSelection(f.component,f.install),/input changed/);
  put(f.native,image({cpu:X64}));f.pair.native.sha256=digest(f.native);f.publish();
  assert.equal(Graphics.wineVulkanSelection(f.component,f.install),null);
});

test('WineVulkan selection applies after prefix registration and merges ordinary Wine overrides', async t => {
  const f=graphicsFixture(t), layout=require('../src/modules/shared/runtime/wine-layout').wineLayout(f.install);
  const prefix=path.join(f.root,'prefix'), events=[], observed=path.join(f.root,'view/candidate.so');
  // Reuse prepared authored loader headers; this check exercises selection,
  // not the independent native file-metadata copy implementation.
  for(const [from,to] of [
    [f.install.executablePath,'wine/bin/wine'],
    [path.join(f.engine,'lib/wine/aarch64-unix/wine'),'wine/MacLauncher Game.app/Contents/MacOS/wine'],
    [path.join(f.engine,'lib/wine/aarch64-unix/ntdll.so'),'wine/MacLauncher Game.app/Contents/MacOS/ntdll.so'],
  ])put(path.join(f.root,'view',to),fs.readFileSync(from));
  t.mock.method(Selection,'prepareSelection',async options=>{
    assert.equal(fs.existsSync(path.join(prefix,'drive_c/windows/system32/ntdll.dll')),true,'stock prefix registration precedes selection');
    events.push('prepare');
    assert.deepEqual(options.native.dependencies.map(row=>row.name),['ntdll.so','win32u.so']);
    return {env:{WINEDLLPATH:'/selected',WINEDLLOVERRIDES:'winevulkan=b'},native:{file:observed,sha256:digest(f.native)},
      applyPrefix:async()=>{events.push('apply');},restore:async()=>{events.push('restore');}};
  });
  const graphics=await Graphics.prepareGraphicsView({source:{id:'fixture',label:'Fixture',nativeLibraries:()=>({libraries:[],frameworks:[]})},install:f.install,
    prefixPath:prefix,viewRoot:path.join(f.root,'view'),translatorPlan:{layout,components:{'d3d-renderer':{},'vulkan-driver':{}}},
    translatorView:{links:{},dllOverrides:['dxgi=b'],env:{WINEDLLPATH:'/existing'},libraryPaths:[],frameworkPaths:[]},vulkanSelection:Graphics.wineVulkanSelection(f.component,f.install)});
  assert.deepEqual(events,[],'the uninitialized prefix is not selected during graphics preparation');
  assert.equal(typeof graphics.restore,'function','cleanup is available before prefix mutation');
  await graphics.applyPrefix();assert.deepEqual(events,['prepare','apply']);
  assert.equal(graphics.env.WINEDLLPATH,'/selected:/existing');
  const env=require('../src/modules/crossover/sources/wine-launch').forSource(Sources.get('sikarugir')).buildEnvironment({},f.install,f.root,prefix,graphics,{baseEnvironment:{}}).environment;
  assert.ok(env.WINEDLLOVERRIDES.includes('winevulkan=b'));assert.ok(env.WINEDLLOVERRIDES.includes('dxgi=b'));
  assert.deepEqual(graphics.vulkanNative,{file:observed,sha256:digest(f.native)});
  await graphics.restore();assert.deepEqual(events,['prepare','apply','restore']);
});

test('Wine launch rejection after ownership stops its process before restoring the prefix', async t => {
  const original=new Error('ownership publication failed'),events=[],f=fixture(t,async()=>events.push('restore'));
  t.mock.method(Processes,'installStopHandler',context=>{
    const previous=context.onProcessSpawn;
    context.onProcessSpawn=child=>{Lifecycle.bindProcessStop(child,async()=>{events.push('stop');child.exitCode=0;child.emit('exit',0,null);return true;});return previous?.(child);};
  });
  await assert.rejects(f.provider.launchRuntime('sikarugir',f.entry,{spawnDetachedChecked:async function(){await this.onProcessSpawn(f.child);throw original;}}),error=>error===original);
  await f.child.runtimeRetirement;assert.deepEqual(events,['stop','restore']);
});
