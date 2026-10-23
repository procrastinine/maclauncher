const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('./helpers/android-java');
const fixtures=path.join(__dirname,'fixtures/android-native');
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
test('Android text uses original upstream mutable spans with JVM allocation and casing adapters',t=>{
 let home=process.env.JAVA_HOME;if(!home&&process.platform==='darwin'){const r=spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'});if(r.status===0)home=r.stdout.trim();}if(!home||!fs.existsSync(path.join(home,'bin/javac')))return t.skip('Requires Java 21 development tools');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-text-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME||require('../src/modules/android/runtime').runtimeRoot(),classpath=output+path.delimiter+path.join(runtime,'android-host.jar');
 run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',output,path.join(fixtures,'TextSpanProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',classpath,'TextSpanProbe',path.resolve(runtime)]),/PASS \d+ upstream spans/);
});
