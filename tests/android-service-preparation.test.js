const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Catalog=require('../src/modules/android/service-packages'),Cache=require('../src/modules/android/prepared-cache');
const deferred=()=>{let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};};
async function fixture(t,names=['example.first','example.second','example.third']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-service-preparation-')),packages=[],retire=[];
 t.after(async()=>{for(const operation of retire)await operation();fs.rmSync(root,{recursive:true,force:true});});
 for(const [index,name]of names.entries()){
  const key='abc'[index].repeat(64),directory=path.join(root,'android/apps',Catalog.codeId(name),'prepared',key),source=path.join(directory,'base.apk');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(source,'owned '+name);
  const metadata={packageName:name,applicationProcessName:name,applicationProcesses:[name,name+':worker']};
  const prepared={key,root:directory,metadata,sourceApk:source,apkSha256:'d'.repeat(64)};
  await Catalog.installServicePackage('/selected/'+name+'.apk',{userDataDir:root},{},{},{inspect:()=>metadata,prepare:async()=>prepared});
  packages.push(prepared);
 }
 const releases=[],started=[],warnings=[],options={uid:10050,retain:async prepared=>async()=>releases.push(prepared.metadata.packageName),
  storage:async entry=>({root:path.join(root,entry.gameId),filesRoot:path.join(root,entry.gameId,'files'),cacheRoot:path.join(root,entry.gameId,'cache')})};
 const launch=(prepare,signal,entry={gameId:'client'})=>Catalog.prepareInstalled(entry, {metadata:{packageName:'example.client'}},{userDataDir:root,signal,logger:{warn:message=>warnings.push(message)}},
  {profile:{servicePackagesVersion:1,providerConnectionsVersion:1}},{},{...options,prepare:async(entry,fields)=>{const prepared=packages.find(p=>Catalog.codeId(p.metadata.packageName)===entry.gameId);started.push(prepared.metadata.packageName);return prepare(prepared,fields);}});
 const sourceLeases=()=>packages.flatMap(p=>fs.readdirSync(p.root).filter(name=>name.startsWith('.use-')));
 return {root,packages,releases,started,warnings,launch,sourceLeases,retire};
}
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Independent package did not start')),2000);})]);}finally{clearTimeout(timer);}}

test('Installed package preparation overlaps two owners and retains declaration order',{skip:process.platform!=='darwin',timeout:10000},async t=>{
 const value=await fixture(t),gates=value.packages.map(deferred),both=deferred(),third=deferred();
 const work=value.launch(async prepared=>{const index=value.packages.indexOf(prepared);if(value.started.length===2)both.resolve();if(index===2)third.resolve();await gates[index].promise;return prepared;});
 value.retire.push(async()=>{gates.forEach(g=>g.resolve());await work.catch(()=>{});});
 // Overlapping owners start concurrently; only the third waits for a free slot.
 await within(both.promise);assert.deepEqual([...value.started].sort(),['example.first','example.second']);
 gates[1].resolve();await within(third.promise);assert.deepEqual(value.started.slice(0,2).sort().concat(value.started.slice(2)),['example.first','example.second','example.third']);
 gates[2].resolve();gates[0].resolve();const result=await work;
 assert.deepEqual(result.services.map(s=>s.record.processName),['example.first','example.first:worker','example.second','example.second:worker','example.third','example.third:worker']);
 assert.equal(new Set(result.services.map(s=>s.record.uid)).size,3);
 assert.equal(value.sourceLeases().length,0);assert.deepEqual(value.releases,[]);
 await result.release();await result.release();assert.deepEqual(value.releases.sort(),['example.first','example.second','example.third']);
});

