const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Internal package policy reads the same original state as Binder package clients',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-internal-packages-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-framework-services');
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(file=>path.join(source,'tools',file.path));
 const cp=[temp,...asm,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 const run=(tool,args)=>{const result=spawnSync(tool,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',temp,source+'/framework/ServicePortability.java',source+'/framework/PendingIntentCalls.java',source+'/java/maclauncher/android/framework/HostPackages.java',source+'/java/com/android/server/pm/HostPackageIdentities.java',fixture+'/PackageStateProbe.java',fixture+'/PackageStateTransform.java',fixture+'/../android-window-session/RuntimeFixture.java']);
 run(home+'/bin/java',['-cp',cp,'PackageStateTransform',temp]);
 assert.match(run(home+'/bin/java',['-Xverify:all','-cp',cp,'PackageStateProbe',path.resolve(runtime),temp,path.join(__dirname,'fixtures/android-package-metadata/metadata.apk')]),/PASS original package records shared by Internal policy and Binder clients/);
});
