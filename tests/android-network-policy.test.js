const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('authenticated UID policy reaches the original connectivity client before dispatch and retires in order',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,classes=process.env.ANDROID_HOST_CLASSES,home=process.env.JAVA_HOME;
 if(!runtime||!classes||!home)return t.skip('Requires current Android host classes, complete framework and Java21');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-uid-network-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const cp=[output,classes,path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 const run=(command,args)=>{const value=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(value.error);assert.equal(value.status,0,value.stdout+value.stderr);return value.stdout;};
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve(__dirname,'fixtures/android-framework-services/NetworkPolicyProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.framework.NetworkPolicyProbe']),/PASS original connectivity client policy/);
});
