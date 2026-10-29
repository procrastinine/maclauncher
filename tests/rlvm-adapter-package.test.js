const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const Adapter=require('../src/modules/siglus/runtime/rlvm-adapter-manager'),Manager=require('../src/modules/siglus/runtime/rlvm-manager');
const Module=require('../src/modules/siglus/main'),Launch=require('../src/modules/siglus/rlvm-launch'),Detect=require('../src/modules/siglus/detect');
const {prepareForLaunch}=require('../src/core/runtime-preparation');

test('the adapter alone installs after normal consent and retains verified offline and legacy use',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rlvm-adapter-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const production=path.resolve(__dirname,'../build/managed-packages/rlvm-adapter-1.0.0-MCLv1'),archive=path.join(production,'rlvm-adapter-1.0.0-MCLv1-universal.tar.gz');
 const record=JSON.parse(fs.readFileSync(archive+'.json'));
 const {catalog}=await import(pathToFileURL(path.resolve(__dirname,'../../maclauncher-builds/tools/runtime-package.mjs')));
 const published=catalog([record],{project:'rlvm-adapter',repository:'procrastinine/maclauncher-builds'});
 let fetches=0,downloads=0,consents=0;
 const component=Adapter.createManager({systemVersionSync:()=> '26.0',fetchUrlBuffer:async url=>{
  assert.equal(url,'https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/rlvm-adapter.json');fetches++;return {status:200,body:Buffer.from(JSON.stringify(published))};
 },downloadToFile:async(url,target)=>{assert.equal(url,published.packages[0].asset.url);downloads++;fs.copyFileSync(archive,target);}});
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
 assert.deepEqual([fetches,downloads],[0,0]);
 const uses=[];
 assert.equal(await prepareForLaunch({...action,context:{...context,recordRuntimeUse:row=>uses.push(row),confirmRuntimeInstall:async plan=>{consents++;assert.equal(plan.managerId,'rlvm-adapter');assert.equal(plan.version,record.version);assert.deepEqual([fetches,downloads],[0,0]);return true;}},
  install:async(manager,payload)=>{assert.equal(manager.id,'rlvm-adapter');await component.installRuntime({...payload,...context});}}),true);
 assert.deepEqual([fetches,downloads,consents],[1,1,1]);assert.equal(settings.runtimes['rlvm-adapter'].defaultVersion,record.version);
 const selected=component.resolveSelection(entry,settings,context.userDataDir);assert.equal(selected.ready,true);assert.equal(selected.install.declaration.arch,'universal');assert.equal(selected.install.declaration.minimumMacOS,'13.0');
 assert.deepEqual(selected.install.declaration.files.map(row=>row.path).sort(),['files/LICENSE','files/adapter.json','files/rlvm-adapter.dylib','manifest.json']);
 const binary=Adapter.verifyInstall(selected.install),installed=Manager.resolveForLaunch(engine,entry,{...context,recordRuntimeUse:row=>uses.push(row)});
 assert.equal(installed.adapterPath,binary);assert.equal(Launch.prepareLaunch(entry,context,installed).env.DYLD_INSERT_LIBRARIES,binary);
 const offline=Adapter.createManager({systemVersionSync:()=> '26.0',fetchUrlBuffer:()=>assert.fail('Installed adapter stays offline'),downloadToFile:()=>assert.fail('Installed adapter stays offline')});
 assert.equal(offline.resolveSelection(entry,settings,context.userDataDir).ready,true);
 assert(uses.some(row=>row.managerId==='rlvm-adapter'&&row.sourcePath===selected.install.installDir));
 const legacy=path.join(engineRoot,'rlvm-adapter.dylib');fs.copyFileSync(binary,legacy);assert.equal(Manager.adapterSelection(engine,entry,{...context,settings:{}}).legacy,true);
 assert.equal(Manager.adapterSelection(engine,entry,{...context,settings:{runtimes:{'rlvm-adapter':{defaultVersion:'unavailable-exact-choice'}}}}).version,'unavailable-exact-choice');
 fs.appendFileSync(binary,'changed');assert.equal(component.resolveSelection(entry,settings,context.userDataDir).ready,false);assert.throws(()=>Manager.resolveForLaunch(engine,entry,context),/changed|not installed/);
 assert.equal(Manager.adapterResource,undefined);
});
