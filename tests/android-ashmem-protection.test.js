const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('Native ashmem preserves every original protection mask and mapping authority',t=>{
 const {ANDROID_ASHMEM_BINDER:binder,ANDROID_ASHMEM_CORE:core}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!binder||!core)return t.skip('Requires matched native Binder and descriptor components');
 const retain=process.env.ANDROID_ART_TEST_OUTPUT;if(retain)fs.mkdirSync(retain,{recursive:true});const root=fs.mkdtempSync(path.join(retain?path.resolve(retain):os.tmpdir(),'android-ashmem-protection-'));if(!retain)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native=path.join(root,'native');fs.mkdirSync(native);for(const [input,name]of[[binder,'libandroid-binder-rpc.dylib'],[core,'libklepton-jvm.dylib']])fs.copyFileSync(input,path.join(native,name),fs.constants.COPYFILE_FICLONE);
 const binary=path.join(root,'probe'),run=(cmd,args,env=process.env)=>{const r=spawnSync(cmd,args,{env,encoding:'utf8',timeout:15000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-O2',path.resolve('tests/fixtures/android-platform-settings/ashmem-protection.cpp'),'-o',binary]);
 const output=run(binary,[path.join(native,'libandroid-binder-rpc.dylib')],{...process.env,TMPDIR:root,DYLD_LIBRARY_PATH:native});assert.match(output,/PASS all eight native ashmem protection masks/);
});
