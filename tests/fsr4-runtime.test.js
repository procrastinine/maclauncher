const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const FSR4=require('../src/modules/shared/reshade/temporal/fsr4'),source=require('../src/modules/shared/reshade/temporal/fsr4/source.json');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'fsr4-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const payload=path.join(root,'temporal/fsr4');fs.mkdirSync(path.join(payload,'build'),{recursive:true});fs.mkdirSync(path.join(payload,'third_party/fsr411'),{recursive:true});fs.writeFileSync(path.join(payload,'libmaclauncher-fsr4.dylib'),'library');fs.writeFileSync(path.join(payload,'third_party/fsr411/initializers.bin'),'model');return {root,payload,file:path.join(payload,'provider.json'),options:{platform:'darwin',macOSVersion:'26.0',hardwareArch:'arm64'}};}
test('FSR4 admits the declared model profiles from any build commit without gating on notice files',t=>{
 const {root,payload,file,options}=fixture(t),metadata={providerABI:1,complete:false,commit:'installed-build',model:source.model,library:'libmaclauncher-fsr4.dylib',profilesAPI:1,resourcePreparation:1,supportedProfiles:source.supportedProfiles,profiles:source.profiles,lite2:source.lite2};
 fs.writeFileSync(file,JSON.stringify(metadata));assert.equal(FSR4.resolve(root,options),null);fs.writeFileSync(file,JSON.stringify({...metadata,complete:true}));assert.deepEqual(FSR4.resolve(root,options)?.profiles,source.supportedProfiles,'a missing notice file does not hide a complete payload');
 fs.writeFileSync(path.join(payload,'third_party/fsr411/LICENSE.Lite2.txt'),'license');const installed=FSR4.resolve(root,options);assert.equal(installed.version,'4.1.1.2740');assert.deepEqual(installed.profiles,source.supportedProfiles);assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.7'}).minimumMacOS,'15.0');assert.equal(FSR4.resolve(root,{...options,macOSVersion:'14.7'}),null);const Host=require('../src/modules/shared/runtime/host-capabilities');t.mock.method(Host,'getHostCapabilities',()=>({macOSVersion:'15.6'}));assert.ok(FSR4.resolve(root,{platform:'darwin'}));t.mock.method(Host,'getHostCapabilities',()=>({macOSVersion:'14.6'}));assert.equal(FSR4.resolve(root,{platform:'darwin'}),null);assert.equal(FSR4.resolve(root,{...options,platform:'linux'}),null);assert.deepEqual(FSR4.prepare(root,{...options,fsr4Profile:'lite2'}),{RESHADE_FSR4_LIBRARY:installed.library,FSR4_ROOT:installed.directory,FSR4_BUILD_DIR:installed.build});
 fs.writeFileSync(file,JSON.stringify({...metadata,complete:true,profiles:source.profiles.map(value=>({...value,upstreamProfile:'exact-fast'}))}));assert.equal(FSR4.resolve(root,options),null,'a renamed original model cannot stand in for Lite2');
 fs.writeFileSync(file,JSON.stringify({...metadata,complete:true,commit:'different'}));assert.equal(FSR4.resolve(root,options)?.source,'different','an installed payload is not pinned to one build commit');
});
test('a running immutable earlier payload retains exact-fast without acquiring new profile claims',t=>{
 const {root,file,options}=fixture(t);fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:'legacy-build',model:source.model,library:'libmaclauncher-fsr4.dylib',profile:'exact-fast',supportedProfiles:['exact-fast','lite2']}));const installed=FSR4.resolve(root,options);assert.deepEqual(installed.profiles,['exact-fast']);assert.equal(installed.minimumMacOS,'26.0');assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.7'}),null);assert.equal(FSR4.prepare(root,options).FSR4_ROOT,installed.directory);assert.throws(()=>FSR4.prepare(root,{...options,fsr4Profile:'lite2'}),/does not contain.*lite2/);assert.throws(()=>FSR4.prepare(root,{...options,fsr4Profile:'lite'}),/does not contain.*lite/);
});
test('FSR4 preserves a higher installed patch floor and separates inspection from physical-host support',t=>{
 const {root,payload,file,options}=fixture(t);
 fs.writeFileSync(path.join(payload,'third_party/fsr411/LICENSE.Lite2.txt'),'license');
 fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:'installed-build',model:source.model,library:'libmaclauncher-fsr4.dylib',profilesAPI:1,resourcePreparation:1,supportedProfiles:source.supportedProfiles,profiles:source.profiles,lite2:source.lite2,minimumMacOS:'15.4.2'}));
 assert.equal(FSR4.inspect(root).minimumMacOS,'15.4.2');
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.4.1'}),null);
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.4.2'}).minimumMacOS,'15.4.2');
 assert.ok(FSR4.resolve(root,{...options,macOSVersion:'15.5'}));
 assert.equal(FSR4.resolve(root,{...options,hardwareArch:'x64'}),null);
 assert.ok(FSR4.inspect(root),'payload inspection does not pretend to run on another Mac');
 assert.ok(FSR4.resolve(root,{...options,macOSVersion:null,hardwareArch:null}),'unknown host facts remain unknown');
 const legacy=source.legacyPayloads[0];
 fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:'legacy-build',model:legacy.model,library:'libmaclauncher-fsr4.dylib',profile:'exact-fast',minimumMacOS:'26.4.2'}));
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'26.4.1'}),null);
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'26.4.2'}).minimumMacOS,'26.4.2');
});

