const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('Native ashmem passes original Bionic and ART MemoryIntArray descriptor contracts',async t=>{
 const {ANDROID_ART_PAYLOAD:runtime,ANDROID_ART_GUEST_INPUTS:guestInputs,JAVA_HOME:jdk,ANDROID_R8:r8,ANDROID_ASHMEM_BINDER:binder,ANDROID_ASHMEM_CORE:core,ANDROID_ASHMEM_LINUX_RUN:linuxRun,ANDROID_ASHMEM_GUEST_BINDER:guestBinder}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,guestInputs,jdk,r8,binder,core].every(Boolean))return t.skip('Requires matched native and Android component inputs');
 const retained=process.env.ANDROID_ART_TEST_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const output=fs.mkdtempSync(path.join(retained?path.resolve(retained):os.tmpdir(),'android-ashmem-interop-'));
 if(!retained)t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const {probeAshmemInterop}=await import('./helpers/android-ashmem-interop.mjs');
 const result=await probeAshmemInterop({output,runtime,guestInputs,jdk,r8,binder,core,linuxRun,guestBinder});
 assert.match(result,/PASS exact descriptor capability preserves neighboring file isolation/);
 assert.match(result,/ORIGINAL_BIONIC_ASHMEM_GET_SIZE result=16384 errno=0 valid=1/);
 assert.match(result,/PASS original Bionic ashmem ioctls and read-only mapping\/write enforcement/);
 assert.match(result,/PASS original ART MemoryIntArray CREATOR, shared atomic generation, read-only descriptor and owner-close lifetime/);
 assert.match(fs.readFileSync(path.join(output,'owner.log'),'utf8'),/PASS unsealed native regions retire through the original descriptor close owner/);
});
test('Imported ashmem authority follows original descriptor dup, fork and exec',async t=>{
 const {ANDROID_ART_PAYLOAD:runtime,ANDROID_ART_GUEST_INPUTS:guestInputs,JAVA_HOME:jdk,ANDROID_R8:r8,ANDROID_ASHMEM_BINDER:binder,ANDROID_ASHMEM_CORE:core,ANDROID_ASHMEM_LINUX_RUN:linuxRun,ANDROID_ASHMEM_GUEST_BINDER:guestBinder}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,guestInputs,jdk,r8,binder,core,linuxRun].every(Boolean))return t.skip('Requires matched native and Android component inputs');
 const retained=process.env.ANDROID_ART_TEST_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const output=fs.mkdtempSync(path.join(retained?path.resolve(retained):os.tmpdir(),'android-ashmem-lifecycle-'));
 if(!retained)t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const {probeAshmemInterop}=await import('./helpers/android-ashmem-interop.mjs');
 const result=await probeAshmemInterop({output,runtime,guestInputs,jdk,r8,binder,core,linuxRun,guestBinder,lifecycle:true});
 assert.match(result,/PASS imported exact-file authority survives original fork and exec/);
 assert.match(result,/PASS imported authority dup, owner close, child retirement and neighboring file isolation/);
});
