const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('prepared native ABI reaches original package and Binder metadata',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the Android native runtime and Java21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-package-abi-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native/java/maclauncher/android/framework'),fixture=path.join(__dirname,'fixtures/android-framework-services');
 const cp=[temp,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 const run=(tool,args)=>{const result=spawnSync(tool,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',temp,source+'/HostPackages.java',source+'/HostContext.java',fixture+'/PackageAbiProbe.java',fixture+'/../android-window-session/RuntimeFixture.java']);
 assert.match(run(home+'/bin/java',['-Xverify:all','-cp',cp,'PackageAbiProbe',path.resolve(runtime),temp,path.join(__dirname,'fixtures/android-package-metadata/metadata.apk')]),/PASS original package state and Binder retain prepared ARM32 ABI/);
});
