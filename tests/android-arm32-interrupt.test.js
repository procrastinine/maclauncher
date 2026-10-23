const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {linkBinary}=require('./helpers/android-arm32-binary');
test('ARM32 interrupts stop original Thread execution and preserve edited return registers',t=>{
 const build=process.env.ANDROID_ARM32_BUILD,linker=process.env.ANDROID_ARM32_ELF_LINKER,jdk=process.env.ANDROID_JAVA_HOME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!linker||!jdk)return t.skip('Requires Apple Silicon, ARM32 component, JDK and LLVM linker');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-interrupt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fixture=path.join(__dirname,'fixtures/android-arm32');
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang',['--target=armv7a-linux-androideabi21','-c',fixture+'/interrupt.S','-o',root+'/interrupt.o']);
 linkBinary(run,linker,[root+'/interrupt.o'],['interrupted','resumed','nested','faulting','undefined','breakpoint','signal_handler'],['ready'],root+'/interrupt.bin');
 run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native/arm32'),'-I'+root,'-I'+jdk+'/include','-I'+jdk+'/include/darwin',fixture+'/interrupt.cpp',path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-L'+jdk+'/lib/server','-ljvm','-Wl,-rpath,'+jdk+'/lib/server','-o',root+'/probe']);
 const result=run(root+'/probe',[root+'/interrupt.bin']);
 assert.match(result,/PASS translated interrupt, nested execution and GPR\/CPSR\/FP return state/);
 assert.match(result,/PASS stopped memory protection, missing mapping, undefined instruction and breakpoint recovery/);
 assert.match(result,/PASS original ARM32 signal frame, alternate stack and handler writeback/);
});
test('ARM32 signal frames match complete original Bionic UAPI records',t=>{
 const source=process.env.ANDROID_SOURCE_ROOT;if(!source)return t.skip('Requires original Bionic headers');
 const args=['--target=armv7a-linux-androideabi10000','-std=c11','-Wall','-Wextra','-Werror','-fsyntax-only','-I'+path.resolve('src/modules/android/native/arm32')];
 for(const file of ['bionic/libc/include','bionic/libc/kernel/uapi','bionic/libc/kernel/android/uapi','bionic/libc/kernel/uapi/asm-arm'])args.push('-isystem',path.join(source,file));
 args.push(path.join(__dirname,'fixtures/android-arm32/signal-layout.c'));
 const r=spawnSync('clang',args,{encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
});
