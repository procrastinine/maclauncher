const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Bionic native windows retain the host owner across the complete original public family',t=>{
 if(process.platform!=='darwin')return t.skip('Requires the macOS native compiler and JNI');
 const ast=process.env.ANDROID_HOST_AST,jdk=process.env.ANDROID_JDK||process.env.JAVA_HOME;
 if(!ast||!jdk)return t.skip('Requires the original Clang host AST and managed JDK');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),bionic=path.join(native,'bionic');
 const fixture=path.join(__dirname,'fixtures/android-native/bionic-native-window'),out=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-window-'));
 t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 function run(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stderr);return r;}
 run(process.execPath,[path.join(bionic,'graphics/generate.mjs'),ast,out]);
 const declarations=JSON.parse(fs.readFileSync(path.join(out,'declarations.json')));
 assert.equal(declarations.functions.length,42);assert.equal(declarations.functions.filter(f=>f.name.startsWith('ANativeWindow_')).length,20);
 fs.writeFileSync(path.join(out,'indices.h'),declarations.functions.map((f,i)=>`#define IDX_${f.name} ${i}`).join('\n')+'\n');
 const include=[out,path.join(bionic,'graphics'),path.join(bionic,'ndk'),bionic,path.join(bionic,'ndk/include'),path.join(bionic,'graphics/include'),path.join(bionic,'graphics/host-include'),path.join(jdk,'include'),path.join(jdk,'include/darwin')].map(p=>'-I'+p);
 const flags=['-O1','-Wno-nullability-completeness',...include];
 run('xcrun',['clang',...flags,'-c',path.join(out,'graphics-host-generated.c'),'-o',path.join(out,'graphics.o')]);
 run('xcrun',['clang++','-dynamiclib','-std=c++20',...flags,'-I'+native,path.join(fixture,'window.mm'),path.join(out,'graphics.o'),'-undefined','dynamic_lookup','-framework','Foundation','-framework','IOSurface','-framework','QuartzCore','-o',path.join(out,'window.dylib')]);
 fs.mkdirSync(path.join(out,'classes'));
 run(path.join(jdk,'bin/javac'),['-d',path.join(out,'classes'),...['android/view/Surface.java','maclauncher/android/framework/HostSurface.java','NativeWindowControl.java'].map(p=>path.join(fixture,'java',p))]);
 const result=run(path.join(jdk,'bin/java'),['-Xcheck:jni','-Xmx64m','-XX:+UseSerialGC','-cp',path.join(out,'classes'),'NativeWindowControl',path.join(out,'window.dylib')]);
 assert.match(result.stdout,/PASS original native-window owner and generated 20-API carrier/);assert.equal(result.stderr,'');
});
