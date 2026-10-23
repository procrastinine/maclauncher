const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('dladdr retains the admitted load-time guest pathname',t=>{
 const core=process.env.ANDROID_DLADDR_PATH_CORE,ndk=process.env.ANDROID_NDK_CLANG,jdk=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!core||!ndk||!jdk)return t.skip('Requires an Apple Silicon native core, NDK compiler and Java21');
 const output=process.env.ANDROID_DLADDR_PATH_OUTPUT,work=fs.realpathSync(fs.mkdtempSync(path.join(output?path.resolve(output):os.tmpdir(),'android-dladdr-path-')));if(!output)t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native/dladdr-path'),env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const commands=[],run=(p,args)=>{commands.push({program:p,args});const r=spawnSync(p,args,{env,encoding:'utf8',timeout:20000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);return r;},compile=(p,args)=>{const r=run(p,args);assert.equal(r.status,0,r.stderr);};
 const helper=path.join(work,'probe.dylib'),guest=path.join(work,'libfixture.so');
 compile(ndk,['-shared','-fPIC','-nostdlib','-O2','-Wall','-Wextra','-Werror',path.join(fixture,'guest.c'),'-Wl,-soname,libdeclared.so','-Wl,-z,max-page-size=16384','-o',guest]);
 compile('clang',['-dynamiclib','-O2','-Wall','-Wextra','-Werror','-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),path.join(fixture,'probe.c'),'-o',helper]);
 compile(path.join(jdk,'bin/javac'),['--release','21','-d',work,path.join(fixture,'PathProbe.java')]);
 const baseline=process.env.ANDROID_DLADDR_PATH_EXPECT_BASELINE==='1',result=run(path.join(jdk,'bin/java'),['-Xcheck:jni','-cp',work,'PathProbe',helper,path.resolve(core),work,guest,String(baseline)]);
 fs.writeFileSync(path.join(work,'stdout.log'),result.stdout);fs.writeFileSync(path.join(work,'stderr.log'),result.stderr);fs.writeFileSync(path.join(work,'PROCESS.json'),JSON.stringify({core:path.resolve(core),pid:result.pid,status:result.status,signal:result.signal,commands})+'\n');
 assert.equal(result.status,baseline?42:0,result.stdout+result.stderr);assert.match(baseline?result.stderr:result.stdout,baseline?/FAIL dladdr returned basename/:/PASS dladdr canonical admitted guest path/);t.diagnostic('Evidence '+work);
});
