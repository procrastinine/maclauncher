const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Original Android wide printf retains guest arguments and borrowed stream ownership',async t=>{
 const root=path.resolve(__dirname,'..'),source=path.join(root,'src/modules/android/native'),klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton'),bionicSource=process.env.BIONIC_SOURCE||path.join(root,'src/external/aosp-bionic'),compilerRtSource=process.env.COMPILER_RT_SOURCE||path.join(root,'src/external/aosp-compiler-rt'),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!fs.existsSync(bionicSource)||!fs.existsSync(compilerRtSource)||!fs.existsSync(klepton))return t.skip('Requires Apple Silicon runtime and original Bionic, compiler-rt and Klepton sources');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-wide-stdio-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const shim=path.join(tmp,'shim.c'),libcSource=path.join(tmp,'libc.c'),table=path.join(tmp,'table.h');
 for(const [file,input] of [[shim,'kl_shim.c'],[libcSource,'kl_libc.c'],[table,'kl_libc_table.h']])fs.copyFileSync(path.join(klepton,'runtime/libc',input),file);
 const {prepareWideStdio}=await import(require('node:url').pathToFileURL(path.join(source,'wide-stdio/build.mjs'))),prepared=prepareWideStdio({bionicSource,compilerRtSource,klepton,build:tmp,shim,libcSource,table});
 assert.doesNotMatch(fs.readFileSync(shim,'utf8'),/klb_swprintf/);assert.doesNotMatch(fs.readFileSync(libcSource,'utf8'),/klb_swprintf/);assert.doesNotMatch(fs.readFileSync(table,'utf8'),/KL_FWD\(\w*wprintf\)/);
 const native=path.resolve(runtime,'native'),binary=path.join(tmp,'probe');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 run('clang',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-I'+path.join(klepton,'runtime/libc'),path.join(__dirname,'fixtures/android-native/wide-stdio.c'),...prepared.objects,'-L'+native,'-lklepton-jvm','-Wl,-rpath,'+native,'-o',binary]);
 assert.match(run(binary,[]),/PASS original Android wide printf/);
});
