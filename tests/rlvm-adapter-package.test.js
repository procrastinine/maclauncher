const Harness=require('./helpers/future-upstream.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const NodeModule=require('node:module');
const {packageFor,sha}=require('./helpers/managed-tool-fixture.cjs');
const Adapter=require('../src/modules/siglus/runtime/rlvm-adapter-manager'),Manager=require('../src/modules/siglus/runtime/rlvm-manager');
const Module=require('../src/modules/siglus/main'),Launch=require('../src/modules/siglus/rlvm-launch'),Detect=require('../src/modules/siglus/detect');
const {prepareForLaunch}=require('../src/core/runtime-preparation');

test('the adapter alone installs after normal consent and retains verified offline and legacy use',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rlvm-adapter-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'adapter.c'),library=path.join(root,'rlvm-adapter.dylib');
 fs.writeFileSync(source,'int maclauncher_rlvm_adapter_fixture(void) { return 1; }\n');
 execFileSync('clang',['-dynamiclib','-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0',
  '-Wl,-install_name,@rpath/rlvm-adapter.dylib',source,'-o',library],{stdio:'pipe'});
 execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',library],{stdio:'pipe'});
 const adapterBytes=fs.readFileSync(library),adapterMetadata=Buffer.from('{"schemaVersion":1,"adapterABI":1}\n'),license=Buffer.from('Synthetic adapter fixture; no upstream runtime source is included.\n');
 const fixture=packageFor(path.join(root,'package'),{id:'rlvm-adapter',version:'1.0.0-fixture',architecture:'universal',filesPrefix:'files/',
  manifest:{managerId:'rlvm-adapter',adapterABI:1,executableRelative:'rlvm-adapter.dylib',dependencies:[]},
  entries:[{path:'rlvm-adapter.dylib',bytes:adapterBytes,mode:0o755,architectures:['arm64','x86_64']},
   {path:'adapter.json',bytes:adapterMetadata,mode:0o644},{path:'LICENSE',bytes:license,mode:0o644}]});
 const {archive,record,catalog:published}=fixture;
 let downloads=0,consents=0;
 const catalogUrl='https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/rlvm-adapter.json',before=Harness.network.requests.length;
 const fetches=()=>Harness.network.requests.slice(before).filter(url=>url===catalogUrl).length;
 Harness.network.routes={[catalogUrl]:published};t.after(()=>{Harness.network.routes=null;});
 const component=Adapter.createManager({systemVersionSync:()=> '26.0',downloadToFile:async(url,target)=>{assert.equal(url,published.packages[0].asset.url);downloads++;fs.copyFileSync(archive,target);}});
 const engineRoot=path.join(root,'engine'),enginePath=path.join(engineRoot,'rlvm.app/Contents/MacOS/rlvm');fs.mkdirSync(path.dirname(enginePath),{recursive:true});fs.copyFileSync('/usr/bin/true',enginePath);
 const engine={executablePath:enginePath,installDir:engineRoot,version:'0.14'};
 const game=path.join(root,'game');fs.mkdirSync(game);const scene=Buffer.alloc(480);scene.writeUInt32LE(464);scene.writeUInt32LE(10002,4);scene.writeUInt32LE(464,8);scene.writeUInt32LE(464,0x20);scene.writeUInt32LE(16,0x24);scene.writeUInt32LE(16,0x28);
 const seen=Buffer.alloc(80000+scene.length);seen.writeUInt32LE(80000);seen.writeUInt32LE(scene.length,4);scene.copy(seen,80000);fs.writeFileSync(path.join(game,'Seen.txt'),seen);fs.writeFileSync(path.join(game,'Gameexe.ini'),'#REGNAME="Fixture"\n');fs.writeFileSync(path.join(game,'msgothic.ttc'),'fixture font');
 const entry={gameId:'fixture',gamePath:game,runtimeId:'rlvm',moduleData:Detect.inspectGame(game)};
 const settings={runtimes:{'rlvm-adapter':{defaultVersion:record.version}}},context={userDataDir:path.join(root,'profile'),runtimeId:'rlvm',settings};
 t.mock.method(Manager,'resolveSelection',()=>({ready:true,version:'0.14',install:engine}));
 t.mock.method(Adapter,'resolveSelection',(...args)=>component.resolveSelection(...args));
 t.mock.method(Adapter,'getState',options=>component.getState(options));
 const action={entry,mod:Module,info:Module.manifest,registry:{listModules:()=>[Module],getModule:()=>Module,listSharedRuntimeManagers:()=>[]},runAction:()=>assert.fail('No setup action is needed')};
 assert.equal(await prepareForLaunch({...action,context:{...context,confirmRuntimeInstall:async()=>false},install:()=>assert.fail('Declined consent cannot install')}),false);
 assert.deepEqual([fetches(),downloads],[0,0]);
 const uses=[];
 assert.equal(await prepareForLaunch({...action,context:{...context,recordRuntimeUse:row=>uses.push(row),confirmRuntimeInstall:async plan=>{consents++;assert.equal(plan.managerId,'rlvm-adapter');assert.equal(plan.version,record.version);assert.deepEqual([fetches(),downloads],[0,0]);return true;}},
  install:async(manager,payload)=>{assert.equal(manager.id,'rlvm-adapter');await component.installRuntime({...payload,...context});}}),true);
 assert.deepEqual([fetches(),downloads,consents],[1,1,1]);assert.equal(settings.runtimes['rlvm-adapter'].defaultVersion,record.version);
 const selected=component.resolveSelection(entry,settings,context.userDataDir);assert.equal(selected.ready,true);assert.equal(selected.install.declaration.arch,'universal');assert.equal(selected.install.declaration.minimumMacOS,'13.0');
 assert.deepEqual(selected.install.declaration.files.map(row=>row.path).sort(),['files/LICENSE','files/adapter.json','files/rlvm-adapter.dylib','manifest.json']);
 assert.deepEqual(fs.readFileSync(path.join(selected.install.payloadRoot,'rlvm-adapter.dylib')),adapterBytes);
 assert.deepEqual(fs.readFileSync(path.join(selected.install.payloadRoot,'adapter.json')),adapterMetadata);
 assert.deepEqual(fs.readFileSync(path.join(selected.install.payloadRoot,'LICENSE')),license);
 const binary=Adapter.verifyInstall(selected.install),installed=Manager.resolveForLaunch(engine,entry,{...context,recordRuntimeUse:row=>uses.push(row)});
 assert.equal(installed.adapterPath,binary);assert.equal(Launch.prepareLaunch(entry,context,installed).env.DYLD_INSERT_LIBRARIES,binary);
 const offline=Adapter.createManager({systemVersionSync:()=> '26.0',fetchUrlBuffer:()=>assert.fail('Installed adapter stays offline'),downloadToFile:()=>assert.fail('Installed adapter stays offline')});
 assert.equal(offline.resolveSelection(entry,settings,context.userDataDir).ready,true);
 assert(uses.some(row=>row.managerId==='rlvm-adapter'&&row.sourcePath===selected.install.installDir));
 // Bind the synthetic legacy library to its own exact fixture hash, leaving
 // the historical published adapter profile and the managed owner untouched.
 const managerFile=require.resolve('../src/modules/siglus/runtime/rlvm-manager'),nativeRequire=NodeModule.createRequire(managerFile);
 const legacyProfile={...nativeRequire('./adapter-profile.json'),sha256:sha(adapterBytes)};
 const legacyModule=new NodeModule(managerFile,module);legacyModule.paths=NodeModule._nodeModulePaths(path.dirname(managerFile));
 legacyModule.require=name=>name==='./adapter-profile.json'?legacyProfile:nativeRequire(name);
 legacyModule._compile(fs.readFileSync(managerFile,'utf8'),managerFile);
 const legacy=path.join(engineRoot,'rlvm-adapter.dylib');fs.copyFileSync(binary,legacy);
 assert.equal(legacyModule.exports.adapterSelection(engine,entry,{...context,settings:{}}).legacy,true);
 fs.appendFileSync(legacy,'changed');
 assert.throws(()=>legacyModule.exports.adapterSelection(engine,entry,{...context,settings:{}}),/adapter has changed/);
 assert.equal(Manager.adapterSelection(engine,entry,{...context,settings:{runtimes:{'rlvm-adapter':{defaultVersion:'unavailable-exact-choice'}}}}).version,'unavailable-exact-choice');
 fs.appendFileSync(binary,'changed');assert.equal(component.resolveSelection(entry,settings,context.userDataDir).ready,false);assert.throws(()=>Manager.resolveForLaunch(engine,entry,context),/changed|not installed/);
 assert.equal(Manager.adapterResource,undefined);
});
