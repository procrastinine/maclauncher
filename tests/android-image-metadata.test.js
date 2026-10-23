const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('mapped ELF program-header ownership survives changes to the live ELF header',t=>{
 const core=process.env.ANDROID_IMAGE_METADATA_CORE,ndk=process.env.ANDROID_NDK_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!core||!ndk)return t.skip('Requires an Apple Silicon native core and NDK compiler');
 const parent=process.env.ANDROID_IMAGE_METADATA_OUTPUT,work=fs.realpathSync(fs.mkdtempSync(path.join(parent?path.resolve(parent):os.tmpdir(),'android-image-metadata-')));if(!parent)t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native/image-metadata'),env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const run=(program,args)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:20000});assert.ifError(r.error);return r;};
 const compile=(program,args)=>{const r=run(program,args);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stderr);};
 const guest=path.join(work,'libmetadata.so'),probe=path.join(work,'probe');
 compile(ndk,['-shared','-fPIC','-O2','-nostdlib','-Wall','-Wextra','-Werror',path.join(fixture,'guest.c'),'-Wl,-z,max-page-size=16384','-Wl,-soname,libmetadata.so','-o',guest]);
 compile('clang',['-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native'),path.join(fixture,'probe.c'),'-o',probe]);
 const result=run(probe,[path.resolve(core),guest]);fs.writeFileSync(path.join(work,'stdout.log'),result.stdout);fs.writeFileSync(path.join(work,'stderr.log'),result.stderr);fs.writeFileSync(path.join(work,'PROCESS.json'),JSON.stringify({pid:result.pid,status:result.status,signal:result.signal,core:path.resolve(core)})+'\n');
 assert.equal(result.signal,null,result.stdout+result.stderr);
 if(process.env.ANDROID_IMAGE_METADATA_EXPECT_BASELINE==='1'){assert.equal(result.status,42,result.stdout+result.stderr);assert.match(result.stderr,/FAIL mapped PHDR identity changed/);}
 else{assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS mapped PHDR pointer\/count/);}
 t.diagnostic('Evidence '+work);
});
