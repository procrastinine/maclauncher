const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('direct JVM interposition preserves original dyld scopes, errors and other interposed owners',t=>{
 const jdk=process.env.ANDROID_JDK,product=process.env.ANDROID_JVM_PROCESS_PRODUCT;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!jdk||!product)return t.skip('Requires the selected JDK and compiled process adapter');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'jvm-dyld-scope-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const src=path.resolve('tests/fixtures/android-jvm-process'),vm=fs.realpathSync(path.join(jdk,'lib/server/libjvm.dylib')),flags=['-arch','arm64','-mmacosx-version-min=13.0','-O2','-Wall','-Wextra','-Werror'];
 const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$)/.test(key))delete env[key];
 const run=(file,args,preload)=>{const r=spawnSync(file,args,{env:{...env,...(preload?{DYLD_INSERT_LIBRARIES:preload}:{})},encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stderr);return r.stdout;};
 const build=(name,source,extra=[])=>{const file=path.join(root,name);run('clang',[...flags,...extra,path.join(src,source),'-o',file]);return file;};
 const provider=build('provider.dylib','dyld-provider.c',['-dynamiclib','-Wl,-install_name,@loader_path/provider.dylib']);
 const caller=build('caller.dylib','dyld-caller.c',['-dynamiclib',provider]);const probe=build('probe','dyld-scope.c',['-Wl,-export_dynamic']);
 const stock=JSON.parse(run(probe,[caller,provider])),preloads=vm+path.delimiter+path.resolve(product),adapted=JSON.parse(run(probe,[caller,provider],preloads));
 assert.equal(stock.self,101);assert.equal(stock.next,201);assert.equal(stock.dependency,202);assert.deepEqual(adapted,stock);
 const interpose=build('guard.dylib','dyld-interpose.c',['-dynamiclib',provider]);const guarded=JSON.parse(run(probe,[caller,provider],preloads+path.delimiter+interpose));
 assert.equal(guarded.self,101);for(const name of ['next','explicit','success'])assert.equal(guarded[name],909);for(const name of ['jniSelf','jniNext','jniExplicit'])assert.equal(guarded[name],-19);
 const vmCaller=build('vm-caller.dylib','dyld-vm-caller.c',['-dynamiclib','-I'+jdk+'/include','-I'+jdk+'/include/darwin',vm,'-Wl,-rpath,'+path.dirname(vm)]),vmProbe=build('vm-probe','dyld-vm-scope.c');
 const invocation=JSON.parse(run(vmProbe,[vmCaller,vm],preloads));for(const key of ['selfSame','nextSame','directSame','otherApiSelf','otherApiNext'])assert.equal(invocation[key],1,key);assert.equal(fs.realpathSync(invocation.owner),fs.realpathSync(product));
 t.diagnostic('PASS original SELF/NEXT/dependency/DEFAULT/MAIN_ONLY/explicit/data/RTLD_FIRST/dlerror; real JVM direct+dynamic binding and other interposition retained');
});
