const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('native main-program handles remain distinct from caller-relative lookup',t=>{
 const core=process.env.ANDROID_MAIN_HANDLE_CORE,ndk=process.env.ANDROID_NDK_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!core||!ndk)return t.skip('Requires an Apple Silicon native core and NDK compiler');
 const output=process.env.ANDROID_MAIN_HANDLE_OUTPUT,work=fs.realpathSync(fs.mkdtempSync(path.join(output?path.resolve(output):os.tmpdir(),'android-main-handle-')));
 if(!output)t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native/main-handle'),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const run=(program,args)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:20000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);return r;};
 const compile=(program,args)=>{const r=run(program,args);assert.equal(r.status,0,r.stderr);};
 const flags=['-shared','-fPIC','-O2','-nostdlib','-Wall','-Wextra','-Werror','-Wl,-z,max-page-size=16384'];
 const first=path.join(work,'libmain-first.so'),second=path.join(work,'libmain-second.so'),local=path.join(work,'libmain-local.so'),probe=path.join(work,'probe');
 for(const [file,define] of [[first,null],[second,'MAIN_HANDLE_SECOND'],[local,'MAIN_HANDLE_LOCAL']])compile(ndk,[...flags,...(define?['-D'+define]:[]),path.join(fixture,'guest.c'),'-ldl','-Wl,-soname,'+path.basename(file),'-o',file]);
 compile('clang',['-O2','-Wall','-Wextra','-Werror',path.join(fixture,'probe.c'),'-o',probe]);
 const baseline=process.env.ANDROID_MAIN_HANDLE_EXPECT_BASELINE==='1',records=[];
 for(const sdk of baseline?[35]:[35,22]){
  const result=run(probe,[path.resolve(core),first,second,local,String(sdk),baseline?'baseline':'fixed']);
  fs.writeFileSync(path.join(work,sdk+'.stdout.log'),result.stdout);fs.writeFileSync(path.join(work,sdk+'.stderr.log'),result.stderr);
  records.push({sdk,pid:result.pid,status:result.status,signal:result.signal});
  assert.equal(result.status,baseline?42:0,result.stdout+result.stderr);
  assert.match(baseline?result.stderr:result.stdout,baseline?/FAIL dlopen\(NULL\) aliases RTLD_NEXT/:/PASS main-program handle/);
 }
 fs.writeFileSync(path.join(work,'PROCESS.json'),JSON.stringify({core:path.resolve(core),records})+'\n');t.diagnostic('Evidence '+work);
});
