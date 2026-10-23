const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');

test('owned EGL/Metal teardown releases terminal failures and retains genuinely inflight work with a bounded deadline',t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon and the macOS SDK');
 const source=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),fixtures=path.resolve('tests/fixtures/android-presentation');
 const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
 assert.ok(fs.existsSync(path.join(home,'include/jni.h')),'Requires JDK 21 headers');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-retirement-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const run=(command,args)=>{const result=spawnSync(command,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const mock=path.join(output,'libshared-mock.dylib');
 run('clang++',['-std=c++20','-dynamiclib','-I'+source,path.join(fixtures,'shared-mock.cpp'),'-o',mock]);
 const binary=path.join(output,'retirement');
 run('clang++',['-arch','arm64','-mmacosx-version-min=13.0','-std=c++20','-O1','-fobjc-arc','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-Wno-unused-parameter','-Wno-missing-field-initializers','-I'+source,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-DPRESENTATION_SOURCE='+JSON.stringify(path.join(source,'presentation.mm')),path.join(fixtures,'retirement.mm'),path.join(source,'pixel-copy.mm'),...['Foundation','Metal','QuartzCore','IOSurface'].flatMap(name=>['-framework',name]),'-o',binary]);
 assert.match(run(binary,[mock]),/PASS \d+ actual EGL\/Metal retirement checks/);
});
