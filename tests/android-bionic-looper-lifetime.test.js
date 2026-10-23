const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('Externally retained real Loopers preserve descriptor removal across Java and physical retirement',{timeout:30000},t=>{
 const {ANDROID_BIONIC_SOURCE:source,ANDROID_JAVA_HOME:java,KLEPTON_NATIVE_RUNTIME:runtime}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![source,java,runtime].every(Boolean))return t.skip('Requires explicit Android native source, original host runtime and Java');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-looper-lifetime-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const output=process.env.ANDROID_LOOPER_OUTPUT?path.resolve(process.env.ANDROID_LOOPER_OUTPUT):temporary;fs.mkdirSync(output,{recursive:true});
 const native=path.resolve(source,'src/modules/android/native'),library=path.resolve(runtime,'native'),fixture=path.resolve('tests/fixtures/android-native/bionic-looper-lifetime.c');
 const run=(program,args)=>spawnSync(program,args,{encoding:'utf8',timeout:15000,maxBuffer:2<<20});
 const compile=(name,looper)=>{
  const binary=path.join(output,name),includes=[looper,path.join(native,'bionic/looper'),path.join(native,'bionic/ndk'),path.join(native,'bionic'),native,path.join(native,'bionic/ndk/include'),path.join(java,'include'),path.join(java,'include/darwin')];
  const args=['-std=c11','-O0','-g','-DKLJ_LOOPER_SOURCE="'+path.join(looper,'looper-host-generated.c')+'"',...includes.flatMap(p=>['-I',p]),fixture,path.join(native,'jni-invocation.c'),'-L',library,'-lklepton-jvm','-Wl,-rpath,'+library,'-L',path.join(java,'lib/server'),'-ljvm','-Wl,-rpath,'+path.join(java,'lib/server'),'-o',binary];
  const result=run('/usr/bin/clang',args);assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return binary;
 };
 if(process.env.ANDROID_LOOPER_BASELINE_SOURCE){
  const result=run(compile('baseline',path.resolve(process.env.ANDROID_LOOPER_BASELINE_SOURCE)),[]);fs.writeFileSync(path.join(output,'baseline.log'),result.stdout+result.stderr);
  assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stdout,/physical-end-external-remove actual=0 expected=1/);assert.match(result.stdout,/java-end-external-remove actual=0 expected=1/);
 }
 const result=run(compile('fixed',path.join(native,'bionic/looper')),[]);fs.writeFileSync(path.join(output,'fixed.log'),result.stdout+result.stderr);
 assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/RESULT failures=0 borrowed=10 released=10/);assert.match(result.stdout,/retired-thread-nodes actual=0 expected=0/);
 t.diagnostic('Eight original Looper lifetime, callback authority and FD cleanup cases passed');
});
