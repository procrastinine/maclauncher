const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');

test('Android build discovers production adapters without API eligibility or test sources',async t=>{
 const {frameworkInputs}=await import('../src/modules/android/native/framework-base.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'java/maclauncher/android/platform'),{recursive:true});
 fs.writeFileSync(path.join(root,'framework-binary.json'),JSON.stringify({files:[]}));
 const adapter=path.join(root,'java/maclauncher/android/platform/Adapter.java');
 fs.writeFileSync(adapter,'package maclauncher.android.platform; public class Adapter { private native void bridge(); }');
 fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'tests/Probe.java'),'public class Probe {}');
 assert.deepEqual(frameworkInputs(root,root).sources,[adapter]);
});

test('Android built framework executes upstream Java through existing host adapters',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!runtime||!fs.existsSync(path.join(runtime,'android-framework.jar')))return t.skip('KLEPTON_NATIVE_RUNTIME with the full framework is required');
 const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():null);
 if(!home)return t.skip('Java 21 is required');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-base-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)).join(path.delimiter);
 function run(tool,args){const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',timeout:30000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 run('javac',['--release','21','-cp',cp,'-d',temporary,path.join(__dirname,'fixtures/android-framework-services/FrameworkBaseProbe.java')]);
 assert.match(run('java',['-Xverify:all','-cp',temporary+path.delimiter+cp,'FrameworkBaseProbe']),/PASS full AOSP implementations/);
});
