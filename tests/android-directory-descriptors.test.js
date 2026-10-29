const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Raw directory cursors follow the physical file description across dup, fork and explicit metadata transfer',async t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Darwin ARM64 descriptor supplier');
 const checkout=process.env.EPOLL_SHIM_SOURCE||path.resolve(__dirname,'../src/external/epoll-shim');
 if(!fs.existsSync(path.join(checkout,'CMakeLists.txt')))return t.skip('Requires pinned descriptor supplier');
 if(!process.env.ANDROID_DESCRIPTOR_BUILD&&spawnSync(process.env.NINJA||'ninja',['--version'],{stdio:'ignore'}).status!==0)return t.skip('Requires Ninja to build the pinned descriptor supplier');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-directory-description-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const {buildPollableDescriptors}=await import('../src/modules/android/native/pollable-fds/build.mjs');
 const built=buildPollableDescriptors({checkout,output:process.env.ANDROID_DESCRIPTOR_BUILD||path.join(tmp,'supplier')});
 const binary=path.join(tmp,'probe'),native=path.resolve(__dirname,'../src/modules/android/native');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('clang',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-I'+native,'-I'+built.include,path.join(__dirname,'fixtures/android-native/directory-descriptors.c'),built.object,built.archive,'-o',binary]);
 assert.match(run(binary,[path.join(tmp,'files')]),/PASS original descriptor owner/);
});
