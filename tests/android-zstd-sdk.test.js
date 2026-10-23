const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original APK Zstandard SDK retains its defining loader and real JNI compression',{timeout:90000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,apk=process.env.KLEPTON_ZSTD_APK;
 if(process.platform!=='darwin'||!runtime||!home||!apk)return t.skip('Requires Java21, an Android runtime and an original APK containing zstd-jni');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-zstd-sdk-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|RESHADE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:75000,maxBuffer:8<<20,...options});assert.ifError(result.error);assert.equal(result.signal,null,String(result.stdout)+String(result.stderr));assert.equal(result.status,0,String(result.stdout)+String(result.stderr));return result;};
 const entries=run('unzip',['-Z1',path.resolve(apk)]).stdout.split('\n').filter(name=>/^lib\/arm64-v8a\/libzstd-jni[^/]*\.so$/.test(name));
 assert.equal(entries.length,1,'One original ARM64 JNI implementation');
 const native=path.join(output,'native');fs.mkdirSync(native);fs.writeFileSync(path.join(native,path.basename(entries[0])),run('unzip',['-p',path.resolve(apk),entries[0]],{encoding:null}).stdout);
 const index=path.join(output,'converted.jar'),converter=['converter-overlay.jar','dex2jvm.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
 run(path.join(home,'bin/java'),['-Dmaclauncher.dex.demand=true','-cp',converter,'io.github.kksimp.dex2jvm.ConvertApkSet',path.resolve(runtime,'android-api-metadata.jar'),index,path.resolve(apk)]);
 const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-implicit:none','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/ZstdSdkProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
 const identityRoot=path.join(output,'identity');fs.mkdirSync(identityRoot);
 const identity=await require('../src/modules/android/process-channel').processNamespace(identityRoot,1);Object.assign(env,identity.environment);
 const result=run(path.join(home,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Dmaclauncher.dex.demand=true','-Xverify:all','-cp',cp,'maclauncher.android.framework.ZstdSdkProbe',path.resolve(runtime),path.resolve(apk),native,index,path.join(output,'data')]);
 assert.match(result.stdout,/PASS original SDK family resolution classes=/);assert.match(result.stdout,/PASS original JNI streams and byte arrays/);t.diagnostic(result.stdout.trim());
});
