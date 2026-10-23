const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Guest directories retain per-stream results and share real/OBB seek ownership',async t=>{
 const root=path.resolve(__dirname,'..'),source=path.join(root,'src/modules/android/native'),klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton'),java=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!java||!fs.existsSync(path.join(klepton,'runtime/guest/kl_obbmap.c')))return t.skip('Requires macOS, Java headers and pinned Klepton');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-directory-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const {prepareObbSource,prepareDirectoryCallers}=await import(require('node:url').pathToFileURL(path.join(source,'obb-source.mjs')));
 const obb=prepareObbSource(klepton,tmp),libc=path.join(tmp,'libc.c');fs.copyFileSync(path.join(klepton,'runtime/libc/kl_libc.c'),libc);prepareDirectoryCallers(libc);
 const adapted=fs.readFileSync(libc,'utf8'),start=adapted.indexOf('// ---------- struct dirent ----------'),end=adapted.indexOf('// ---------- sigaction ----------',start);
 assert.ok(start>=0&&end>start);fs.writeFileSync(path.join(tmp,'directory-callers.c'),adapted.slice(start,end));
 const binary=path.join(tmp,'probe'),run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);};
 run('clang',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-Wno-unused-function','-Wno-unused-variable','-Wno-unused-parameter','-I'+source,'-I'+tmp,'-I'+path.join(java,'include'),'-I'+path.join(java,'include/darwin'),'-I'+path.join(klepton,'runtime'),'-I'+path.join(klepton,'runtime/guest'),path.join(__dirname,'fixtures/android-native/directory-abi.c'),...['directory-bridge.c','guest-paths.c'].map(file=>path.join(source,file)),path.join(klepton,'runtime/kl_env.c'),obb,'-lz','-o',binary]);
 run(binary,[path.join(tmp,'data')]);
});
