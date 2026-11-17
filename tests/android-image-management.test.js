const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Images=require('../src/modules/android/system-image');
const {createManager}=require('../src/modules/android/system-image-manager');
const Inspection=require('../src/modules/android/image-inspection');
const Upstream=require('../src/modules/shared/runtime/upstream'),Transport=require('../src/modules/shared/runtime/upstream-transport');
const Custom=require('../src/modules/shared/runtime/custom-runtime');
const Origins=require('../src/core/runtime-install-origins');
const {createRuntimeUseScope}=require('../src/core/coordinated-runtime-managers');
const {coordinatorFor}=require('../src/core/runtime-coordinator');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
test('Android original images and their reader are ordinary managed Runtimes entries',()=>{
  const managers=require('../src/modules/android/main').runtimeManagers;
  for(const id of ['android-system-image','android-art-image-extractor']){
    const manager=managers.find(row=>row.id===id);assert.ok(manager,id+' must be manageable');
    for(const method of ['refreshCatalog','installRuntime','uninstallRuntime','applySettingsUpdate','registerCustomRuntime'])assert.equal(typeof manager[method],'function',id+' '+method);
  }
});
function elf(machine=183){const bytes=Buffer.alloc(64);bytes.writeUInt32BE(0x7f454c46);bytes[4]=2;bytes[5]=1;bytes[6]=1;bytes.writeUInt16LE(3,16);bytes.writeUInt16LE(machine,18);bytes.writeUInt32LE(1,20);bytes.writeUInt16LE(64,52);return bytes;}
function original(root,version,machine=183){fs.mkdirSync(path.join(root,'system/bin'),{recursive:true});fs.writeFileSync(path.join(root,'system/build.prop'),'ro.build.version='+version+'\n');for(const name of ['linker64','app_process64'])fs.writeFileSync(path.join(root,'system/bin',name),elf(machine),{mode:0o755});return root;}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-images-managed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const userDataDir=path.join(root,'profile');fs.mkdirSync(userDataDir);
  let available=['0','1','2','3'],discoveries=0,transfers=0,consents=0,nextDisk=0;
  const originals=new Map(),mounts=new Map(),disks=new Map();
  for(const version of available)originals.set(version,original(path.join(root,'original-'+version),version));
  const rows=()=>available.map(version=>({version,label:'Android '+version,details:{abi:'arm64-v8a'},files:[{name:'image.zip',url:'https://example.invalid/'+version+'.zip',bytes:Buffer.byteLength('archive-'+version),digest:{algorithm:'sha256',value:sha('archive-'+version)}}]}));
  t.mock.method(Transport,'downloadToFile',async(url,destination)=>{transfers++;fs.writeFileSync(destination,'archive-'+path.basename(new URL(url).pathname,'.zip'));});
  const command=async(file,args,options={})=>{
    if(file==='/usr/bin/plutil')return options.input;
    if(file==='/owned/extractor'){
      const version=fs.readFileSync(args[0],'utf8').replace('archive-','');fs.cpSync(originals.get(version),args[1],{recursive:true});
      fs.writeFileSync(args[1]+'.identity',sha(fs.readFileSync(args[0]))+'\n');return '';
    }
    assert.equal(file,'/usr/bin/hdiutil');
    if(args[0]==='info')return JSON.stringify({images:[...mounts].map(([mount,row])=>({...row,'system-entities':[{'mount-point':mount}]}))});
    if(args[0]==='create'){fs.writeFileSync(args.at(-1),'disk-'+(++nextDisk));return '';}
    if(args[0]==='attach'){
      const mount=args[args.indexOf('-mountpoint')+1],base=args.at(-1),id=fs.readFileSync(base,'utf8');fs.mkdirSync(mount,{recursive:true});
      if(disks.has(id))fs.cpSync(disks.get(id),mount,{recursive:true});
      mounts.set(mount,{'image-path':base,writeable:args.includes('-readwrite')});return '';
    }
    if(args[0]==='detach'){
      const mount=args[1],record=mounts.get(mount);assert.ok(record);const id=fs.readFileSync(record['image-path'],'utf8');
      const snapshot=path.join(root,'snapshot-'+crypto.randomUUID());fs.cpSync(mount,snapshot,{recursive:true});disks.set(id,snapshot);
      mounts.delete(mount);for(const name of fs.readdirSync(mount))fs.rmSync(path.join(mount,name),{recursive:true,force:true});return '';
    }
    if(args[0]==='convert'){fs.copyFileSync(args[1],args.at(-1));return '';}
    assert.fail('Unexpected image command '+args[0]);
  };
  const source={discover:async()=>{discoveries++;return rows();}};
  const helper={id:'android-art-image-extractor',label:'Android image reader',resolveSelection:()=>({ready:true,version:'reader',install:{executablePath:'/owned/extractor',installDir:path.join(root,'reader')}})};
  const imageDependencies={command,legacyLocations:()=>[],acquireLock:async()=>async()=>{},cloneOrCopy:(source,destination)=>fs.promises.copyFile(source,destination,fs.constants.COPYFILE_EXCL)};
  const manager=createManager({source,extractorManager:helper,imageDependencies});
  const context={userDataDir,settings:{},confirmRuntimeInstall:async()=>{consents++;return true;}};
  return {root,userDataDir,manager,context,helper,source,originals,rows,mounts,imageDependencies,
    set available(value){available=value;},get discoveries(){return discoveries;},get transfers(){return transfers;},get consents(){return consents;}};
}
test('Android SDK Refresh reads publisher versions, URLs and digests without a version list',async t=>{
  const Catalog=require('../src/modules/android/image-catalog');
  const xml=revision=>`<sdk:sdk-repository><remotePackage path="system-images;android-36;google_apis_playstore;arm64-v8a"><type-details><api-level>36</api-level><abi>arm64-v8a</abi></type-details><revision><major>${revision}</major></revision><display-name>Google image</display-name><archives><archive><complete><size>64</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>image-${revision}.zip</url></complete></archive></archives></remotePackage></sdk:sdk-repository>`;
  let revision=1;t.mock.method(Transport,'fetchUrlBuffer',async()=>({status:200,body:Buffer.from(xml(revision)),headers:{}}));
  const first=await Catalog.source.discover();revision=29;const later=await Catalog.source.discover();
  assert.match(first[0].version,/-r1.0.0$/);assert.match(later[0].version,/-r29.0.0$/);
  assert.deepEqual(first[0].files[0].digest,{algorithm:'sha1',value:'a'.repeat(40)});
  assert.equal(later[0].files[0].url,new URL('image-29.zip',Catalog.locations[0]).href);
});
test('guest ELF inspection preserves Android APEX links and measures 32-bit images without host path traversal',t=>{
  const f=fixture(t),root=f.originals.get('1'),linker=path.join(root,'system/bin/linker64');
  const apex=path.join(root,'apex/com.android.runtime/bin');fs.mkdirSync(apex,{recursive:true});fs.renameSync(linker,path.join(apex,'linker64'));
  fs.symlinkSync('/apex/com.android.runtime/bin/linker64',linker);
  assert.equal(Inspection.inspectRoot(linker).guestArchitecture,'arm64');
  assert.equal(Inspection.inspectRoot(root).executablePath,path.join(apex,'linker64'));
  fs.unlinkSync(linker);fs.symlinkSync('/etc/passwd',linker);assert.throws(()=>Inspection.inspectRoot(root),/ENOENT/);
  const narrow=path.join(f.root,'narrow');fs.mkdirSync(path.join(narrow,'system/bin'),{recursive:true});fs.writeFileSync(path.join(narrow,'system/build.prop'),'ro.build.id=32\n');
  const bytes=Buffer.alloc(52);bytes.writeUInt32BE(0x7f454c46);bytes[4]=1;bytes[5]=1;bytes[6]=1;bytes.writeUInt16LE(3,16);bytes.writeUInt16LE(3,18);bytes.writeUInt32LE(1,20);bytes.writeUInt16LE(52,40);
  for(const name of ['linker','app_process32'])fs.writeFileSync(path.join(narrow,'system/bin',name),bytes,{mode:0o755});
  assert.equal(Inspection.inspectRoot(narrow).guestArchitecture,'x86');
});
test('system-image management shares one immutable cache, exposes four operations and preserves external roots',async t=>{
  const f=fixture(t);assert.equal(f.manager.ui.management,'managed');assert.deepEqual(f.manager.getState(f.context).installed,[]);assert.equal(f.discoveries,0);
  await f.manager.refreshCatalog(f.context);
  for(const version of ['1','2'])await f.manager.installRuntime({...f.context,version});
  assert.deepEqual(f.manager.getState(f.context).installed.map(row=>row.version).sort(),['1','2']);
  assert.ok(f.manager.getState(f.context).installed.every(row=>row.installDir.startsWith(path.join(f.userDataDir,'android/system-images'))&&row.guestArchitecture==='arm64'));
  const settings=f.manager.applySettingsUpdate('setDefault',{version:'1'},{});f.context.settings={runtimes:{[f.manager.id]:settings}};
  const before=[f.discoveries,f.transfers,f.consents];assert.equal(f.manager.resolveSelection(null,f.context.settings,f.userDataDir).version,'1');
  assert.equal((await f.manager.installRuntime({...f.context,version:'1'})).version,'1');assert.deepEqual([f.discoveries,f.transfers,f.consents],before);
  const custom=f.originals.get('3'),file=path.join(custom,'system/bin/linker64');
  await f.manager.registerCustomRuntime({...f.context,runtimePath:custom});await f.manager.registerCustomRuntime({...f.context,runtimePath:file});
  assert.equal(Custom.forManager(f.manager).resolve(f.userDataDir,file,'default').guestArchitecture,'arm64');
  const incomplete=original(path.join(f.root,'incomplete'),'x');fs.unlinkSync(path.join(incomplete,'system/bin/app_process64'));
  await assert.rejects(f.manager.registerCustomRuntime({...f.context,runtimePath:incomplete}),/ENOENT|missing/);
  fs.writeFileSync(path.join(incomplete,'system/bin/app_process64'),elf(62),{mode:0o755});assert.throws(()=>Inspection.inspectRoot(incomplete),/inconsistent guest CPU/);
  await f.manager.uninstallRuntime({...f.context,version:file});assert.ok(fs.existsSync(file));
  const broken=f.manager.getState(f.context).installed.find(row=>row.version==='1');fs.appendFileSync(path.join(broken.directory,'image.json'),'invalid');
  assert.equal(f.manager.getState(f.context).installed.find(row=>row.version==='1').ready,false,'an incomplete image remains listed for removal');
  f.available=['2'];await f.manager.refreshCatalog(f.context);await f.manager.uninstallRuntime({...f.context,version:'1'});
  assert.deepEqual(f.manager.getState(f.context).installed.filter(row=>!row.custom).map(row=>row.version),['2']);assert.ok(fs.existsSync(custom));
});
test('ordinary image preparation is offline after one consent and refuses incompatible custom/default content',async t=>{
  const f=fixture(t),row=f.rows().find(row=>row.version==='1'),image={url:row.files[0].url,sha256:row.files[0].digest.value,bytes:row.files[0].bytes,version:row.version};
  const expected=await Images.contentIdentity(f.originals.get('1'));
  const first=await f.manager.ensure(f.context,{image,expected,extractor:'/owned/extractor'});assert.equal(f.consents,1);assert.equal(f.transfers,1);
  assert.deepEqual(f.context.settings,{},'automatic image preparation never writes a user default');
  const counts=[f.discoveries,f.transfers,f.consents];const used=[];
  const again=await f.manager.ensure({...f.context,recordRuntimeUse:value=>used.push(value)},{image,expected,extractor:'/owned/extractor'});
  assert.equal(again.base,first.base);assert.deepEqual([f.discoveries,f.transfers,f.consents],counts);assert.equal(used[0].sourcePath,first.directory);
  const bad=f.originals.get('2');await f.manager.registerCustomRuntime({...f.context,runtimePath:bad});
  f.context.settings={runtimes:{[f.manager.id]:{customDefaults:{default:bad}}}};
  const selected=await f.manager.ensure(f.context,{image,expected,extractor:'/owned/extractor'});assert.equal(selected.base,first.base);assert.equal(selected.external,undefined);
  const good=f.originals.get('1');await f.manager.registerCustomRuntime({...f.context,runtimePath:path.join(good,'system/bin/linker64')});
  f.context.settings={runtimes:{[f.manager.id]:{customDefaults:{default:path.join(good,'system/bin/linker64')}}}};
  const custom=await f.manager.ensure(f.context,{image,expected,extractor:'/owned/extractor'});
  assert.equal(custom.external,true);assert.equal(custom.base,first.base);assert.deepEqual([f.discoveries,f.transfers,f.consents],counts);
  await assert.rejects(f.manager.ensure(f.context,{image,expected:{...expected,sha256:'b'.repeat(64)},extractor:'/owned/extractor'}),/differs from its selected supplier/);
  await assert.rejects(f.manager.ensure(f.context,{image,expected,guestArchitecture:'x64'}),/guest CPU differs from its selected runtime/);
  assert.equal(f.transfers,1);
});
test('missing image lookup stays offline and a new image names its managed reader in the first consent',async t=>{
  const f=fixture(t),row=f.rows().find(row=>row.version==='1'),image={url:row.files[0].url,sha256:row.files[0].digest.value,bytes:row.files[0].bytes,version:row.version};
  let reader=false,readerRefreshes=0,readerInstalls=0,plans=[];
  f.helper.resolveSelection=()=>({ready:reader,version:reader?'reader':null,automatic:true,discoveryRequired:!reader,
    install:reader?{executablePath:'/owned/extractor',installDir:path.join(f.root,'reader')}:null});
  f.helper.refreshCatalog=async()=>{readerRefreshes++;reader=true;};
  f.helper.installRuntime=async()=>{readerInstalls++;return {version:'reader',executablePath:'/owned/extractor',installDir:path.join(f.root,'reader')};};
  const context={...f.context,confirmRuntimeInstall:async plan=>{plans.push(plan);return true;}};
  assert.equal(await f.manager.ensure(context,{image,existingOnly:true}),null);
  assert.deepEqual(fs.readdirSync(f.userDataDir),[]);
  assert.deepEqual([f.discoveries,f.transfers,readerRefreshes,readerInstalls,plans.length],[0,0,0,0,0]);
  await f.manager.ensure(context,{image});
  assert.equal(plans.length,1);assert.deepEqual(plans[0].installOptions.requirements.map(row=>row.managerId),['android-system-image','android-art-image-extractor']);
  assert.equal(readerRefreshes,1);assert.equal(readerInstalls,1);assert.equal(f.transfers,1);
});
test('SDK and runtime version names share one original without deleting an existing default',async t=>{
  const f=fixture(t);await f.manager.refreshCatalog(f.context);
  const installed=await f.manager.installRuntime({...f.context,version:'1'});
  const settings={runtimes:{[f.manager.id]:{defaultVersion:'1'}}};
  const image={...installed.image,version:'runtime-original'};
  await f.manager.installRuntime({...f.context,settings,version:image.version,requiredImage:image});
  const rows=f.manager.getState({...f.context,settings:settings.runtimes[f.manager.id]}).installed;
  assert.deepEqual(rows.map(row=>row.version).sort(),['1','runtime-original']);
  assert.equal(new Set(rows.map(row=>row.base)).size,1);assert.equal(f.transfers,1);
  assert.equal(f.manager.resolveSelection(null,settings,f.userDataDir).version,'1');
  await f.manager.uninstallRuntime({...f.context,version:'runtime-original'});
  assert.ok(fs.existsSync(installed.base));assert.deepEqual(f.manager.getState(f.context).installed.map(row=>row.version),['1']);
});
test('a matching original AIM cache is adopted offline with its original inode and content preserved',async t=>{
  const f=fixture(t);await f.manager.refreshCatalog(f.context);const first=await f.manager.installRuntime({...f.context,version:'1'});
  const legacy=path.join(f.userDataDir,'android/runtimes/aim/images','a'.repeat(64));fs.mkdirSync(path.join(legacy,'system'),{recursive:true});
  fs.copyFileSync(first.base,path.join(legacy,'system.dmg'));fs.cpSync(f.originals.get('1'),path.join(legacy,'system/root'),{recursive:true});
  fs.writeFileSync(path.join(legacy,'system/root.identity'),first.archiveSha256+'\n');
  f.mounts.set(path.join(legacy,'system'),{'image-path':path.join(legacy,'system.dmg'),writeable:false});
  const inode=fs.statSync(path.join(legacy,'system.dmg')).ino,bytes=fs.readFileSync(path.join(legacy,'system.dmg'));
  await f.manager.uninstallRuntime({...f.context,version:'1'});f.imageDependencies.legacyLocations=()=>[legacy];
  const counts=[f.discoveries,f.transfers,f.consents];f.context.confirmRuntimeInstall=()=>assert.fail('An existing original requires no acquisition');
  const adopted=await f.manager.ensure(f.context,{image:first.image});
  assert.equal(adopted.guest.guestArchitecture,'arm64');assert.notEqual(fs.statSync(adopted.base).ino,inode);
  assert.equal(fs.statSync(path.join(legacy,'system.dmg')).ino,inode);assert.deepEqual(fs.readFileSync(path.join(legacy,'system.dmg')),bytes);
  assert.deepEqual([f.discoveries,f.transfers,f.consents],counts);
});
test('the ordinary preparation dialog lists the image and reader before either acquisition',async t=>{
  const f=fixture(t),row=f.rows().find(row=>row.version==='1'),image={url:row.files[0].url,sha256:row.files[0].digest.value,bytes:row.files[0].bytes,version:row.version};
  f.helper.resolveSelection=()=>({ready:false,version:'reader',automatic:true});
  f.helper.getState=()=>({installed:[],catalog:{versions:['reader']}});f.helper.installRuntime=async()=>assert.fail('The install adapter owns this source-only boundary');
  const plans=f.manager.requirements(f.context,{image}),stop=Error('Plans reached installation'),seen=[];
  const mod={id:'fixture',runtimeManagers:[f.manager,f.helper],ensureRuntime:()=>null,getRuntimeRequirements:()=>plans};
  const context={...f.context,runtimeId:'aim',settings:{runtimes:{}},confirmRuntimeInstall:async plan=>{seen.push(plan);return true;}};
  const prepare=require('../src/core/runtime-preparation').prepareForLaunch;
  await assert.rejects(prepare({entry:{},mod,info:{runtime:{}},context,registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},
    install:async()=>{throw stop;}}),error=>error===stop);
  assert.equal(seen.length,1);assert.equal(seen[0].managerId,'android-system-image');assert.equal(seen[0].licenseRequired,true);
  assert.equal(seen[0].licenseUrl,'https://developer.android.com/studio/terms');
  assert.deepEqual(seen[0].companions.map(row=>row.label),['Android image reader']);
  assert.deepEqual([f.discoveries,f.transfers],[0,0]);
});
test('image installation refuses publisher digest and measured guest CPU mismatches before registration',async t=>{
  const f=fixture(t);await f.manager.refreshCatalog(f.context);
  t.mock.method(Transport,'downloadToFile',async(_url,file)=>fs.writeFileSync(file,'corrupt'));
  await assert.rejects(f.manager.installRuntime({...f.context,version:'1'}),/checksum|size/);
  assert.deepEqual(f.manager.getState(f.context).installed,[]);
  t.mock.restoreAll();
  t.mock.method(Transport,'downloadToFile',async(_url,file)=>fs.writeFileSync(file,'archive-1'));
  for(const name of ['linker64','app_process64'])fs.writeFileSync(path.join(f.originals.get('1'),'system/bin',name),elf(62));
  await assert.rejects(f.manager.installRuntime({...f.context,version:'1'}),/guest CPU differs/);
  assert.deepEqual(f.manager.getState(f.context).installed,[]);
});
test('two automatic images retain one unused copy and protect explicit, default, custom and active versions',async t=>{
  const f=fixture(t);await f.manager.refreshCatalog(f.context);
  await f.manager.installRuntime({...f.context,version:'0'});
  const first=await f.manager.installRuntime({...f.context,version:'1',automatic:true});
  await f.manager.installRuntime({...f.context,version:'2',automatic:true});
  assert.deepEqual(Origins.read(f.userDataDir).map(row=>row.version),['1','2']);
  const scope=createRuntimeUseScope({coordinator:coordinatorFor(f.userDataDir).client(),userDataDir:f.userDataDir,managers:[f.manager]});
  await scope.useRuntime({managerId:f.manager.id,version:'1',sectionId:'default',sourcePath:first.installDir});await scope.bind(process.pid);
  const prune=()=>Origins.pruneSuperseded({userDataDir:f.userDataDir,managers:[f.manager],remove:options=>f.manager.uninstallRuntime({...f.context,...options})});
  assert.deepEqual((await prune()).removed,[]);assert.equal(f.manager.getState(f.context).installed.length,3);
  await scope.release();assert.deepEqual((await prune()).removed.map(row=>row.version),['1']);
  assert.deepEqual(f.manager.getState(f.context).installed.map(row=>row.version).sort(),['0','2']);
  f.context.settings={runtimes:{[f.manager.id]:{defaultVersion:'2'}}};
  await f.manager.installRuntime({...f.context,version:'1',automatic:true});
  const protectedResult=await Origins.pruneSuperseded({userDataDir:f.userDataDir,managers:[f.manager],settings:f.context.settings,remove:options=>f.manager.uninstallRuntime({...f.context,...options})});
  assert.ok(!protectedResult.removed.some(row=>row.version==='2'));
});
test('the managed Android image reader supports Refresh, exact install, default, custom and deletion',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-reader-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id='android-art-image-extractor',repository='procrastinine/maclauncher-builds',binary=require('./fixtures/macho-image').image({fileType:2});
  const packages=new Map();
  for(const version of ['1.0','2.0','3.0']){
    const primary={path:'files/bin/android-image-extract',size:binary.length,sha256:sha(binary),mode:0o755,architectures:['arm64']};
    const manifest=Buffer.from(JSON.stringify({schemaVersion:1,managerId:id,version,arch:'arm64',platform:'darwin',minimumMacOS:'13.0',
      upstreamRevision:'a'.repeat(40),executableRelative:'bin/android-image-extract',files:[{...primary,path:'bin/android-image-extract'}]}));
    const files=[primary,{path:'manifest.json',size:manifest.length,sha256:sha(manifest),mode:0o644}],archive=Buffer.from('reader fixture '+version);
    const tag=id+'/v'+version+'/arm64',filename='reader-'+version+'.tar.gz';
    const declaration={id,version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',directoryRelative:id+'/'+version+'/arm64',
      manifestRelative:'manifest.json',manifestSha256:sha(manifest),sourceRelative:null,sourceSha256:sha(manifest),files};
    const record={schemaVersion:2,id,version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',manifestRelative:'manifest.json',
      manifestSha256:sha(manifest),sourceSha256:sha(manifest),updatePolicy:'manual',tag,source:{repository,revision:'b'.repeat(40)},
      asset:{filename,bytes:archive.length,sha256:sha(archive),url:'https://github.com/'+repository+'/releases/download/'+encodeURIComponent(tag)+'/'+filename}};
    packages.set(version,{record,declaration,manifest,archive});
  }
  let rows=[packages.get('1.0').record],requests=0,transfers=0;
  const manager=require('../src/modules/android/image-extractor-manager').createManager({systemVersionSync:()=> '27.0',hostArch:'arm64',
    fetchUrlBuffer:async()=>{requests++;return {status:200,body:Buffer.from(JSON.stringify({schemaVersion:2,projectId:id,updatePolicy:'manual',packages:rows}))};},
    downloadToFile:async(url,file)=>{transfers++;fs.writeFileSync(file,[...packages.values()].find(item=>item.record.asset.url===url).archive);},
    extractArchive:async(file,out)=>{
      const item=[...packages.values()].find(item=>item.archive.equals(fs.readFileSync(file)));
      fs.writeFileSync(path.join(out,'runtime-package.json'),JSON.stringify(item.declaration));
      const payload=path.join(out,'files');fs.mkdirSync(path.join(payload,'files/bin'),{recursive:true});
      fs.writeFileSync(path.join(payload,'files/bin/android-image-extract'),binary,{mode:0o755});fs.writeFileSync(path.join(payload,'manifest.json'),item.manifest);
    }});
  const context={userDataDir:path.join(root,'profile'),settings:{}};
  assert.deepEqual(manager.getState(context).installed,[]);assert.equal(requests,0);
  await manager.refreshCatalog(context);rows=[...packages.values()].map(item=>item.record);await manager.refreshCatalog({...context,force:true});
  for(const version of ['1.0','2.0'])await manager.installRuntime({...context,version});
  const settings={runtimes:{[id]:manager.applySettingsUpdate('setDefault',{version:'1.0'}, {},context)}};
  const before=[requests,transfers];assert.equal(manager.resolveSelection(null,settings,context.userDataDir).version,'1.0');assert.deepEqual([requests,transfers],before);
  const custom=path.join(root,'android-image-extract');fs.writeFileSync(custom,binary,{mode:0o755});
  await manager.registerCustomRuntime({...context,runtimePath:custom});assert.equal(Custom.forManager(manager).resolve(context.userDataDir,custom,'default').ready,true);
  await manager.uninstallRuntime({...context,version:custom});assert.ok(fs.existsSync(custom));
  await manager.uninstallRuntime({...context,version:'2.0'});assert.deepEqual(manager.getState(context).installed.map(row=>row.version),['1.0']);
  const active=await manager.installRuntime({...context,version:'2.0',automatic:true});await manager.installRuntime({...context,version:'3.0',automatic:true});
  const scope=createRuntimeUseScope({coordinator:coordinatorFor(context.userDataDir).client(),userDataDir:context.userDataDir,managers:[manager]});
  await scope.useRuntime({managerId:id,version:'2.0',sectionId:'default',sourcePath:active.installDir});await scope.bind(process.pid);
  const action=require('../src/core/runtime-manager-service').runRuntimeManagerAction;
  const prune=()=>Origins.pruneSuperseded({userDataDir:context.userDataDir,managers:[manager],remove:payload=>action({manager,action:'uninstall',payload,userDataDir:context.userDataDir})});
  assert.deepEqual((await prune()).removed,[]);await scope.release();
  assert.deepEqual((await prune()).removed.map(row=>row.version),['2.0']);
  assert.deepEqual(manager.getState(context).installed.map(row=>row.version).sort(),['1.0','3.0']);
  let preference;await action({manager,action:'setDefault',payload:{version:'3.0'},userDataDir:context.userDataDir,saveSettings:value=>{preference=value;}});
  assert.equal(preference.defaultVersion,'3.0');assert.equal(Origins.read(context.userDataDir).some(row=>row.version==='3.0'),false);
});
