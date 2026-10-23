const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Account framework enrollment uses runtime ownership while real prepared APKs retain their source lease',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-source-owner-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const packageName='fixture.provider',uid=10000,key='a'.repeat(64),apkSha256='f'.repeat(64);
 const service=path.join(root,'android/services'),preparedRoot=path.join(root,'android/apps/provider/prepared',key),runtime=path.join(root,'runtime');
 fs.mkdirSync(service,{recursive:true,mode:0o700});fs.mkdirSync(preparedRoot,{recursive:true,mode:0o700});fs.mkdirSync(runtime);
 fs.writeFileSync(path.join(service,'catalog.json'),JSON.stringify({schemaVersion:1,nextUid:10001,identities:{[packageName]:uid},packages:[]}));
 fs.writeFileSync(path.join(preparedRoot,'base.apk'),'fixture APK');fs.writeFileSync(path.join(preparedRoot,'prepared.json'),JSON.stringify({schemaVersion:2,key,apkSha256,metadata:{packageName},files:[]}));
 const framework={root:runtime,metadata:{packageName:'android',applicationProcessName:'android.accounts'},sourceApk:path.join(runtime,'android-framework.jar'),filesRoot:path.join(root,'accounts/files'),nativeRoot:path.join(runtime,'native')};
 const prepared={root:preparedRoot,key,apkSha256,metadata:{packageName},sourceApk:path.join(preparedRoot,'base.apk'),filesRoot:path.join(root,'provider/files'),nativeRoot:path.join(preparedRoot,'lib/arm64-v8a')};
 const supervisor=await require('../src/modules/android/service-processes').prepareConnections({userDataDir:root,game:framework,config:{packageName:'android'},installed:{uid:1000,services:[{record:{packageName,processName:packageName,uid},prepared}],release:async()=>{}}});t.after(()=>supervisor.close());
 const descriptors=supervisor.sandbox.installedPackages;
 assert.equal(descriptors.find(value=>value.packageName==='android').preparedRoot,undefined,'framework root is not presented as an APK preparation');
 assert.equal(descriptors.find(value=>value.packageName===packageName).preparedRoot,preparedRoot,'actual APK preparation provenance survives descriptor creation');
 const sources=require('../src/modules/android/platform-services/package-sources').createPackageSources(root);t.after(()=>sources.close());
 await assert.rejects(sources.acquire([{...descriptors[0],preparedRoot:runtime}]),/outside its prepared installation/,'the earlier runtime-root descriptor reproduces the original owner rejection');
 const release=await sources.acquire(descriptors);assert.ok(fs.readdirSync(preparedRoot).some(name=>name.startsWith('.use-')),'real source is leased by the existing supervisor');
 assert.equal(fs.readdirSync(runtime).length,0,'runtime payload is not assigned preparation-cache markers');await release();
});
test('Canonical package generations stay leased across two peers and retire with the final row',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-package-source-lifetime-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const pkg='fixture.package',uid=10000,source=path.resolve('src/modules/android');
 const service=path.join(root,'android/services');fs.mkdirSync(service,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(service,'catalog.json'),JSON.stringify({schemaVersion:1,nextUid:10001,identities:{[pkg]:uid},packages:[]}));
 const directory=path.join(root,'android/apps/fixture/prepared');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 function generation(letter,time){const key=letter.repeat(64),preparedRoot=path.join(directory,key);fs.mkdirSync(preparedRoot);fs.writeFileSync(path.join(preparedRoot,'base.apk'),'original fixture bytes');fs.writeFileSync(path.join(preparedRoot,'prepared.json'),JSON.stringify({schemaVersion:2,key,apkSha256:'f'.repeat(64),metadata:{packageName:pkg},files:[]}));fs.utimesSync(preparedRoot,time,time);return {preparedRoot,packageName:pkg,uid,apkSha256:'f'.repeat(64)};}
 const a=generation('a',100),owner=require(source+'/platform-services/package-sources').createPackageSources(root),cache=require(source+'/prepared-cache');t.after(()=>owner.close());
 const inputA=await owner.acquire([a]),peerA=owner.retainCanonical([a.preparedRoot]);await inputA();
 const b=generation('b',200),inputB=await owner.acquire([b]),peerB=owner.retainCanonical([a.preparedRoot]);await inputB();
 await cache.prunePrepared(directory,b.preparedRoot);assert.ok(fs.existsSync(a.preparedRoot),'canonical source survives superseding preparation');
 await peerA();assert.ok(fs.existsSync(a.preparedRoot),'the second peer still owns the first canonical source');
 await peerB();assert.equal(fs.existsSync(a.preparedRoot),false,'last row retirement releases the superseded source');
 assert.ok(fs.existsSync(b.preparedRoot),'current generation remains available');
 await assert.rejects(owner.acquire([{...b,packageName:'foreign.package'}]),/installed identity/);
 assert.throws(()=>owner.retainCanonical([root]),/not admitted/);
 const outside=path.join(root,'outside');fs.mkdirSync(outside);await assert.rejects(owner.acquire([{...b,preparedRoot:outside}]),/outside its prepared/);
 assert.equal(fs.readdirSync(outside).length,0,'rejected reply creates no arbitrary source capability');
});
test('Original package rows follow authenticated peers without retaining stale APK generations',{timeout:40000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,apk=process.env.ANDROID_TEST_SIGNED_APK;
 if(process.platform!=='darwin'||!runtime||!home||!apk)return t.skip('Requires the complete Android runtime, Java21 and a signed APK');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-peer-packages-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native/java'),cp=[temp,...['android-host.jar','android-framework.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter);
 const identity=await require('../src/modules/android/process-channel').processNamespace(temp,1);
 const run=(name,args)=>{const r=spawnSync(path.join(home,'bin',name),args,{encoding:'utf8',env:{...process.env,...identity.environment},timeout:30000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',temp,...['maclauncher/android/framework/HostPackages','maclauncher/android/framework/HostServices','maclauncher/android/framework/HostDexFiles','maclauncher/android/framework/HostSharedLibraries','maclauncher/android/framework/HostPermissions','maclauncher/android/ProcessAuthority'].map(n=>path.join(source,n+'.java')),
  path.resolve('tests/fixtures/android-package-metadata/TransientPackageProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
 assert.match(run('java',['-Xverify:all','-cp',cp,'maclauncher.android.framework.TransientPackageProbe',path.resolve(runtime),temp,path.resolve('tests/fixtures/android-package-metadata/metadata.apk'),path.resolve(apk)]),/PASS original verified package identity, two peers, canonical source lifetime, new generation and persistent rows/);
});
