const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
test('Android allocator introspection reports the shared native heap',async t=>{
  const include=process.env.ANDROID_NDK_HEADERS;
  if(process.platform!=='darwin'||!include)return t.skip('Requires macOS and original Android NDK headers');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-allocator-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'../src/modules/android/native');
  const {prepareAllocator}=await import(pathToFileURL(path.join(root,'allocator/build.mjs')).href);
  const allocator=prepareAllocator({include,output});
  const executable=path.join(output,'probe');
  execFileSync('clang',['-std=c11','-O1','-fno-builtin-malloc','-fno-builtin-free','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0','-I'+output,allocator.source,path.join(__dirname,'fixtures/android-native/allocator-statistics.c'),'-o',executable]);
  assert.match(execFileSync(executable,[],{encoding:'utf8'}),/PASS original Android allocator record/);
});
