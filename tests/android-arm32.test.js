const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {linkBinary}=require('./helpers/android-arm32-binary');

test('ARM32 original character data includes the complete private-header table family',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(!runtime)return t.skip('Requires the Android native runtime');
  const notices=path.resolve(runtime,'notices/arm32'),header=fs.readFileSync(path.join(notices,'bionic-ctype_private.h'),'utf8');
  const tables=[...header.matchAll(/extern const (char|short) (\w+)\[\];/g)].map(([,type,name])=>({type,name}));
  assert.ok(tables.length);const count=Number(header.match(/^#define CTYPE_NUM_CHARS\s+(\d+)/m)[1])+1;
  const definitions=fs.readFileSync(path.join(notices,'bionic-ctype_.c'),'utf8')+fs.readFileSync(path.join(notices,'bionic-ndk_cruft_data.cpp'),'utf8');
  const pointers=[...definitions.matchAll(/const (?:char|short)\s*\*\s*(\w+)\s*=\s*(\w+)\s*;/g)].map(([,name,table])=>({name,table}));
  const bytes=fs.readFileSync(path.resolve(runtime,'native/libandroid-arm32-builtins.so')),symbols=new Map();
  assert.equal(bytes.subarray(0,6).toString('hex'),'7f454c460101');
  const offset=bytes.readUInt32LE(32),stride=bytes.readUInt16LE(46),sections=bytes.readUInt16LE(48);
  for(let n=0;n<sections;n++){
    const section=offset+n*stride;if(![2,11].includes(bytes.readUInt32LE(section+4)))continue;
    const table=bytes.readUInt32LE(section+16),size=bytes.readUInt32LE(section+20),entry=bytes.readUInt32LE(section+36);
    const strings=bytes.readUInt32LE(offset+bytes.readUInt32LE(section+24)*stride+16);
    for(let p=table;p<table+size;p+=entry){const name=strings+bytes.readUInt32LE(p),end=bytes.indexOf(0,name);if(bytes.readUInt16LE(p+14))symbols.set(bytes.toString('utf8',name,end),{size:bytes.readUInt32LE(p+8),value:bytes.readUInt32LE(p+4),binding:bytes[p+12]>>4});}
  }
  for(const {type,name}of tables){
    const original=symbols.get(name)||symbols.get('_ZL'+name.length+name);
    assert.equal(original?.size,count*(type==='short'?2:1),'Complete original table '+name);
    const exports=pointers.filter(row=>row.table===name);assert.equal(exports.length,1,'Original pointer export for '+name);
    assert.equal(symbols.get(exports[0].name)?.size,4,'Guest-width original pointer '+exports[0].name);
    assert.equal(symbols.get(exports[0].name)?.binding,1,'Exported original pointer '+exports[0].name);
  }
});

test('ARM32 guest multi-buffer loops retain exact bounds and callback retirement',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,linker=process.env.ANDROID_ARM32_ELF_LINKER;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!linker)return t.skip('Requires Apple Silicon, the ARM32 component and ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-compact-loop-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixture=path.resolve(__dirname,'fixtures/android-arm32'),native=path.resolve(__dirname,'../src/modules/android/native/arm32');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang',['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-mfpu=neon','-fPIC','-ffreestanding','-fno-builtin','-O2','-c',fixture+'/compact-loop.c','-o',temporary+'/guest.o']);
  linkBinary(run,linker,[temporary+'/guest.o'],['compact_loop','compact_transition','compact_bounds','compact_many','compact_widths','compact_large'],['checkpoint'],temporary+'/guest.bin');
  const benchmark=process.env.ANDROID_ARM32_MEMORY_BENCHMARK==='1',results=[];
  for(const [label,directory]of [['current',build],...(process.env.ANDROID_ARM32_BASELINE_BUILD?[['baseline',process.env.ANDROID_ARM32_BASELINE_BUILD]]:[])]){
    const binary=path.join(temporary,label);
    run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+native,'-I'+fixture,'-I'+temporary,fixture+'/compact-loop-probe.cpp',path.resolve(directory,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(directory),'-o',binary]);
    const output=run(binary,[temporary+'/guest.bin',...(benchmark?['benchmark']:[])]);
    assert.match(output,/PASS actual ARM32 multi-buffer loop retains exact values, host-callback retirement and shortened bounds/);
    const rows=output.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    results.push({label,...rows.find(row=>row.iterations),multiBuffers:rows.filter(row=>row.compactBuffers)});
  }
  if(results.length===2){
    assert.equal(results[0].checksum,results[1].checksum);assert.equal(results[0].iterations,results[1].iterations);
    assert.deepEqual(results[0].multiBuffers.map(row=>[row.compactBuffers,row.rounds,row.checksum]),results[1].multiBuffers.map(row=>[row.compactBuffers,row.rounds,row.checksum]));
  }
  t.diagnostic(JSON.stringify(results));
});

