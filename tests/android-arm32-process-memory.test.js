const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('ARM32 process_vm vectors use original declarations and shared physical memory operations',t=>{
 const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||!build||!generated||!runtime)return t.skip('Requires ARM32 component, original declarations and native runtime');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-process-memory-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 require('./helpers/android-arm32-shapes').writeShapes(generated,root);
 const syscallFile=path.join(process.env.ANDROID_ARM32_SYSCALLS||path.join(generated,'../syscalls'),'syscalls.inc'),rows=fs.readFileSync(syscallFile,'utf8');
 const number=rows.match(/\{(\d+),"process_vm_readv"/);assert.ok(number);fs.writeFileSync(path.join(root,'process-memory-syscalls.h'),'namespace syscalls {constexpr unsigned read='+number[1]+';}\n');
 const native=path.resolve('src/modules/android/native'),run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:10000,env:{...process.env,DYLD_LIBRARY_PATH:[path.resolve(build),path.resolve(runtime,'native')].join(path.delimiter)}});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const object=path.join(root,'memory.o');run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-std=c11','-Wall','-Wextra','-Werror','-I'+native,'-c',native+'/process-memory.c','-o',object]);
 const binary=path.join(root,'probe');run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native+'/arm32','-I'+root,path.resolve('tests/fixtures/android-arm32/process-memory-probe.cpp'),object,path.resolve(build,'libandroid-arm32.dylib'),path.resolve(runtime,'native/libklepton-jvm.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
 const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),ids]),/PASS original ARM32 process_vm iovec projections/);
});
