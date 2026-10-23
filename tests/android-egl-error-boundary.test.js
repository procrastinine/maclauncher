const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('C EGL presenter failures retain typed errors without creating Java exceptions',{timeout:60000},t=>{
 if(process.platform!=='darwin')return t.skip('Requires the macOS Objective-C compiler');
 const jdk=process.env.ANDROID_JDK||process.env.JAVA_HOME;if(!jdk)return t.skip('Requires JNI headers');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),dependencies=path.resolve(process.env.ANDROID_NATIVE_DEPENDENCIES||'src/modules/android/native');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-error-boundary-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const env={...process.env,ASAN_OPTIONS:'abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const run=(program,args)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:8<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const presentation=path.join(native,'presentation.mm'),source=fs.readFileSync(presentation,'utf8'),egl=fs.readFileSync(path.join(native,'native-egl.mm'),'utf8');
 assert.doesNotMatch(source,/\bExceptionClear\s*\(/);assert.doesNotMatch(egl,/\bExceptionClear\s*\(/);
 const start=egl.indexOf('void *bufferSurface('),end=egl.indexOf('\nbool refresh(',start);assert.ok(start>=0&&end>start,'Actual EGL buffer helper');
 const fixtures=path.resolve(__dirname,'fixtures/android-presentation'),control=fs.readFileSync(path.join(fixtures,'error-boundary.mm'),'utf8').replace('/* NATIVE_EGL_BUFFER_SURFACE */',egl.slice(start,end));
 fs.writeFileSync(path.join(output,'control.mm'),control);
 const sanitize=['-fsanitize=address,undefined','-fno-omit-frame-pointer'];
 const flags=['-arch','arm64','-mmacosx-version-min=13.0','-std=c++20','-O1','-fobjc-arc','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-Wno-unused-parameter','-Wno-missing-field-initializers',...sanitize,
  ...[native,dependencies,fixtures,path.join(jdk,'include'),path.join(jdk,'include/darwin')].map(p=>'-I'+p),'-DPRESENTATION_SOURCE='+JSON.stringify(presentation)];
 const library=path.join(output,'libshared-mock.dylib');run('xcrun',['clang++','-std=c++20','-dynamiclib',...sanitize,'-I'+dependencies,path.join(fixtures,'shared-mock.cpp'),'-o',library]);
 run('xcrun',['clang++',...flags,path.join(output,'control.mm'),path.join(dependencies,'pixel-copy.mm'),...['Foundation','Metal','QuartzCore','IOSurface'].flatMap(name=>['-framework',name]),'-o',path.join(output,'control')]);
 const result=run(path.join(output,'control'),[library]);assert.match(result,/PASS .* actual C\/EGL error-boundary checks/);t.diagnostic(result.trim());
});
