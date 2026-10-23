const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('native constructors receive the declared guest startup vectors',t=>{
 const core=process.env.ANDROID_IMAGE_STARTUP_CORE,ndk=process.env.ANDROID_NDK_CLANG;if(process.platform!=='darwin'||process.arch!=='arm64'||!core||!ndk)return t.skip('Requires an Apple Silicon native core and NDK compiler');
 const parent=process.env.ANDROID_IMAGE_STARTUP_OUTPUT,work=fs.realpathSync(fs.mkdtempSync(path.join(parent?path.resolve(parent):os.tmpdir(),'android-image-startup-')));if(!parent)t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native/startup'),env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const run=(program,args)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:20000});assert.ifError(result.error);return result;},compile=(p,a)=>{const r=run(p,a);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stderr);};
 const guest=path.join(work,'libstartup.so'),probe=path.join(work,'probe');
 compile(ndk,['-shared','-fPIC','-O2','-nostdlib','-Wall','-Wextra','-Werror',path.join(fixture,'guest.c'),'-Wl,-z,max-page-size=16384','-Wl,-soname,libstartup.so','-Wl,-init,startup_init','-o',guest]);
 compile('clang',['-O2','-Wall','-Wextra','-Werror',path.join(fixture,'probe.c'),'-o',probe]);
 const baseline=process.env.ANDROID_IMAGE_STARTUP_EXPECT_BASELINE==='1',records=[];
 for(const mode of baseline?['baseline']:['full','missing','late']){
  const result=run(probe,[path.resolve(core),guest,mode]);fs.writeFileSync(path.join(work,mode+'.stdout.log'),result.stdout);fs.writeFileSync(path.join(work,mode+'.stderr.log'),result.stderr);records.push({mode,pid:result.pid,status:result.status,signal:result.signal});assert.equal(result.signal,null,result.stdout+result.stderr);
  if(baseline){assert.equal(result.status,42,result.stdout+result.stderr);assert.match(result.stderr,/FAIL original constructor ABI omitted/);}
  else{assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS/);}
 }
 fs.writeFileSync(path.join(work,'PROCESS.json'),JSON.stringify({core:path.resolve(core),records})+'\n');t.diagnostic('Evidence '+work);
});
