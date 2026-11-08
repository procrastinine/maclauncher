const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const DLSS=require('../src/modules/crossover/temporal/vulkan-dlss');
const Selection=require('../src/modules/crossover/dlss');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'vulkan-dlss-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files={};for(const name of ['nvapi64.dll','nvngx.dll','dxgi.dll','driver.dylib']){files[name]=path.join(root,name);fs.writeFileSync(files[name],'owned-'+name);}
 const renderer={id:'renderer',engine:'dxvk',files:[{path:files['dxgi.dll'],machine:0x8664,format:'pe'}]};
 const driver={engine:'kosmickrisp',files:[{path:files['driver.dylib'],format:'macho'}]};
 const plan={apiMode:true,components:{d3d11:{used:renderer},d3d12:{used:{engine:'vkd3d-proton'}},'vulkan-driver':{used:driver}},placements:[{description:renderer,file:renderer.files[0],roles:['d3d11','d3d12']}]};
 const seen=[],managers=['dxvk-nvapi','vkd3d-proton'].map((id,i)=>({id,resolveSelection(){return{ready:true,version:'catalog-version',install:{executablePath:files[i?'nvngx.dll':'nvapi64.dll'],root}};}}));
 const inspect=file=>({machine:0x8664,exports:new Map((file===files['nvapi64.dll']?['nvapi_QueryInterface']:['NVSDK_NGX_D3D11_EvaluateFeature','NVSDK_NGX_D3D12_EvaluateFeature']).map(n=>[n,{executable:true}]))});
 return {root,files,plan,managers,inspect,seen,context:{runtimeSettings:{},useRuntime:async value=>seen.push(value)},opts:{runtimeManagers:managers,hasCarrier:()=>true,inspect},view:{identity:'old',native:[{name:'d3d12.dll',source:files['dxgi.dll']}],dllOverrides:['dxgi=n,b']}};
}
test('routes without a carrier have no package, driver-file or runtime-use work',async t=>{
 const f=fixture(t),options={runtimeManagers:[{resolveSelection(){throw Error('unused package');}}],hasCarrier(){throw Error('unused driver');}};
 // The runtime's own driver, as with CrossOver's automatic choice, has no carrier.
 const runtimeDriver={...f.plan,components:{...f.plan.components,'vulkan-driver':{used:null}}};
 assert.deepEqual(await DLSS.requirements({}, {runtimeSettings:{}}, {translatorPlan:runtimeDriver,architecture:'x86_64',...options}),[]);
 assert.deepEqual(await DLSS.requirements({}, {runtimeSettings:{}}, {architecture:'x86',...options}),[]);
 for(const [plan,architecture] of [[runtimeDriver,'x86_64'],[f.plan,'x86']]){
  const result=await DLSS.prepare({},f.context,{},plan,architecture,f.view,options);assert.equal(result.view,f.view);assert.equal(result.enabled,false);
 }
 assert.deepEqual(f.seen,[]);
});
test('an explicit carrier route offers both ordinary consented managed dependencies without a DLSS setting',async t=>{
 const f=fixture(t);const runtimeManagers=f.managers.map(m=>({...m,resolveSelection:()=>({ready:false,discoveryRequired:true})}));
 const rows=await DLSS.requirements({},{...f.context,runtimeSettings:{dlss:false}},{translatorPlan:f.plan,architecture:'x86_64',runtimeManagers,hasCarrier:()=>true});
 assert.deepEqual(rows.map(r=>r.managerId),['dxvk-nvapi','vkd3d-proton']);assert.ok(rows.every(r=>r.requiresDownload&&r.discoveryRequired&&!r.version));
});
test('both Vulkan drivers stage actual NVAPI and carrier NGX without changing translators',async t=>{
 const f=fixture(t),before=structuredClone(f.plan);
 const result=await DLSS.prepare({},f.context,{},f.plan,'x86_64',f.view,f.opts);
 assert.equal(result.enabled,true);assert.deepEqual(result.view.native.map(r=>r.name),['d3d12.dll','nvapi64.dll','nvngx.dll','_nvngx.dll']);assert.deepEqual(f.plan,before);assert.equal(f.view.native.length,1);assert.equal(f.seen.length,2);
 assert.equal(result.view.native[2].source,f.files['nvngx.dll']);assert.equal(result.view.native[3].source,f.files['nvngx.dll']);
 f.plan.components['vulkan-driver'].used.engine='moltenvk';assert.equal((await DLSS.prepare({},f.context,{},f.plan,'x86_64',f.view,f.opts)).driver,'moltenvk');
 const env=DLSS.environment(true,{DXVK_CONFIG:'dxgi.maxFrameRate = 60'});assert.match(env.DXVK_CONFIG,/maxFrameRate = 60/);assert.match(env.DXVK_CONFIG,/customVendorId = 10de/);assert.equal(env.DXVK_NVAPI_ALLOW_OTHER_DRIVERS,'1');assert.equal(env.DXVK_ENABLE_NVAPI,'1');
 assert.equal(Selection.checkSelection({dlss:true},{hardwareArch:'arm64',executableArchitecture:'x86_64',translatorPlan:f.plan,vulkan:true}).vulkan,true);
 assert.deepEqual(Selection.checkSelection({},{hardwareArch:'arm64',executableArchitecture:'x86_64',translatorPlan:f.plan,vulkan:true}),{enabled:true,dxmt:false,d3dmetal:false,vulkan:true});
 assert.equal(Selection.checkSelection({},{hardwareArch:'arm64',executableArchitecture:'x86_64',translatorPlan:f.plan}).enabled,false);
});
test('stock driver, wrong architecture, missing DXGI or bad real exports cannot stage forwarding',async t=>{
 const f=fixture(t);assert.equal(DLSS.requested(f.plan,'x86_64',()=>false),false);assert.equal(DLSS.requested(f.plan,'x86',()=>true),false);
 // Without DXVK's own DXGI, as with CrossOver's DXVK 1.10.3 on Wine's DXGI, the game starts without forwarding.
 const noDxgi={...f.plan,placements:[]};assert.equal(DLSS.requested(noDxgi,'x86_64',()=>true),false);
 assert.equal((await DLSS.prepare({},f.context,{},noDxgi,'x86_64',f.view,f.opts)).enabled,false);
 await assert.rejects(DLSS.prepare({},f.context,{},f.plan,'x86_64',f.view,{...f.opts,inspect:()=>({machine:0x8664,exports:new Map()})}),/caller exports/);
 assert.deepEqual(f.seen,[]);
});
test('private prefix receives actual managed DLLs and restores its prior file when forwarding is disabled',async t=>{
 const f=fixture(t),prefix=path.join(f.root,'prefix'),system=path.join(prefix,'drive_c/windows/system32');fs.mkdirSync(system,{recursive:true});
 const original=path.join(system,'nvapi64.dll');fs.writeFileSync(original,'original prefix file');
 const result=await DLSS.prepare({},f.context,{},f.plan,'x86_64',{...f.view,native:[]},f.opts);
 const files=require('../src/modules/shared/runtime/translator-files');await files.applyNativeLibraries(result.view,prefix);
 assert.equal(fs.realpathSync(path.join(system,'nvapi64.dll')),f.files['nvapi64.dll']);assert.equal(fs.realpathSync(path.join(system,'nvngx.dll')),f.files['nvngx.dll']);assert.equal(fs.realpathSync(path.join(system,'_nvngx.dll')),f.files['nvngx.dll']);
 await files.applyNativeLibraries({native:[]},prefix);assert.equal(fs.readFileSync(original,'utf8'),'original prefix file');assert.equal(fs.existsSync(path.join(system,'nvngx.dll')),false);assert.equal(fs.existsSync(path.join(system,'_nvngx.dll')),false);
});
test('carrier transport detection follows the selected driver file and invalidates changed metadata',t=>{
 const f=fixture(t);assert.equal(DLSS.carrierDriver(f.plan),null);
 fs.writeFileSync(f.files['driver.dylib'],'compiled driver: temporal_sr unrelated marker');assert.equal(DLSS.carrierDriver(f.plan),null);
 fs.writeFileSync(f.files['driver.dylib'],'compiled driver: temporal-sr\0');assert.equal(DLSS.carrierDriver(f.plan).engine,'kosmickrisp');
 fs.writeFileSync(f.files['driver.dylib'],'stock driver');assert.equal(DLSS.carrierDriver(f.plan),null);
});

test('virtual NVIDIA device and architecture consistently identify Turing',()=>{
 const env=DLSS.environment(true);
 assert.equal(env.DXVK_NVAPI_GPU_ARCH,'TU100');
 assert.match(env.DXVK_CONFIG,/(?:^|; )dxgi\.customDeviceId = 1e07(?:;|$)/);
 assert.match(env.DXVK_CONFIG,/(?:^|; )dxgi\.customVendorId = 10de(?:;|$)/);
});
