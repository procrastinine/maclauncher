const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Catalog=require('../src/modules/android/service-packages'),Cache=require('../src/modules/android/prepared-cache');

test('framework service bootstrap retains canonical game sources without creating peer game processes',async t=>{
 const profile=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-package-owner-')));t.after(()=>fs.rmSync(profile,{recursive:true,force:true}));
 function prepared(gameId,name,letter){
  const key=letter.repeat(64),root=path.join(profile,'android/apps',gameId,'prepared',key),nativeRoot=path.join(root,'input/lib/armeabi-v7a');
  fs.mkdirSync(nativeRoot,{recursive:true});const sourceApk=path.join(root,'base.apk');fs.writeFileSync(sourceApk,name);
  const metadata={packageName:name,applicationProcessName:name,versionCode:1};
  fs.writeFileSync(path.join(root,'prepared.json'),JSON.stringify({schemaVersion:2,key,apkSha256:key,metadata,files:[]}));
  return {key,root,sourceApk,nativeRoot,apkSha256:key,metadata};
 }
 const first=prepared('first','example.first','a'),second=prepared('second','example.second','b');
 const payload={profile:{servicePackagesVersion:1,frameworkServicesVersion:1}};
 for(const [gameId,value]of[['first',first],['second',second]]){
  const result=await Catalog.prepareInstalled({gameId},value,{userDataDir:profile},payload,{});
  assert.deepEqual(result.services,[],'another installed game is metadata, not a service child');await result.release();
 }
 const snapshot=await Catalog.retainApplications(profile);t.after(()=>snapshot.release());
 assert.equal(snapshot.packages.length,2);assert.equal(new Set(snapshot.packages.map(p=>p.uid)).size,2);
 assert.deepEqual(snapshot.packages.map(p=>p.nativeRoot),[first.nativeRoot,second.nativeRoot]);
 assert.equal(snapshot.packages[0].dataRoot,path.join(profile,'android/apps/first/data'));
 await snapshot.release();
 for(const letter of['c','d'])prepared('first','example.first',letter);
 await Cache.prunePrepared(path.dirname(first.root),path.join(path.dirname(first.root),'d'.repeat(64)));
 assert.equal(fs.readFileSync(first.sourceApk,'utf8'),'example.first','catalog publication retains the original generation independently of process leases');
 await snapshot.release();
 const restarted=await Catalog.retainApplications(profile);assert.equal(restarted.packages[0].sourceApks[0],first.sourceApk);await restarted.release();
 await Catalog.setEnabled(profile,'example.first',false);
 const enabled=await Catalog.retainApplications(profile);assert.deepEqual(enabled.packages.map(pkg=>pkg.packageName),['example.second']);await enabled.release();
 let retired=false;await Catalog.removeApplication(profile,'first',{retire:async packages=>{assert.deepEqual(packages,['example.first']);assert.equal(Catalog.read(profile).packages.some(p=>p.packageName==='example.first'),true,'original grants retire before catalog and file removal');retired=true;}});assert.equal(retired,true);
 const removed=await Catalog.retainApplications(profile);assert.deepEqual(removed.packages.map(p=>p.packageName),['example.second']);await removed.release();
 assert.equal(fs.readFileSync(first.sourceApk,'utf8'),'example.first','metadata retirement does not delete source bytes before ordinary game cleanup');
});

