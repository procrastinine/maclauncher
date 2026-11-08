const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const FSR4=require('../src/modules/shared/reshade/temporal/fsr4'),source=require('../src/modules/shared/reshade/temporal/fsr4/source.json');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'fsr4-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const payload=path.join(root,'temporal/fsr4');fs.mkdirSync(path.join(payload,'build'),{recursive:true});fs.mkdirSync(path.join(payload,'third_party/fsr411'),{recursive:true});fs.writeFileSync(path.join(payload,'libmaclauncher-fsr4.dylib'),'library');fs.writeFileSync(path.join(payload,'third_party/fsr411/initializers.bin'),'model');return {root,payload,file:path.join(payload,'provider.json'),options:{platform:'darwin',macOSVersion:'26.0',hardwareArch:'arm64'}};}
test('FSR4 admits the declared model profiles from any build commit without gating on notice files',t=>{
 const {root,payload,file,options}=fixture(t),metadata={providerABI:1,complete:false,commit:source.commit,model:source.model,library:'libmaclauncher-fsr4.dylib',profilesAPI:1,resourcePreparation:1,supportedProfiles:source.supportedProfiles,profiles:source.profiles,lite2:source.lite2};
 fs.writeFileSync(file,JSON.stringify(metadata));assert.equal(FSR4.resolve(root,options),null);fs.writeFileSync(file,JSON.stringify({...metadata,complete:true}));assert.deepEqual(FSR4.resolve(root,options)?.profiles,['exact-fast','lite','lite2'],'a missing notice file does not hide a complete payload');
 fs.writeFileSync(path.join(payload,'third_party/fsr411/LICENSE.Lite2.txt'),'license');const installed=FSR4.resolve(root,options);assert.equal(installed.version,'4.1.1.2740');assert.deepEqual(installed.profiles,['exact-fast','lite','lite2']);assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.7'}).minimumMacOS,'15.0');assert.equal(FSR4.resolve(root,{...options,macOSVersion:'14.7'}),null);const Host=require('../src/modules/shared/runtime/host-capabilities');t.mock.method(Host,'getHostCapabilities',()=>({macOSVersion:'15.6'}));assert.ok(FSR4.resolve(root,{platform:'darwin'}));t.mock.method(Host,'getHostCapabilities',()=>({macOSVersion:'14.6'}));assert.equal(FSR4.resolve(root,{platform:'darwin'}),null);assert.equal(FSR4.resolve(root,{...options,platform:'linux'}),null);assert.deepEqual(FSR4.prepare(root,{...options,fsr4Profile:'lite2'}),{RESHADE_FSR4_LIBRARY:installed.library,FSR4_ROOT:installed.directory,FSR4_BUILD_DIR:installed.build});
 fs.writeFileSync(file,JSON.stringify({...metadata,complete:true,profiles:source.profiles.map(value=>({...value,upstreamProfile:'exact-fast'}))}));assert.equal(FSR4.resolve(root,options),null,'a renamed original model cannot stand in for Lite2');
 fs.writeFileSync(file,JSON.stringify({...metadata,complete:true,commit:'different',lite2:{...source.lite2,commit:'different'}}));assert.equal(FSR4.resolve(root,options)?.source,'different','an installed payload is not pinned to one build commit');
 fs.writeFileSync(file,JSON.stringify({...metadata,complete:true,lite2:{...source.lite2,sha256:'0'.repeat(64)}}));assert.deepEqual(FSR4.prepare(root,options),{},'different Lite2 weights are a different profile');
});
test('a running immutable earlier payload retains exact-fast without acquiring new profile claims',t=>{
 const {root,file,options}=fixture(t);fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:source.legacyPayloads[0].commit,model:source.model,library:'libmaclauncher-fsr4.dylib',profile:'exact-fast',supportedProfiles:['exact-fast','lite2']}));const installed=FSR4.resolve(root,options);assert.deepEqual(installed.profiles,['exact-fast']);assert.equal(installed.minimumMacOS,'26.0');assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.7'}),null);assert.equal(FSR4.prepare(root,options).FSR4_ROOT,installed.directory);assert.throws(()=>FSR4.prepare(root,{...options,fsr4Profile:'lite2'}),/does not contain.*lite2/);assert.throws(()=>FSR4.prepare(root,{...options,fsr4Profile:'lite'}),/does not contain.*lite/);
});
test('FSR4 preserves a higher installed patch floor and separates inspection from physical-host support',t=>{
 const {root,payload,file,options}=fixture(t);
 fs.writeFileSync(path.join(payload,'third_party/fsr411/LICENSE.Lite2.txt'),'license');
 fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:source.commit,model:source.model,library:'libmaclauncher-fsr4.dylib',profilesAPI:1,resourcePreparation:1,supportedProfiles:source.supportedProfiles,profiles:source.profiles,lite2:source.lite2,minimumMacOS:'15.4.2'}));
 assert.equal(FSR4.inspect(root).minimumMacOS,'15.4.2');
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.4.1'}),null);
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.4.2'}).minimumMacOS,'15.4.2');
 assert.ok(FSR4.resolve(root,{...options,macOSVersion:'15.5'}));
 assert.equal(FSR4.resolve(root,{...options,hardwareArch:'x64'}),null);
 assert.ok(FSR4.inspect(root),'payload inspection does not pretend to run on another Mac');
 assert.ok(FSR4.resolve(root,{...options,macOSVersion:null,hardwareArch:null}),'unknown host facts remain unknown');
 const legacy=source.legacyPayloads[0];
 fs.writeFileSync(file,JSON.stringify({providerABI:1,complete:true,commit:legacy.commit,model:legacy.model,library:'libmaclauncher-fsr4.dylib',profile:'exact-fast',minimumMacOS:'26.4.2'}));
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'26.4.1'}),null);
 assert.equal(FSR4.resolve(root,{...options,macOSVersion:'26.4.2'}).minimumMacOS,'26.4.2');
});