test('ARM32 mappings preserve aliases, bounds and ownership through indexed lookup',t=>{
  const build=process.env.ANDROID_ARM32_BUILD;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build)return t.skip('Requires Apple Silicon and the ARM32 component');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-memory-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.join(root,'src/modules/android/native/arm32'),path.join(__dirname,'fixtures/android-arm32/memory-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',temporary+'/probe']);
  assert.match(run(temporary+'/probe',[]),/PASS indexed ARM32 mapping identity/);
  assert.match(run(temporary+'/probe',['compact']),/PASS compact borrowed buffers/);
  assert.match(run(temporary+'/probe',['fragmented']),/PASS fragmented borrowed ranges/);
  assert.match(run(temporary+'/probe',['concurrent']),/PASS concurrent original ARM32 readonly loads/);
  assert.match(run(temporary+'/probe',['budgets']),/PASS original ARM32 finite and unsigned instruction budgets/);
  if(process.env.ANDROID_ARM32_MEMORY_BENCHMARK==='1')t.diagnostic(run(temporary+'/probe',['benchmark']).trim());
});

test('ARM32 physical callbacks precede translated thread and lease retirement',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,jdk=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!jdk)return t.skip('Requires Apple Silicon, the JNI-enabled ARM32 component and JDK');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-owners-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.join(root,'src/modules/android/native/arm32'),'-I'+jdk+'/include','-I'+jdk+'/include/darwin',path.join(__dirname,'fixtures/android-arm32/thread-owners-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-L'+jdk+'/lib/server','-ljvm','-Wl,-rpath,'+jdk+'/lib/server','-o',temporary+'/probe']);
  assert.match(run(temporary+'/probe',[]),/PASS physical callbacks retain original ARM32 threads/);
});

test('ARM32 execution preserves AAPCS32 state and native call gates',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,runtime=process.env.KLEPTON_NATIVE_RUNTIME,linker=process.env.ANDROID_ARM32_ELF_LINKER;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!runtime||!linker)return t.skip('Requires Apple Silicon, the ARM32 component, Android runtime and an ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..'),fixture=path.join(__dirname,'fixtures/android-arm32');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  run('clang',['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-mfpu=neon','-fPIC','-fno-builtin','-O2','-c',path.join(fixture,'guest.c'),'-o',path.join(temporary,'guest.o')]);
  run('clang',['--target=armv7a-linux-androideabi21','-c',path.join(fixture,'guest-arm.S'),'-o',path.join(temporary,'guest-arm.o')]);
  linkBinary(run,linker,[temporary+'/guest.o',temporary+'/guest-arm.o'],['aligned_arguments','shared_copy','shared_thread','svc_thread','read_tls','arm_add','neon_float','callback_host','word_record','split_record'],['memcpy','gettid','nested_call'],temporary+'/guest.bin');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+path.join(root,'src/modules/android/native/arm32'),'-I'+temporary,path.join(fixture,'probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',path.join(temporary,'probe')]);
  assert.match(run(path.join(temporary,'probe'),[path.join(temporary,'guest.bin'),path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS A32\/Thumb translation/);
});

test('ARM32 compiler records retain their alignment independently of word count',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,linker=process.env.ANDROID_ARM32_ELF_LINKER;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!linker)return t.skip('Requires Apple Silicon, the ARM32 component and an ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-align-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixture=path.join(__dirname,'fixtures/android-arm32'),native=path.resolve(__dirname,'../src/modules/android/native/arm32');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  run('clang',['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-ffunction-sections','-fno-builtin','-O2','-c',fixture+'/guest.c','-o',temporary+'/guest.o']);
  linkBinary(run,linker,[temporary+'/guest.o'],['word_record','split_record','aligned_arguments'],['memcpy','gettid','nested_call'],temporary+'/guest.bin');
  run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+native,'-I'+fixture,'-I'+temporary,fixture+'/alignment-probe.cpp',path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',temporary+'/probe']);
  const output=run(temporary+'/probe',[temporary+'/guest.bin']);
  assert.match(output,/PASS original compiler record and wide argument alignment/);
  assert.match(output,/PASS shared argument span: calls=20000 words=9/);
  t.diagnostic(output.split('\n').find(line=>line.includes('PASS shared argument span')));
});

