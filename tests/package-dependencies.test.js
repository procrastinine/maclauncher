const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const B=require('../src/modules/shared/runtime/bundled-native'),P=require('../src/modules/shared/runtime/package-dependencies');
const Payload=require('../scripts/native-payload.cjs');
function root(t){const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dependency-install-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
const lock=async()=>async()=>{};
const {packageFor}=require('./helpers/runtime-package.cjs');
async function damagedDependency(t){
 const directory=root(t),userDataDir=path.join(directory,'profile'),shared=await packageFor(directory,'shared-stack',{aliases:{'alternate.js':'entry.js'}});
 const dep={project:shared.record.id,release:shared.record.version,sha256:shared.record.asset.sha256},record={dependencies:[dep]};
 const options={userDataDir,repository:'example/runtime-builds',acquireLock:lock,fetchCatalog:async()=>({packages:[shared.record]}),
  download:async(url,file)=>fs.copyFileSync(shared.archive,file)};
 const first=await P.prepare(record,options);await first.release();
 const target=P.directory(userDataDir,dep),entry=path.join(target,'files/entry.js');fs.writeFileSync(entry,'existing damaged bytes');
 const inode=fs.statSync(target).ino;
 function snapshot(directory){return fs.readdirSync(directory).sort().flatMap(name=>{
  const file=path.join(directory,name);return fs.lstatSync(file).isDirectory()?snapshot(file).map(([child,bytes])=>[name+'/'+child,bytes]):[[name,fs.readFileSync(file).toString('hex')]];
 });}
 const before=snapshot(target);
 const retained=()=>{assert.equal(fs.statSync(target).ino,inode);assert.deepEqual(snapshot(target),before);};
 const unchanged=()=>{retained();assert.deepEqual(fs.readdirSync(path.dirname(target)),[dep.sha256]);};
 return{shared,dep,record,options,target,entry,retained,unchanged};
}
for(const failure of ['catalog','download','digest','payload','abort'])test(`dependency replacement retains the prior directory after ${failure} failure`,async t=>{
 const fixture=await damagedDependency(t),{shared,options,record,retained,unchanged}=fixture;
 const controller=new AbortController(),changed={...options};
 if(failure==='catalog')changed.fetchCatalog=async()=>{retained();throw new Error('catalog unavailable');};
 if(failure==='download')changed.download=async()=>{retained();throw new Error('download unavailable');};
 if(failure==='digest')changed.download=async(url,file)=>{retained();fs.writeFileSync(file,'wrong archive');};
 if(failure==='payload')changed.extract=async(archive,output,signal)=>{
  retained();await require('../src/modules/shared/runtime/project-native-package').extractArchive(archive,output,signal);
  fs.writeFileSync(path.join(output,'files/entry.js'),'invalid staged payload');
 };
 if(failure==='abort'){
  changed.signal=controller.signal;
  changed.download=async(url,file)=>{retained();fs.copyFileSync(shared.archive,file);controller.abort(new Error('replacement canceled'));};
 }
 await assert.rejects(P.prepare(record,changed),/unavailable|digest|checksum|size|canceled|aborted/);
 unchanged();
});
test('dependency replacement restores the exact prior directory when publishing fails',async t=>{
 const {record,options,target,unchanged}=await damagedDependency(t),rename=fs.renameSync;
 let published=false;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(to===target&&path.basename(from).startsWith('.install-')){
   published=true;
   assert.equal(fs.existsSync(target),false);
   throw Object.assign(new Error('replacement publish denied'),{code:'EACCES'});
  }
  return rename(from,to);
 });
 await assert.rejects(P.prepare(record,options),/replacement publish denied/);
 assert.equal(published,true);unchanged();
});
test('dependency replacement verifies before swapping and reuses the repaired exact package',async t=>{
 const {record,options,shared,target,entry,dep}=await damagedDependency(t);
 let downloads=0;
 const selected=await P.prepare(record,{...options,download:async(url,file)=>{
  assert.equal(fs.readFileSync(entry,'utf8'),'existing damaged bytes');downloads++;fs.copyFileSync(shared.archive,file);
 }});
 try{
  const installed=selected.installed.get(dep.project);
  assert.equal(installed.directory,target);assert.equal(B.verifyPayload(installed.root,installed.declaration,installed.resolveDependency),true);
  assert.equal(fs.readFileSync(entry,'utf8'),'owned entry shared-stack');
  assert.equal(fs.readFileSync(path.join(installed.root,'alternate.js'),'utf8'),'owned entry shared-stack');
  assert.deepEqual(fs.readdirSync(path.dirname(target)),[dep.sha256]);
 }finally{await selected.release();}
 const reused=await P.prepare(record,{...options,download:async()=>{throw new Error('verified package must not download again');}});
 await reused.release();assert.equal(downloads,1);
});
test('local aliases use clones/copy fallback and reject interrupted or changed materialization',t=>{
 const directory=root(t),file=path.join(directory,'canonical.bin');fs.writeFileSync(file,'same bytes');
 const declaration={files:[{path:'canonical.bin',size:10,mode:0o644,sha256:B.digest(Buffer.from('same bytes'))}],aliases:{schema:1,files:{'alias.bin':'canonical.bin'}}};
 assert.throws(()=>P.materialize(directory,declaration,null,{copy(){throw new Error('interrupted');}}),/interrupted/);
 assert.deepEqual(fs.readdirSync(directory),['canonical.bin']);
 P.materialize(directory,declaration,null,{copy:(from,to)=>fs.copyFileSync(from,to)});
 assert.equal(fs.lstatSync(path.join(directory,'alias.bin')).isFile(),true);assert.equal(B.verifyPayload(directory,declaration),true);
 P.materialize(directory,declaration,null);fs.writeFileSync(path.join(directory,'alias.bin'),'bad');assert.throws(()=>P.materialize(directory,declaration,null),/differs/);
});
test('one consented parent install fetches dependencies first, reuses them and retains them until the last consumer is removed',async t=>{
 const directory=root(t),userDataDir=path.join(directory,'profile'),shared=await packageFor(directory,'shared-stack');
 const dep={project:shared.record.id,release:shared.record.version,sha256:shared.record.asset.sha256};
 const canonical=shared.facts.find(file=>file.path==='lib/shared.dylib');
 const first=await packageFor(directory,'first-consumer',{dependencies:[dep],aliases:{'lib/shared.dylib':{project:dep.project,path:canonical.path}},externalFacts:[canonical]});
 const second=await packageFor(directory,'second-consumer',{dependencies:[dep]});
 const Catalog=require('../src/modules/shared/runtime/maclauncher-builds');
 const catalog={schemaVersion:2,projectId:first.record.id,updatePolicy:'manual',packages:[first.record]};
 const catalogOptions={projectId:first.record.id,repository:'example/runtime-builds'};
 assert.equal(Catalog.validateProjectCatalog(catalog,catalogOptions).packages[0].launcherContract,2);
 const oldApp=Catalog.validateProjectCatalog(catalog,{...catalogOptions,launcherContract:1});
 assert.deepEqual(oldApp.packages,[]);assert.match(oldApp.unavailable[0].reason,/newer MacLauncher/);
 const packages=new Map([shared,first,second].map(value=>[value.record.id,value])),events=[];
 const fetchUrlBuffer=async url=>{const id=decodeURIComponent(new URL(url).pathname.split('/').at(-1).replace(/\.json$/,''));const value=packages.get(id);return{status:200,body:Buffer.from(JSON.stringify({schemaVersion:2,projectId:id,updatePolicy:'manual',packages:[value.record]}))};};
 const download=async(url,file)=>{const selected=[...packages.values()].find(item=>item.record.asset.url===url);events.push(selected.record.id);fs.copyFileSync(selected.archive,file);return{sha256:selected.record.asset.sha256};};
 const create=id=>require('../src/modules/shared/runtime/project-build-manager').createProjectBuildManager({projectId:id,label:id,repository:'example/runtime-builds',manifestRelative:'manifest.json',sourceRelative:null,executableRelative:'entry.js',dataOnly:true,
  verifyPayload:selected=>B.verifyPayload(selected.root,selected.declaration,selected.resolveDependency),dependencies:{fetchUrlBuffer,downloadToFile:download,packageDependencies:{fetchCatalog:async options=>({packages:[packages.get(options.projectId).record]}),download,acquireLock:lock}}});
 const a=create(first.record.id),b=create(second.record.id);
 await a.installRuntime({userDataDir});assert.deepEqual(events,['shared-stack','first-consumer']);
 const chosen=a.resolveSelection(null,{},userDataDir).install;assert.ok(chosen);
 const alias=path.join(chosen.root,'lib/shared.dylib');assert.equal(fs.lstatSync(alias).isSymbolicLink(),true);assert.equal(path.isAbsolute(fs.readlinkSync(alias)),false);
 assert.equal(B.verifyPayload(chosen.root,chosen.declaration,chosen.resolveDependency),true);
 assert.deepEqual(chosen.dependencyLibraryPaths,[],'Aliased dependencies need no extra loader path');
 await b.installRuntime({userDataDir});assert.deepEqual(events,['shared-stack','first-consumer','second-consumer']);
 const secondInstall=b.resolveSelection(null,{},userDataDir).install;
 assert.deepEqual(secondInstall.dependencyLibraryPaths,[path.join(P.directory(userDataDir,dep),'files/lib')]);
 assert.equal(B.resolveInstalledEnvironment(secondInstall).DYLD_FALLBACK_LIBRARY_PATH,secondInstall.dependencyLibraryPaths[0]);
 await a.uninstallRuntime({userDataDir,version:'1.0.0'});assert.equal(fs.existsSync(P.directory(userDataDir,dep)),true);
 await b.uninstallRuntime({userDataDir,version:'1.0.0'});assert.equal(fs.existsSync(P.directory(userDataDir,dep)),false);
});
test('included dependency sidecars retain the attested bytes and verify aliases through Android workers',async t=>{
 const directory=root(t),app=path.join(directory,'MacLauncher.app'),resources=path.join(app,'Contents/Resources'),native=path.join(resources,'native-runtimes');fs.mkdirSync(resources,{recursive:true});
 return B.withAppBundle(app,async()=>{
 const shared=await packageFor(directory,'shared-stack'),dep={project:shared.record.id,release:shared.record.version,sha256:shared.record.asset.sha256};
 const canonical=shared.facts.find(file=>file.path==='lib/shared.dylib');
 const consumer=await packageFor(directory,'included-consumer',{dependencies:[dep],aliases:{'alternate.js':'entry.js','lib/shared.dylib':{project:dep.project,path:canonical.path}},externalFacts:[canonical]});
 const R=require('../scripts/runtime-packages.cjs'),I=require('../src/modules/shared/runtime/included-package-dependencies');
 const lock={schemaVersion:2,repository:'example/runtime-builds',architectures:['arm64','x64'],maximumMacOS:'13.0',packages:[shared.record,consumer.record]};
 fs.mkdirSync(path.join(native,'.declarations'),{recursive:true});fs.writeFileSync(path.join(resources,'runtime-packages.json'),JSON.stringify(lock));
 for(const value of [shared,consumer]){
  const output=path.join(native,value.declaration.directoryRelative);fs.mkdirSync(output,{recursive:true});
  let original;await R.extractPackage(value.archive,output,value.record,{onDeclaration:bytes=>{original=bytes;}});
  assert.deepEqual(original,value.outer);fs.writeFileSync(path.join(native,'.declarations',value.record.asset.sha256+'.json'),original);
  const resolved=value===consumer?P.resolver(new Map([[dep.project,{record:shared.record,declaration:shared.declaration,root:path.join(native,shared.declaration.directoryRelative)}]])):null;
  P.materialize(output,value.declaration,resolved,{copy:(from,to)=>fs.copyFileSync(from,to)});
 }
 const selected=I.context(resources).visit(consumer.record);
 const helper=require('../src/modules/shared/runtime/included-helpers').inspectIncluded([consumer.declaration],{id:consumer.record.id,resourcesRoot:resources,dataOnly:true,executableRelative:'entry.js'});
 assert.deepEqual(helper.declaration,consumer.declaration);assert.equal(helper.dependencyReadRoots.length,1);
 const manager=require('../src/modules/shared/runtime/project-build-manager').createProjectBuildManager({projectId:consumer.record.id,label:'Included consumer',repository:'example/runtime-builds',manifestRelative:'manifest.json',sourceRelative:null,executableRelative:'entry.js',dataOnly:true,included:()=>({root:selected.root,record:consumer.declaration}),dependencies:{systemVersionSync:()=> '26.0'}});
 const included=manager.resolveSelection(null,{},path.join(directory,'profile')).install;
 assert.ok(included);assert.deepEqual(included.declaration.files,consumer.declaration.files);assert.deepEqual(included.dependencyReadRoots,helper.dependencyReadRoots);
 assert.equal(B.resolveInstalledAsset({installDir:helper.directory,runtimeFiles:{shared:'lib/shared.dylib'},root:helper.directory,declaration:helper.declaration,resolveDependency:helper.resolveDependency},'shared'),path.join(helper.directory,'lib/shared.dylib'));
 const Verifier=require('../src/modules/android/runtime-verifier');t.after(()=>Verifier.close());
 assert.equal((await Verifier.verifyPayload(selected.root,selected.declaration,{resolveDependency:selected.resolveDependency})).cacheHit,false);
 assert.equal((await Verifier.verifyPayload(selected.root,selected.declaration,{resolveDependency:selected.resolveDependency})).cacheHit,true);
 const duplicate=path.join(native,'aaa/shared.bin');fs.mkdirSync(path.dirname(duplicate),{recursive:true});fs.copyFileSync(path.join(native,shared.declaration.directoryRelative,canonical.path),duplicate);
 require('../scripts/app-deduplication.cjs').collapse(app);
 assert.equal(fs.lstatSync(path.join(native,shared.declaration.directoryRelative,canonical.path)).isSymbolicLink(),true);
 assert.equal(B.verifyPayload(selected.root,selected.declaration,selected.resolveDependency),true);
 await Verifier.verifyPayload(selected.root,selected.declaration,{resolveDependency:selected.resolveDependency});
 const target=path.join(native,shared.declaration.directoryRelative,canonical.path);fs.writeFileSync(target,Buffer.alloc(canonical.size,7));
 await assert.rejects(Verifier.verifyPayload(selected.root,selected.declaration,{resolveDependency:selected.resolveDependency}),/checksum/);
 assert.throws(()=>I.context(resources).visit(consumer.record),/checksum/);
 });
});
test('dependency retirement resumes after interrupted deletion without needing the removed receipt',async t=>{
 const directory=root(t),userDataDir=path.join(directory,'profile'),shared=await packageFor(directory,'shared-stack');
 const dep={project:shared.record.id,release:shared.record.version,sha256:shared.record.asset.sha256};
 const installation=await P.prepare({dependencies:[dep]},{userDataDir,repository:'example/runtime-builds',acquireLock:lock,fetchCatalog:async()=>({packages:[shared.record]}),download:async(url,file)=>fs.copyFileSync(shared.archive,file)});await installation.release();
 await assert.rejects(P.collect(userDataDir,{acquireLock:lock,removeTrash:async trash=>{fs.unlinkSync(path.join(trash,'runtime.json'));throw new Error('interrupted');}}),/interrupted/);
 assert.equal(fs.existsSync(P.directory(userDataDir,dep)),false);
 const parent=path.dirname(P.directory(userDataDir,dep));assert.equal(fs.readdirSync(parent).length,1);
 await P.collect(userDataDir,{acquireLock:lock});assert.deepEqual(fs.readdirSync(parent),[]);
});
test('binding retains the sealed inventory while deriving a legacy Intel execution role consistently',t=>{
 const directory=root(t),stored={path:'runner',size:32,mode:0o755,sha256:'a'.repeat(64),architectures:['x86_64']};
 const manifest={path:'manifest.json',size:2,mode:0o644,sha256:'b'.repeat(64)};
 const record={id:'intel-runtime',version:'1.0.0',arch:'x64',launcherArchitectures:['arm64','x64'],minimumMacOS:'13.0',manifestRelative:'manifest.json',manifestSha256:manifest.sha256,sourceSha256:'c'.repeat(64)};
 const outer={...record,files:[{...stored,format:'mach-o'},manifest]},file=path.join(directory,'outer.json');fs.writeFileSync(file,JSON.stringify(outer));
 const logical={files:[{...stored,executionArchitecture:'x86_64'},manifest]};assert.throws(()=>P.bind(directory,record,logical,null,file),/inventory differs/);
 const normalizeFiles=files=>files.map(item=>item.architectures?{...item,executionArchitecture:'x86_64'}:item);
 assert.equal(P.bind(directory,record,logical,null,file,{normalizeFiles}).files[0].executionArchitecture,'x86_64');
 logical.files[0].sha256='d'.repeat(64);assert.throws(()=>P.bind(directory,record,logical,null,file),/inventory differs/);
});
module.exports={packageFor};
