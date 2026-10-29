const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
test('BPF maps share the existing descriptor owner across processes',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Darwin ARM64');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-bpf-descriptors-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let output=process.env.ANDROID_BPF_DESCRIPTOR_BUILD;
  if(!output){
    const checkout=process.env.EPOLL_SHIM_SOURCE||path.resolve(__dirname,'../src/external/epoll-shim');
    if(!fs.existsSync(path.join(checkout,'CMakeLists.txt')))return t.skip('Requires pinned descriptor supplier');
    if(spawnSync(process.env.NINJA||'ninja',['--version'],{stdio:'ignore'}).status!==0)return t.skip('Requires Ninja to build the pinned descriptor supplier');
    const {buildPollableDescriptors}=await import('../src/modules/android/native/pollable-fds/build.mjs');
    output=path.join(directory,'supplier');buildPollableDescriptors({checkout,output});
  }
  const native=path.resolve(__dirname,'../src/modules/android/native'),binary=path.join(directory,'probe');
  execFileSync('clang',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-I'+native,
    path.join(__dirname,'fixtures/android-native/bpf-descriptors.c'),path.join(output,'bridge.o'),path.join(output,'build/src/libepoll-shim.a'),'-o',binary],{stdio:'pipe',timeout:15000});
  assert.match(execFileSync(binary,[],{encoding:'utf8',timeout:15000}),/PASS BPF map descriptor lifetime/);
});
