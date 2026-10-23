const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
test('Bionic ANGLE blob callbacks retain validated context ownership and original query values',async t=>{
 const ast=process.env.ANDROID_HOST_AST,jdk=process.env.ANDROID_JDK||process.env.JAVA_HOME,angle=process.env.ANDROID_ANGLE_SOURCE;
 if(process.platform!=='darwin'||!ast||!jdk||!angle)return t.skip('Requires macOS, original Clang AST, JDK and ANGLE sources');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),bionic=path.join(native,'bionic'),out=fs.mkdtempSync(path.join(os.tmpdir(),'android-blob-callback-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 function run(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stderr);return r.stdout;}
 function original(file){const p=path.join(angle,file);return fs.existsSync(p)?fs.readFileSync(p,'utf8'):run('git',['-C',angle,'show','HEAD:'+file]);}
 function extract(text,start){const a=text.indexOf(start);assert.ok(a>=0);let i=text.indexOf('{',a)+1,depth=1;for(;depth;++i){if(text[i]==='{')++depth;if(text[i]==='}')--depth;}return text.slice(a,i);}
 const{adaptAngleBlobCallbackOwner}=await import(pathToFileURL(path.join(native,'angle-blob-source.mjs'))),context=adaptAngleBlobCallbackOwner(original('src/libANGLE/Context.cpp'));
 let fixture=fs.readFileSync(path.join(__dirname,'fixtures/android-native/bionic-blob-callback/control.cpp.in'),'utf8');
 fixture=fixture.replace('/* ANGLE_OWNER */',context.slice(context.indexOf('\nnamespace klj_angle_blob_owner {'),context.indexOf('\nnamespace gl\n{'))).replace('/* ANGLE_DESTRUCTOR */',extract(context,'Context::~Context()')).replace('/* ANGLE_SETTER */',extract(context,'void Context::blobCacheCallbacks(')).replace('/* ANGLE_EXPORT */',context.slice(context.lastIndexOf('\nextern "C" __attribute__'))).replace('/* ANGLE_VALIDATION */',extract(original('src/libANGLE/validationES2.cpp'),'bool ValidateBlobCacheCallbacksANGLE(').replace('const Context *context','const gl::Context *context'));
 fs.writeFileSync(path.join(out,'control.cpp'),fixture);run(process.execPath,[path.join(bionic,'egl/generate.mjs'),ast,out]);
 const declarations=JSON.parse(fs.readFileSync(path.join(out,'declarations.json'))),snapshot=JSON.parse(fs.readFileSync(path.join(bionic,'egl/angle-declarations.json')));
 for(const name of Object.keys(snapshot.functions))assert.ok(declarations.functions.some(f=>f.name===name),'Original ANGLE declaration missing: '+name);
 fs.writeFileSync(path.join(out,'indices.h'),'#define EGL_FUNCTION_COUNT '+declarations.functions.length+'\n'+declarations.functions.map((f,i)=>'#define IDX_'+f.name+' '+(i+1)).join('\n')+'\n');
 const flags=['-O1','-Wno-nullability-completeness',...[out,native,bionic,path.join(bionic,'egl'),path.join(bionic,'ndk'),path.join(bionic,'egl/include'),path.join(bionic,'ndk/include'),path.join(jdk,'include'),path.join(jdk,'include/darwin')].map(p=>'-I'+p)];
 run('xcrun',['clang',...flags,'-c',path.join(out,'egl-host-generated.c'),'-o',path.join(out,'egl.o')]);run('xcrun',['clang++','-std=c++20',...flags,path.join(out,'control.cpp'),path.join(out,'egl.o'),'-o',path.join(out,'control')]);assert.match(run(path.join(out,'control'),[]),/PASS original validated blob callbacks:/);
});
