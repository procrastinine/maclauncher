const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');const {pathToFileURL}=require('node:url');

test('Bionic GL debug callbacks retain original context lifetime and Skia interface contracts',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the macOS native compiler and JNI');
 const ast=process.env.ANDROID_HOST_AST,jdk=process.env.ANDROID_JDK||process.env.JAVA_HOME,angle=process.env.ANDROID_ANGLE_SOURCE,skia=process.env.ANDROID_SKIA_SOURCE;
 if(!ast||!jdk||!angle||!skia)return t.skip('Requires the original Clang AST, JDK, ANGLE and Skia sources');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),bionic=path.join(native,'bionic');
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'android-debug-callback-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 function run(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stderr);return r.stdout;}
 function original(root,file){const p=path.join(root,file);return fs.existsSync(p)?fs.readFileSync(p,'utf8'):run('git',['-C',root,'show','HEAD:'+file]);}
 const {adaptAngleDebugCallbackOwner}=await import(pathToFileURL(path.join(native,'angle-debug-source.mjs')));
 const debug=adaptAngleDebugCallbackOwner(original(angle,'src/libANGLE/Debug.cpp'));
 const owner=debug.slice(debug.indexOf('\nnamespace klj_angle_debug_owner {'),debug.indexOf('\nnamespace\n{'));
 const extract=start=>{const a=debug.indexOf(start);assert.ok(a>=0);return debug.slice(a,debug.indexOf('\n}',a)+2);};
 const validation=original(skia,'src/gpu/ganesh/gl/GrGLInterfaceAutogen.cpp');
 const begin=validation.lastIndexOf('\n    if ((',validation.indexOf('fExtensions.has("GL_KHR_debug")')),end=validation.indexOf('\n    if ((',begin+1);assert.ok(begin>=0&&end>begin);
 let source=fs.readFileSync(path.join(__dirname,'fixtures/android-native/bionic-debug-callback/control.cpp.in'),'utf8');
 source=source.replace('/* ANGLE_OWNER */',owner).replace('/* ANGLE_DESTRUCTOR */',debug.match(/Debug::~Debug\(\) \{[^\n]*\}/)[0]).replace('/* ANGLE_SETTER */',extract('void Debug::setCallback(')).replace('/* ANGLE_EXPORT */',debug.slice(debug.lastIndexOf('\nextern "C" __attribute__'))).replace('/* SKIA_DEBUG_VALIDATION */',validation.slice(begin,end));
 fs.writeFileSync(path.join(out,'control.cpp'),source);run(process.execPath,[path.join(bionic,'egl/generate.mjs'),ast,out]);
 const declarations=JSON.parse(fs.readFileSync(path.join(out,'declarations.json')));assert.ok(declarations.functions.length>=1192);
 fs.writeFileSync(path.join(out,'indices.h'),'#define EGL_FUNCTION_COUNT '+declarations.functions.length+'\n'+declarations.functions.map((f,i)=>`#define IDX_${f.name} ${i+1}`).join('\n')+'\n');
 const flags=['-O1','-Wno-nullability-completeness',...[out,native,bionic,path.join(bionic,'egl'),path.join(bionic,'ndk'),path.join(bionic,'egl/include'),path.join(bionic,'ndk/include'),path.join(jdk,'include'),path.join(jdk,'include/darwin')].map(p=>'-I'+p)];
 run('xcrun',['clang',...flags,'-c',path.join(out,'egl-host-generated.c'),'-o',path.join(out,'egl.o')]);
 run('xcrun',['clang++','-std=c++20',...flags,path.join(out,'control.cpp'),path.join(out,'egl.o'),'-o',path.join(out,'control')]);
 assert.match(run(path.join(out,'control'),[]),/PASS original Skia KHR-debug validation; callback arguments/);
});