test('ARM32 JNI uses the complete JVM table and real native callbacks',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,linker=process.env.ANDROID_ARM32_ELF_LINKER,jdk=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!linker||!jdk)return t.skip('Requires Apple Silicon, the JNI-enabled ARM32 component, JDK and an ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-jni-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..'),fixture=path.join(__dirname,'fixtures/android-arm32');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  // jni.h includes stdio.h without using its declarations. Keep this freestanding
  // guest fixture independent of a host stdio ABI; the original JNI header stays intact.
  fs.writeFileSync(path.join(temporary,'stdio.h'),'#pragma once\n');
  const includes=['-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin')];
  run('clang',['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-mfpu=neon','-fPIC','-ffreestanding','-fno-builtin','-O2','-I'+temporary,...includes,'-c',path.join(fixture,'jni-guest.c'),'-o',path.join(temporary,'guest.o')]);
  run(linker,['-flavor','gnu','-shared','-z','global','--hash-style=both','-o',path.join(temporary,'guest.so'),path.join(temporary,'guest.o')]);
  linkBinary(run,linker,[temporary+'/guest.o'],['JNI_OnLoad','guest_c_entry','guest_probe','guest_utf_region','guest_string','guest_native_thread'],['ANativeWindow_fromSurface','ANativeWindow_toSurface'],temporary+'/guest.bin');
  run(path.join(jdk,'bin/javac'),['-d',temporary,path.join(fixture,'Arm32JniFixture.java')]);
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+path.join(root,'src/modules/android/native/arm32'),'-I'+temporary,...includes,path.join(fixture,'jni-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-L'+path.join(jdk,'lib/server'),'-ljvm','-Wl,-rpath,'+path.join(jdk,'lib/server'),'-Wl,-rpath,'+path.resolve(build),'-o',path.join(temporary,'probe')]);
  assert.match(run(path.join(temporary,'probe'),[path.join(temporary,'guest.bin'),temporary]),/PASS original JNI table/);
  run(path.join(jdk,'bin/javac'),['-d',temporary,path.join(root,'src/modules/android/native/java/maclauncher/android/bridge/ElfNativeExports.java'),path.join(fixture,'MetadataProbe.java')]);
  assert.match(run(path.join(jdk,'bin/java'),['-cp',temporary,'maclauncher.android.bridge.MetadataProbe',path.join(temporary,'guest.so')]),/PASS original ARM32 ELF metadata/);
});

test('ARM32 NativeBinding uses the original Bionic process loader',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,linker=process.env.ANDROID_ARM32_ELF_LINKER,jdk=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!linker||!jdk)return t.skip('Requires the integrated ARM32 runtime and ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-loader-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});
  const fixture=path.join(__dirname,'fixtures/android-arm32');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000,env:{...process.env,KL_ANDROID_ID_DIRECTORY:ids}});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  fs.writeFileSync(path.join(temporary,'stdio.h'),'#pragma once\n');
  run('clang',['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-mfpu=neon','-fPIC','-ffreestanding','-O2','-I'+temporary,'-I'+jdk+'/include','-I'+jdk+'/include/darwin','-c',fixture+'/shared-loader.c','-o',temporary+'/guest.o']);
  run(linker,['-flavor','gnu','-shared','--hash-style=both','--pack-dyn-relocs=android','-o',temporary+'/libshared32.so',temporary+'/guest.o']);
  const cp=path.resolve(runtime,'android-host.jar');
  run(jdk+'/bin/javac',['-cp',cp,'-d',temporary,fixture+'/SharedLoaderProbe.java']);
  assert.match(run(jdk+'/bin/java',['-Xcheck:jni','-cp',temporary+path.delimiter+cp,'SharedLoaderProbe',path.resolve(runtime,'native/libklepton-jvm.dylib'),path.resolve(runtime,'native/libnativebinding.dylib'),temporary+'/libshared32.so']),/PASS ELF32 uses original NativeBinding/);
});