test('immutable three-profile payloads retain all legacy profile identities',t=>{const {root,file,options}=fixture(t);fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:'old',model:source.model,library:'libmaclauncher-fsr4.dylib',profilesAPI:1,resourcePreparation:1,supportedProfiles:['exact-fast','lite','lite2'],profiles:source.legacyProfileContracts}));assert.deepEqual(FSR4.resolve(root,options).profiles,['exact-fast','lite','lite2']);assert.equal(FSR4.prepare(root,{...options,fsr4Profile:'lite2'}).FSR4_BUILD_DIR,fs.realpathSync(path.join(root,'temporal/fsr4/build')));assert.throws(()=>FSR4.prepare(root,{...options,fsr4Profile:'int8-lite'}),/does not contain/);});
test('FSR 4.1.2 profile options report a boolean availability and a download when their model data is absent',t=>{
 const profile=id=>FSR4.profileOptions({profiles:source.profiles.map(value=>value.id)},fs.mkdtempSync(path.join(os.tmpdir(),'fsr4-profile-data-'))).find(row=>row.id===id);
 for(const id of ['int8-lite','int8-lite-lossy']){const row=profile(id);assert.equal(row.available,false,id);assert.equal(row.delivery.requiresDownload,true,id);assert.equal(row.reason,'Download or import the FSR 4.1.2 model data.');}
 for(const id of ['exact-fast','lossy2-412'])assert.equal(profile(id).available,true,id);
 assert.equal(FSR4.profileOptions(null,os.tmpdir()).every(row=>row.available===false),true);
});
test('Runtimes FSR 4.1.2 model data installs both profiles and names what is installed',async t=>{
 const Manager=require('../src/modules/shared/reshade/runtime/fsr4-models-manager'),Library=Manager.core,spec=require('../src/modules/shared/reshade/temporal/fsr4/model.json');
 const userDataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fsr4-models-'));t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
 const root=Library.directory(userDataDir),model=path.join(root,'build/fsr412_model');fs.mkdirSync(model,{recursive:true});
 for(const name of ['initializers-lite.bin','initializers-lite-ultraperformance.bin'])fs.writeFileSync(path.join(model,name),Buffer.alloc(27392));
 const record=profiles=>fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({version:spec.version,archiveSha256:spec.archiveSha256,preparation:1,profiles}));
 const state=()=>Manager.getState({userDataDir,root:'/nonexistent'}).sections[0];
 record(['int8-lite']);let section=state();
 assert.equal(section.catalog.versionLabels[spec.version],'FSR 4.1.2 Lite and Lite Lossy');
 assert.equal(section.catalog.versionRequirements[spec.version].downloadBytes,spec.archiveBytes+spec.lossy.archiveBytes);
 assert.equal(section.catalog.versionRequirements[spec.version].requiresDownload,true);
 assert.equal(section.installed[0].versionLabel,'FSR 4.1.2 Lite');
 assert.deepEqual(section.capabilities.map(row=>[row.label,row.available]),[['FSR 4.1.2 Lite',true],['FSR 4.1.2 Lite Lossy',false]]);
 record(['int8-lite','int8-lite-lossy']);section=state();
 assert.equal(section.installed[0].versionLabel,'FSR 4.1.2 Lite and Lite Lossy');
 assert.equal(section.catalog.versionRequirements[spec.version].available,true);
 assert.deepEqual(section.capabilities.map(row=>row.available),[true,true]);
 const calls=[];t.mock.method(Library,'install',async context=>{calls.push(context.fsr4Profile);return null;});
 await Manager.installRuntime({userDataDir,root:'/nonexistent'});await Manager.performSetupAction({userDataDir,root:'/nonexistent',setupActionId:'download'});await Manager.installRuntime({userDataDir,root:'/nonexistent',fsr4Profile:'int8-lite'});
 assert.deepEqual(calls,['int8-lite-lossy','int8-lite-lossy','int8-lite']);
});