test('unavailable unrelated application code retires only its installation, preserving identities and saves',async t=>{
 const profile=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-package-unavailable-')));t.after(()=>fs.rmSync(profile,{recursive:true,force:true}));
 function prepared(gameId,name,letter){
  const key=letter.repeat(64),root=path.join(profile,'android/apps',gameId,'prepared',key),nativeRoot=path.join(root,'input/lib/arm64-v8a');
  fs.mkdirSync(nativeRoot,{recursive:true});const sourceApk=path.join(root,'base.apk');fs.writeFileSync(sourceApk,name);
  return {key,root,sourceApk,nativeRoot,apkSha256:key,metadata:{packageName:name,versionCode:1}};
 }
 const payload={profile:{servicePackagesVersion:1,frameworkServicesVersion:1}};
 const valid=prepared('valid','example.valid','a'),missing=prepared('missing','example.missing','b');
 for(const [gameId,value]of[['valid',valid],['missing',missing]])await(await Catalog.prepareInstalled({gameId},value,{userDataDir:profile},payload,{})).release();
 const identities={...Catalog.read(profile).identities},save=path.join(profile,'android/apps/missing/data/files/save');fs.mkdirSync(path.dirname(save),{recursive:true});fs.writeFileSync(save,'retained progress');
 fs.rmSync(missing.root,{recursive:true,force:true});
 const snapshot=await Catalog.retainApplications(profile);
 assert.deepEqual(snapshot.packages.map(item=>item.packageName),['example.valid']);assert.deepEqual(snapshot.unavailablePackages,['example.missing']);await snapshot.release();
 assert.deepEqual(Catalog.read(profile).identities,identities);assert.equal(fs.readFileSync(save,'utf8'),'retained progress');
 const replacement=prepared('missing','example.missing','c');
 const reinstalled=await Catalog.prepareInstalled({gameId:'missing'},replacement,{userDataDir:profile},payload,{});assert.equal(reinstalled.uid,identities['example.missing']);await reinstalled.release();
 // A missing whole app root has the same source-owner result as a missing
 // generation. Metadata retirement must not fabricate a new app directory.
 const vanished=prepared('vanished','example.vanished','e');
 await(await Catalog.prepareInstalled({gameId:'vanished'},vanished,{userDataDir:profile},payload,{})).release();
 const vanishedRoot=path.join(profile,'android/apps/vanished'),vanishedUid=Catalog.read(profile).identities['example.vanished'];fs.rmSync(vanishedRoot,{recursive:true});
 await assert.rejects(Catalog.retainSource(profile,'example.vanished'),error=>error.code==='ANDROID_APK_SOURCE_MISSING'&&error.installedRecord.packageName==='example.vanished');
 const roots=await Catalog.retainApplications(profile);assert.deepEqual(roots.unavailablePackages,['example.vanished']);assert.deepEqual(roots.packages.map(item=>item.packageName),['example.valid','example.missing']);await roots.release();
 assert.equal(Catalog.read(profile).identities['example.vanished'],vanishedUid);assert.equal(fs.existsSync(vanishedRoot),false);
 const lock=Cache.locked,unrelated=Object.assign(new Error('unrelated source operation'),{code:'ENOENT',path:path.join(profile,'unrelated')});
 try{Cache.locked=async()=>{throw unrelated;};await assert.rejects(Catalog.retainSource(profile,'example.valid'),error=>error===unrelated);}finally{Cache.locked=lock;}
 // An invalid source must not be mistaken for an unavailable installation.
 fs.unlinkSync(replacement.sourceApk);fs.symlinkSync(valid.sourceApk,replacement.sourceApk);
 await assert.rejects(Catalog.retainApplications(profile),/not a regular file/);assert.equal(Catalog.read(profile).packages.length,2);
 const service=prepared(Catalog.codeId('example.service'),'example.service','d');
 await Catalog.installServicePackage('/selected/service.apk',{userDataDir:profile},{},{},{inspect:()=>service.metadata,prepare:async()=>service});fs.unlinkSync(service.sourceApk);
 await assert.rejects(Catalog.retainSource(profile,'example.service'),error=>error.code==='ANDROID_APK_SOURCE_MISSING');
 fs.rmSync(path.join(profile,'android/apps',Catalog.codeId('example.service')),{recursive:true});
 await assert.rejects(Catalog.retainSource(profile,'example.service'),error=>error.code==='ANDROID_APK_SOURCE_MISSING'&&error.installedRecord.scope==='caller');
 assert.equal(Catalog.read(profile).packages.some(item=>item.packageName==='example.service'),true,'required services remain installed and report their missing code');
});

