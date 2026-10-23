const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{spawnSync}=require('node:child_process');
test('Complete original Bionic mutex attribute family feeds the shared native mutex owner',async t=>{
 const root=path.resolve(__dirname,'..'),source=path.join(root,'src/modules/android/native'),klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton'),bionicSource=process.env.BIONIC_SOURCE||path.join(root,'src/external/aosp-bionic'),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||!runtime||!fs.existsSync(klepton)||!fs.existsSync(bionicSource))return t.skip('Requires macOS runtime and pinned Bionic/Klepton');
 const build=fs.mkdtempSync(path.join(os.tmpdir(),'android-mutexattr-'));t.after(()=>fs.rmSync(build,{recursive:true,force:true}));
 const pthreadSource=path.join(build,'pthread-source.c'),shimSource=path.join(build,'shim.c');fs.copyFileSync(path.join(klepton,'runtime/libc/kl_pthread.c'),pthreadSource);fs.copyFileSync(path.join(klepton,'runtime/libc/kl_shim.c'),shimSource);
 const{preparePthreadAttributes}=await import(require('node:url').pathToFileURL(path.join(source,'pthread-attributes/build.mjs')));const prepared=preparePthreadAttributes({bionicSource,build,pthreadSource,shimSource});assert.equal(prepared.functions.filter(name=>name.startsWith('pthread_mutexattr_')).length,8);
 const native=path.resolve(runtime,'native'),binary=path.join(build,'probe');for(const[command,args]of[['clang',['-std=c11','-O2','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/android-native/mutex-attributes.c'),prepared.object,'-L'+native,'-lklepton-jvm','-Wl,-rpath,'+native,'-o',binary]],[binary,[]]]){const r=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);}
});
