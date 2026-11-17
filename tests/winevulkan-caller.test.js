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
function ownedClient(){
  const bytes=builtin(),pe=bytes.readUInt32LE(60),optional=pe+24,section=optional+bytes.readUInt16LE(pe+20),raw=bytes.readUInt32LE(section+20),rva=bytes.readUInt32LE(section+12);
  bytes.writeUInt32LE(0x60000020,section+36);bytes.writeUInt32LE(rva,optional+112);bytes.writeUInt32LE(0x200,optional+116);
  bytes.writeUInt32LE(rva+0x90,raw+12);bytes.writeUInt32LE(2,raw+20);bytes.writeUInt32LE(2,raw+24);
  bytes.writeUInt32LE(rva+0x50,raw+28);bytes.writeUInt32LE(rva+0x60,raw+32);bytes.writeUInt32LE(rva+0x70,raw+36);
  bytes.writeUInt32LE(rva+0x300,raw+0x50);bytes.writeUInt32LE(rva+0x310,raw+0x54);
  bytes.writeUInt32LE(rva+0xc0,raw+0x60);bytes.writeUInt32LE(rva+0xd8,raw+0x64);bytes.writeUInt16LE(0,raw+0x70);bytes.writeUInt16LE(1,raw+0x72);
  bytes.write('maclauncher-winevulkan-scene.dll\0',raw+0x90);bytes.write('vkCreateInstance\0',raw+0xc0);bytes.write('vkGetInstanceProcAddr\0',raw+0xd8);
  return bytes;
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
  const client=put(path.join(component,'temporal/vulkan/aarch64-windows/client.dll'),ownedClient());
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
function moduleFixture(t){
  const f=graphicsFixture(t),root=path.join(f.root,'module'),bytes=builtin(),pe=bytes.readUInt32LE(60),optional=pe+24,section=optional+bytes.readUInt16LE(pe+20),raw=bytes.readUInt32LE(section+20),rva=bytes.readUInt32LE(section+12);
  // Authored export-table records carry no executable implementation and are
  // never run; the module consumer checks their declared executable section.
  bytes.writeUInt32LE(0x60000020,section+36);bytes.writeUInt32LE(rva,optional+112);bytes.writeUInt32LE(0x200,optional+116);
  bytes.writeUInt32LE(rva+0x90,raw+12);bytes.writeUInt32LE(2,raw+20);bytes.writeUInt32LE(2,raw+24);
  bytes.writeUInt32LE(rva+0x50,raw+28);bytes.writeUInt32LE(rva+0x60,raw+32);bytes.writeUInt32LE(rva+0x70,raw+36);
  bytes.writeUInt32LE(rva+0x300,raw+0x50);bytes.writeUInt32LE(rva+0x310,raw+0x54);
  bytes.writeUInt32LE(rva+0xc0,raw+0x60);bytes.writeUInt32LE(rva+0xd8,raw+0x64);bytes.writeUInt16LE(0,raw+0x70);bytes.writeUInt16LE(1,raw+0x72);
  bytes.write('maclauncher-winevulkan-scene.dll\0',raw+0x90);bytes.write('vkCreateInstance\0',raw+0xc0);bytes.write('vkGetInstanceProcAddr\0',raw+0xd8);
  const client=put(path.join(root,'aarch64-windows/winevulkan.dll'),bytes),native=put(path.join(root,'aarch64-unix/winevulkan.so'),fs.readFileSync(f.native));
  const originalNative=put(path.join(f.engine,'lib/wine/aarch64-unix/winevulkan.so'),image({cpu:ARM64,dependencies:['@rpath/ntdll.so','@rpath/win32u.so']}));
  const profile=structuredClone(f.pair.runtimeProfile);profile.files.push({relative:'lib/wine/aarch64-unix/winevulkan.so',sha256:digest(originalNative)});
  const files=[client,native].map(file=>({path:path.relative(root,file),sha256:digest(file),size:fs.statSync(file).size,mode:0o755}));
  const manifest={schemaVersion:1,managerId:'winevulkan-scene',version:'1.0.0',arch:'arm64',platform:'darwin',minimumMacOS:'13.0',executableRelative:'aarch64-unix/winevulkan.so',files,
    provider:{schema:1,provider:'winevulkan-scene',libraries:{'aarch64-windows':files[0].path,'aarch64-unix':files[1].path},runtimeProfile:profile,files:structuredClone(files)}};
  put(path.join(root,'manifest.json'),JSON.stringify(manifest));
  return{...f,moduleRoot:root,moduleNative:native,moduleClient:client,manifest,profile};
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

test('managed WineVulkan defaults use complete local module pairs and the actual Wine CPU offline', async t=>{
  const f=moduleFixture(t),Tool=require('../src/modules/crossover/temporal/vulkan/manager'),Architecture=require('../src/modules/shared/runtime/architecture');
  const manager=Tool.createManager({systemVersionSync:()=> '26.0',hostArch:'arm64'}),userDataDir=path.join(f.root,'profile');
  Architecture.withArchitecture('arm64',()=>manager.core.registerLocal({userDataDir,version:'local-module',runtimePath:f.moduleNative}));
  const contexts=[],resolve=manager.resolveSelection;manager.resolveSelection=function(...args){contexts.push(Architecture.selectedArchitecture());return resolve.apply(this,args);};
  manager.ensure=()=>assert.fail('ordinary Play must not open a late tool prompt');manager.refreshCatalog=()=>assert.fail('installed selection is offline');
  const uses=[],recorded=[],entry={runtimeId:'metalsharp-wine',runtimeData:{'metalsharp-wine':{version:'7.0'}}},context={settings:{runtimes:{[manager.id]:{defaultVersion:'local-module'}}},userDataDir,
    translatorPlan:{layout:require('../src/modules/shared/runtime/wine-layout').wineLayout(f.install),components:{'vulkan-driver':{used:{engine:'moltenvk'}}}},
    useRuntime:async value=>uses.push(value),recordRuntimeUse:value=>recorded.push(value)};
  t.mock.method(Publication,'forRoot',()=>assert.fail('ready selected helper requires no component lookup'));
  const selected=await Architecture.withArchitecture('x64',()=>Graphics.prepareWineVulkan(entry,context,f.install,{manager}));
  assert.equal(selected.native.file,f.moduleNative);assert.equal(uses[0].managerId,manager.id);assert.deepEqual(contexts,['arm64']);
  assert.deepEqual(await Graphics.wineVulkanRequirements(entry,context,{install:f.install,manager}),[]);assert.equal(recorded[0].version,'local-module');
  require('../src/modules/shared/runtime/custom-runtime').instrumentManagers([manager]);
  await manager.registerCustomRuntime({runtimePath:f.moduleNative,userDataDir});
  const custom={...context,settings:{runtimes:{[manager.id]:{customDefaults:{default:f.moduleNative}}}}};
  assert.equal((await Graphics.prepareWineVulkan(entry,custom,f.install,{manager})).native.file,f.moduleNative,'ordinary custom helper defaults use the full module payload');
});

test('a missing matching WineVulkan helper joins the ordinary single Play consent before installation',async t=>{
  const f=moduleFixture(t),pin={version:'1.0.0',runtimeProfile:f.profile,asset:{bytes:42}},entry={name:'Fixture',effects:{}},events=[];
  const manager={id:'winevulkan-scene',label:'WineVulkan helper',core:{catalog:[pin]},resolveSelection:(_entry,_settings,_root,options)=>{if(options.compatible)assert.equal(options.compatible(pin),true);return{ready:false,version:pin.version};},
    getState:()=>({installed:[]}),installRuntime(){},ensure:()=>assert.fail('no late ensure prompt')};
  const context={runtimeId:'metalsharp-wine',runtimeSettings:{dlss:true},settings:{runtimes:{}},userDataDir:path.join(f.root,'profile'),
    translatorPlan:{layout:require('../src/modules/shared/runtime/wine-layout').wineLayout(f.install),components:{'vulkan-driver':{used:{engine:'moltenvk'}}}}};
  const plans=await Graphics.wineVulkanRequirements(entry,context,{install:f.install,manager,root:path.join(f.root,'absent-component')});
  assert.equal(plans.length,1);assert.equal(plans[0].installOptions.architecture,'arm64');assert.deepEqual(events,[]);
  const engine={id:'engine',label:'Engine',getState:()=>({installed:[]}),installRuntime(){}};
  await require('../src/core/runtime-preparation').prepareForLaunch({entry,mod:{getRuntimeRequirements:async()=>[{managerId:'engine',version:'2.0',label:'Engine'},...plans]},info:{},context:{...context,
    confirmRuntimeInstall:async value=>{events.push(['consent',value]);return true;}},registry:{listModuleIds:()=>[],listSharedRuntimeManagers:()=>[engine,manager]},
    install:async item=>{assert.equal(events[0][0],'consent');events.push(['install',item.id]);}});
  assert.equal(events.filter(row=>row[0]==='consent').length,1);assert.equal(events.filter(row=>row[0]==='install').length,2);
  pin.runtimeProfile={files:[]};assert.deepEqual(await Graphics.wineVulkanRequirements(entry,context,{install:f.install,manager,root:path.join(f.root,'absent-component')}),[],'an unprofiled helper is not downloaded for an unsupported Wine');
});

test('WineVulkan registration is a Tools manager and never a game execution runtime',()=>{
  const module=require('../src/modules/crossover/main'),manager=module.runtimeManagers.find(row=>row.id==='winevulkan-scene');
  assert.equal(manager.ui.groupId,'tools');assert.equal(module.runtimeProviders.some(row=>row.runtimeId===manager.id),false);
});

test('WineVulkan per-prefix views preserve the initialized Wine image and independent session ownership',async t=>{
  const f=moduleFixture(t),module=require('../src/modules/crossover/temporal/vulkan/manager').inspectPayload(f.moduleRoot);
  const layout=require('../src/modules/shared/runtime/wine-layout').wineLayout(f.install),selection=Graphics.wineVulkanSelection(f.moduleRoot,f.install,{module,layout});
  const dllRoot=path.join(f.root,'view/lib/wine'),ntdll=put(path.join(dllRoot,layout.unixName,'ntdll.so'),fs.readFileSync(path.join(layout.unixRoot,'ntdll.so'))),inode=fs.statSync(ntdll).ino;
  fs.symlinkSync(path.join(layout.unixRoot,'win32u.so'),path.join(dllRoot,layout.unixName,'win32u.so'));
  const sessions=[];
  for(const name of ['one','two']){
    const prefixPath=path.join(f.root,name),original=put(path.join(prefixPath,'drive_c/windows/system32/winevulkan.dll'),fs.readFileSync(selection.client.original.file));
    const originalInode=fs.statSync(original).ino,view=await Graphics.prepareWineVulkanView(selection,{prefixPath,dllRoot,layout});
    assert.equal(fs.realpathSync(path.join(path.dirname(view.native.file),'ntdll.so')),ntdll);
    await view.applyPrefix();assert.equal(fs.realpathSync(original),selection.client.file);sessions.push({view,original,originalInode});
  }
  assert.notEqual(sessions[0].view.native.file,sessions[1].view.native.file);
  await sessions[0].view.restore();assert.ok(fs.existsSync(sessions[1].view.native.file),'a different prefix retains its active native copy');
  await sessions[1].view.restore();
  for(const session of sessions){assert.equal(fs.statSync(session.original).ino,session.originalInode);assert.equal(digest(session.original),selection.client.original.sha256);}
  assert.equal(fs.statSync(ntdll).ino,inode);assert.equal(digest(ntdll),selection.native.dependencies.find(row=>row.name==='ntdll.so').sha256);
});

test('legacy builtin export names preserve the publisher route without acquiring a helper lease',async t=>{
  const f=moduleFixture(t),bytes=fs.readFileSync(f.moduleClient),pe=bytes.readUInt32LE(60),section=pe+24+bytes.readUInt16LE(pe+20),raw=bytes.readUInt32LE(section+20);
  bytes.fill(0,raw+0x90,raw+0xb8);bytes.write('winevulkan.dll\0',raw+0x90);fs.writeFileSync(f.moduleClient,bytes);
  for(const row of [...f.manifest.files,...f.manifest.provider.files])if(row.path==='aarch64-windows/winevulkan.dll')row.sha256=digest(f.moduleClient);
  put(path.join(f.moduleRoot,'manifest.json'),JSON.stringify(f.manifest));
  const inspector=require('../src/modules/crossover/temporal/vulkan/manager'),manager={id:'winevulkan-scene',core:{catalog:[]},resolveSelection:()=>({ready:true,version:'legacy',install:{modulePayloadRoot:f.moduleRoot}}),inspectPayload:inspector.inspectPayload};
  const context={settings:{},userDataDir:path.join(f.root,'profile'),useRuntime:()=>assert.fail('unsupported helper is not leased'),translatorPlan:{layout:require('../src/modules/shared/runtime/wine-layout').wineLayout(f.install),components:{'vulkan-driver':{used:{engine:'moltenvk'}}}}};
  assert.equal(await Graphics.prepareWineVulkan({},context,f.install,{manager,root:path.join(f.root,'absent-component')}),null);
});

// MetalSharp Wine's loader ignores DYLD variables but loads unsigned libraries. On its Vulkan values (DXVK,
// vkd3d-proton) no Metal shim loads, so the WineVulkan client is what applies the graphics libraries.
const metalsharpSignature = `CodeDirectory v=20500 size=447 flags=0x10000(runtime) hashes=3+7 location=embedded\n[Dict]\n` +
  ['com.apple.security.cs.allow-jit','com.apple.security.cs.disable-library-validation'].map(key=>`\t[Key] ${key}\n\t[Value]\n\t\t[Bool] true\n`).join('');
function hardenedLoader(f,signature=metalsharpSignature){
  const unix=path.join(f.engine,'lib/wine/aarch64-unix'),bundle=path.join(unix,'wine.app/Contents');
  fs.rmSync(path.join(unix,'wine'));put(path.join(bundle,'MacOS/wine'),image({cpu:ARM64,fileType:2}));put(path.join(bundle,'embedded.provisionprofile'),'fixture');
  fs.symlinkSync('wine.app/Contents/MacOS/wine',path.join(unix,'wine'));
  Graphics.graphicsLayerRoute(f.install,{readSignature:()=>signature});
}
test('a hardened Wine loader on a Vulkan graphics value asks for a WineVulkan client that applies the graphics libraries',async t=>{
  const Policy=require('../src/core/runtime-resolution/graphics-policy');
  assert.equal(Policy.graphicsModule({runtime:'metalsharp-wine'}),'winemetal','unset, Mullion renders through winemetal');
  for(const value of ['dxvk','vkd3d'])assert.equal(Policy.graphicsModule({runtime:'metalsharp-wine',graphicsPolicy:{value}}),'winevulkan',value);
  assert.equal(Policy.graphicsModule({runtime:'metalsharp-wine',graphicsPolicy:{value:'wine'}}),null,'Wine\'s own libraries name no module');
  assert.equal(Policy.graphicsModule({runtime:'sikarugir'}),null);
  const f=moduleFixture(t);hardenedLoader(f);
  const pin={version:'2.0.0',capabilities:{runtimeProfile:f.profile,graphicsLibraryAPI:1},asset:{bytes:42}};
  const manager={id:'winevulkan-scene',label:'WineVulkan helper',core:{catalog:[pin]},resolveSelection:()=>({ready:false,version:pin.version}),getState:()=>({installed:[]})};
  const plan=value=>({runtime:'metalsharp-wine',layout:require('../src/modules/shared/runtime/wine-layout').wineLayout(f.install),
    components:{'vulkan-driver':{used:{engine:'kosmickrisp'}}},...(value?{graphicsPolicy:{variable:'GRAPHICS_BACKEND',value,lanes:[]}}:{})});
  const ask=(effects,value,options={})=>Graphics.wineVulkanRequirements({name:'Fixture',effects},{runtimeId:'metalsharp-wine',runtimeSettings:{},settings:{runtimes:{}},userDataDir:path.join(f.root,'profile'),
    translatorPlan:plan(value)},{install:f.install,manager,root:path.join(f.root,'absent-component'),...options});
  const spatial={schema:2,mode:'advanced',enabled:true,video:[{id:'cas',kind:'spatial',enabled:true,method:'cas',settings:{}}]};
  assert.equal((await ask(spatial,'dxvk')).length,1,'a spatial filter on DXVK needs the client to attach');
  assert.equal((await ask(spatial,'vkd3d')).length,1);
  assert.deepEqual(await ask(spatial,null),[],'Mullion\'s winemetal applies them on the unset value');
  assert.deepEqual(await ask({schema:2,mode:'advanced',enabled:false,video:[]},'dxvk'),[],'no processing, no client');
  delete pin.capabilities.graphicsLibraryAPI;
  assert.deepEqual(await ask(spatial,'dxvk'),[],'a client without the graphics library constructor is not downloaded for it');
  const scene={schema:2,mode:'advanced',enabled:true,video:[{id:'t',kind:'temporal',enabled:true,method:'metalfx',settings:{}}]};
  assert.deepEqual(await ask(scene,'dxvk'),[],'scene inputs on a hardened loader need a client that also attaches the processor');
  pin.capabilities.graphicsLibraryAPI=1;
  assert.equal((await ask(scene,'dxvk')).length,1);
  // An installed client without the constructor leaves the attachment to a listed one that has it.
  const Tool=require('../src/modules/crossover/temporal/vulkan/manager');
  const local={...manager,inspectPayload:Tool.inspectPayload,
    resolveSelection:(_entry,_settings,_root,options)=>options?.compatible?{ready:false,version:pin.version}:{ready:true,version:'1.0.0',install:{modulePayloadRoot:f.moduleRoot}}};
  assert.equal((await ask(spatial,'dxvk',{manager:local})).length,1);
  f.manifest.provider.graphicsLibraryAPI=1;put(path.join(f.moduleRoot,'manifest.json'),JSON.stringify(f.manifest));
  assert.deepEqual(await ask(spatial,'dxvk',{manager:local}),[],'the installed client carries them');
});

test('the game process loads the graphics libraries through the WineVulkan client only when it carries them on a loader that loads unsigned libraries',t=>{
  const f=moduleFixture(t),carrying={graphicsLibraries:true};
  assert.equal(Graphics.inProcessGraphics(f.install,{vulkanSelection:carrying}),false,'a loader that honours DYLD variables takes the DYLD route');
  hardenedLoader(f);
  assert.equal(Graphics.inProcessGraphics(f.install,{vulkanSelection:carrying}),true);
  assert.equal(Graphics.inProcessGraphics(f.install,{vulkanSelection:{graphicsLibraries:false}}),false);
  assert.equal(Graphics.inProcessGraphics(f.install,{vulkanSelection:carrying,environment:{running:true}}),false,'a running Wine session keeps its own processes');
  assert.equal(Graphics.inProcessGraphics(f.install,{runtimeLibraryRoot:'/view/graphics-runtime'}),true);
  const strict=moduleFixture(t);hardenedLoader(strict,metalsharpSignature.replace('disable-library-validation','allow-unsigned-executable-memory'));
  assert.equal(Graphics.inProcessGraphics(strict.install,{vulkanSelection:carrying}),false,'library validation refuses an unsigned client');
  assert.match(fs.readFileSync(path.join(__dirname,'../src/modules/crossover/sources/wine-graphics.js'),'utf8'),
    /inProcessGraphics\(install, \{ runtimeLibraryRoot, vulkanSelection, environment \}\) \? \{ inProcessGraphics: true \} : \{\}/);
});
