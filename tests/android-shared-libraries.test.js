const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Original shared-library policy, package metadata and LoadedApk owners bind executable VM loaders',{timeout:40000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the complete Android runtime and Java21');
 const xml=path.resolve(runtime,'art/image/system/etc/permissions/org.apache.http.legacy.xml');
 if(!fs.existsSync(xml))return t.skip('Requires original platform shared-library declarations');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-shared-libraries-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native/java'),cp=[temp,...['android-host.jar','android-framework.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter);
 const identity=await require('../src/modules/android/process-channel').processNamespace(temp,1);
 const run=(name,args)=>{const result=spawnSync(path.join(home,'bin',name),args,{encoding:'utf8',env:{...process.env,...identity.environment},timeout:30000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',temp,...['HostPackages','HostPermissions','HostSharedLibraries','HostDexFiles'].map(name=>path.join(source,'maclauncher/android/framework',name+'.java')),path.resolve('tests/fixtures/android-package-metadata/SharedLibraryProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
 assert.match(run('java',['-Xverify:all','-cp',cp,'maclauncher.android.framework.SharedLibraryProbe',path.resolve(runtime),temp,path.resolve('tests/fixtures/android-package-metadata/metadata.apk'),xml]),/PASS original optional libraries, dependency graph, canonical loaders, API visibility and target policy/);
});
