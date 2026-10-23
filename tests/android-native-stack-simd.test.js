const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('shared hardware veneers preserve dynamic SP arithmetic and SIMD post-index',async t=>{
 const klepton=process.env.KLEPTON_SOURCE||path.resolve('src/external/klepton');
 if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))return t.skip('Requires Apple Silicon and original Klepton source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-stack-simd-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {prepareX18Source,prepareX18Core}=await import('../src/modules/android/native/x18-source.mjs');
 const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 for(const [name,prepare,define]of[['jvm',prepareX18Source,'KL_X18_SOURCE'],['art',prepareX18Core,'KL_X18_CORE_SOURCE']]) {
  const output=path.join(root,name);fs.mkdirSync(output);const source=prepare(klepton,output),binary=path.join(output,'probe');
  const args=['-O1','-g','-fsanitize=address,undefined','-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+output,'-I'+path.join(klepton,'runtime'),'-D'+define+'='+JSON.stringify(source),'tests/fixtures/android-native/x18-stack-simd.c'];
  if(name==='jvm')args.push(path.join(klepton,'runtime/kl_env.c'));
  run('clang',[...args,'-o',binary]);const outputText=run(binary,[]);
  assert.match(outputText,/PASS 16 SIMD and 24 ALU stack veneers preserve memory, vectors, SP, scratch and NZCV; reserved tagged fields preserved/);
  assert.match(outputText,/PASS four STGP publications retain the original tag-store opcode and 16-byte scaled addressing/);
 }
});

test('original Bionic publication completes dynamic SP veneers through the ART signal owner',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-stack-simd-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(program,args,env=process.env)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 run(compiler,['--target=aarch64-linux-android35','-O2','-Wall','-Wextra','-Werror','-DANDROID_STACK_COMPONENT=1','tests/fixtures/android-native/x18-stack-simd.c','-o',path.join(root,'probe')]);
 const {componentSupplier}=require('./helpers/android-art-supplier');
 const supplier=componentSupplier(path.resolve(payload)),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'stack',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 const result=run(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe'],env);
 assert.match(result.stdout,/PASS delivered publication and original signal owner execute 16 SIMD and 24 ALU stack veneers/);
 assert.match(result.stdout,/PASS four STGP publications retain the original tag-store opcode and 16-byte scaled addressing/);
});

test('delivered JVM mapping imports complete dynamic SP veneers through the original signal mux',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)return t.skip('Requires Apple Silicon and rebuilt native JVM runtime');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-jvm-stack-simd-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'probe'),identities=path.join(root,'identities');fs.mkdirSync(identities,{mode:0o700});
 const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:15000,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 run('clang',['-O2','-Wall','-Wextra','-Werror','-DJVM_STACK_COMPONENT=1','tests/fixtures/android-native/x18-stack-simd.c','-o',binary]);
 const library=process.env.KLEPTON_NATIVE_CORE||path.resolve(runtime,'native/libklepton-jvm.dylib');
 const result=run(binary,[path.resolve(library),identities]);
 assert.match(result.stdout,/PASS delivered publication and original signal owner execute 16 SIMD and 24 ALU stack veneers/);
 assert.match(result.stdout,/PASS four STGP publications retain the original tag-store opcode and 16-byte scaled addressing/);
});

test('live JVM direct ELF loading installs the native signal mux before SIMD SP execution',{timeout:30000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,core=process.env.KLEPTON_NATIVE_CORE,java=process.env.JAVA_HOME,clang=process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,core,java,clang].every(Boolean))return t.skip('Requires Apple Silicon runtime, changed core, Android Clang and Java21');
 const parent=process.env.ANDROID_STACK_OUTPUT,root=fs.mkdtempSync(path.join(parent?path.resolve(parent):os.tmpdir(),'android-live-stack-simd-'));
 if(!parent)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(file,args,env)=>{const r=require('./helpers/android-java').spawnSync(file,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20,env});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const fixture=path.resolve('tests/fixtures/android-native'),guest=path.join(root,'libstack-simd.so'),classpath=[path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 run(clang,['--target=aarch64-linux-android35','-O2','-shared','-fPIC','-nostdlib','-fno-stack-protector','-Wall','-Wextra','-Werror',path.join(fixture,'x18-stack-elf.c'),path.join(fixture,'x18-stack-elf.S'),'-o',guest]);
 run(path.join(java,'bin/javac'),['--release','21','-cp',classpath,'-d',root,path.join(fixture,'StackSimdProbe.java')]);
 const directory=path.join(root,'native');fs.mkdirSync(directory);fs.symlinkSync(path.resolve(core),path.join(directory,'libklepton-jvm.dylib'));
 fs.copyFileSync(path.resolve(runtime,'native/libnativebinding.dylib'),path.join(directory,'libnativebinding.dylib'),fs.constants.COPYFILE_FICLONE);
 const env={...process.env,...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:path.resolve(runtime,'native')};
 const result=run(path.join(java,'bin/java'),['-Xcheck:jni','-Xverify:all','-cp',root+path.delimiter+classpath,'StackSimdProbe',path.join(directory,'libklepton-jvm.dylib'),path.join(directory,'libnativebinding.dylib'),guest],env);
 fs.writeFileSync(path.join(root,'result.log'),result.stdout+result.stderr);
 assert.match(result.stdout,/PASS live JVM original ELF SIMD\/SP veneers preserve scratch, flags and the native signal owner/);
 assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);
});