for(const cancelled of [false,true])test('Installed preparation settles started owners before '+(cancelled?'cancelled':'failed')+' cleanup',
 {skip:process.platform!=='darwin',timeout:10000},async t=>{
 const value=await fixture(t),both=deferred(),fail=deferred(),slow=deferred(),abort=new AbortController(),failure=Error(cancelled?'cancelled preparation':'failed preparation');
 let finished=false;
 const work=value.launch(async(prepared,fields)=>{const index=value.packages.indexOf(prepared);if(value.started.length===2)both.resolve();
  if(index===0){await fail.promise;if(cancelled)fields.signal.throwIfAborted();throw failure;}
  await slow.promise;return prepared;
 },abort.signal);
 work.then(()=>finished=true,()=>finished=true);
 value.retire.push(async()=>{fail.resolve();slow.resolve();await work.catch(()=>{});});
 await within(both.promise);if(cancelled)abort.abort(failure);fail.resolve();
 // The failing owner can release its source, while its peer still owns work.
 for(let i=0;value.sourceLeases().length!==1&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(value.sourceLeases().length,1);assert.equal(finished,false);assert.deepEqual(value.releases,[]);
 assert.deepEqual([...value.started].sort(),['example.first','example.second'],'A failed owner cannot start another package');
 slow.resolve();await assert.rejects(work,error=>error===failure);
 assert.equal(value.sourceLeases().length,0);assert.deepEqual(value.releases,['example.second']);
});

test('Unrelated missing caller code retires only installation metadata during concurrent discovery',
 {skip:process.platform!=='darwin',timeout:10000},async t=>{
 const value=await fixture(t),missing=value.packages[0],identities={...Catalog.read(value.root).identities};
 const save=path.join(value.root,Catalog.dataId(missing.metadata.packageName,'client'),'files/save');
 fs.mkdirSync(path.dirname(save),{recursive:true});fs.writeFileSync(save,'saved caller progress');
 fs.rmSync(path.dirname(path.dirname(missing.root)),{recursive:true});
 const results=await Promise.all([value.launch(async p=>p),value.launch(async p=>p)]);
 for(const result of results){
  assert.deepEqual(result.unavailablePackages,['example.first']);
  assert.deepEqual([...new Set(result.services.map(s=>s.record.packageName))],['example.second','example.third']);
  await result.release();
 }
 assert.deepEqual(Catalog.read(value.root).identities,identities);
 assert.equal(Catalog.read(value.root).packages.some(p=>p.packageName==='example.first'),false);
 assert.equal(fs.readFileSync(save,'utf8'),'saved caller progress');
 assert.equal(fs.existsSync(path.dirname(path.dirname(missing.root))),false,'missing code roots are not fabricated');
 assert(value.warnings.every(message=>message.includes('example.first')));
 fs.mkdirSync(missing.root,{recursive:true});fs.writeFileSync(missing.sourceApk,'reinstalled APK');
 const installed=await Catalog.installServicePackage('/selected/service.apk',{userDataDir:value.root},{},{},
  {inspect:()=>missing.metadata,prepare:async()=>missing});
 assert.equal(installed.uid,identities['example.first']);assert.equal(fs.readFileSync(save,'utf8'),'saved caller progress');
});

test('Selected Google service code remains required and retains its original installation on failure',
 {skip:process.platform!=='darwin',timeout:10000},async t=>{
 const value=await fixture(t,['com.google.android.gms','example.second','example.third']),missing=value.packages[0];
 const before=Catalog.read(value.root);fs.rmSync(missing.root,{recursive:true});
 const off=await value.launch(async p=>p);assert.deepEqual(off.unavailablePackages,[]);await off.release();
 const entry={gameId:'client',runtimeSettings:{klepton:{googleIntegration:true}}};
 await assert.rejects(value.launch(async p=>p,undefined,entry),error=>
  error.code==='ANDROID_APK_SOURCE_MISSING'&&error.installedRecord.packageName==='com.google.android.gms'&&error.installedRecord.scope==='caller');
 assert.deepEqual(Catalog.read(value.root),before);assert.deepEqual(value.warnings,[]);
});

test('Discovery cannot retire a replacement published by the existing source owner',
 {skip:process.platform!=='darwin',timeout:10000},async t=>{
 const value=await fixture(t),previous=value.packages[0],uid=Catalog.read(value.root).identities['example.first'];
 const directory=path.dirname(previous.root),key='d'.repeat(64),root=path.join(directory,key);
 const replacement={...previous,key,root,sourceApk:path.join(root,'base.apk'),apkSha256:key};
 fs.unlinkSync(previous.sourceApk);
 const locked=Cache.locked;let calls=0;
 try{
  Cache.locked=async(target,operation,...args)=>{
   if(target===directory&&++calls===2)await locked(target,async()=>{
    fs.mkdirSync(root);fs.writeFileSync(replacement.sourceApk,'newly published APK');
    await Catalog.installServicePackage('/selected/replacement.apk',{userDataDir:value.root},{},{},
     {inspect:()=>replacement.metadata,prepare:async()=>replacement,retain:async()=>async()=>{}});
   });
   return locked(target,operation,...args);
  };
  const result=await value.launch(async prepared=>prepared===previous?replacement:prepared);
  assert.deepEqual(result.unavailablePackages,[]);await result.release();
 }finally{Cache.locked=locked;}
 const current=Catalog.read(value.root);assert.equal(current.packages.find(p=>p.packageName==='example.first').preparedKey,key);
 assert.equal(current.identities['example.first'],uid);assert.equal(fs.readFileSync(replacement.sourceApk,'utf8'),'newly published APK');
 assert.deepEqual(value.warnings,[]);
});
