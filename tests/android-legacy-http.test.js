const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Delivered Android legacy HTTP module performs a real local exchange',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout?.trim();
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, Android runtime and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-legacy-http-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:16<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const javac=path.join(home,'bin/javac'),framework=path.resolve(runtime,'android-framework.jar');
 const cp=[tmp,framework,path.resolve(runtime,'android-host.jar')].join(path.delimiter);
 run(javac,['--release','21','-cp',cp,'-d',tmp,path.resolve(__dirname,'fixtures/android-framework-services/LegacyHttpProbe.java')]);
 const result=run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',cp,'LegacyHttpProbe',path.resolve(runtime)]);
 assert.match(result.stdout,/PASS complete Android legacy HTTP module/);assert.doesNotMatch(result.stdout+result.stderr,/WARNING|FATAL/);
});
