const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'../src/modules/android/native');
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
test('NativeActivity keeps the complete original lifecycle and JNI object owner',t=>{
 const framework=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!framework)return t.skip('KLEPTON_AOSP_FRAMEWORK identifies the original framework archive');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-nativeactivity-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(file=>path.join(source,'tools',file.path)).join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',asm,'-d',output,path.join(source,'framework/NativeBindings.java'),path.join(__dirname,'fixtures/android-framework-policy/NativeActivityOwnerProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-cp',output+path.delimiter+asm,'NativeActivityOwnerProbe',framework]),/PASS original NativeActivity bytes and \d+ JNI declarations preserved/);
});
