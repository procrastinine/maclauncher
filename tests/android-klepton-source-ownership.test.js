const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');

test('Klepton source discovery retains device additions and excludes the complete synthetic JVM family',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-source-owners-'));
  try{
    // New upstream binding and device units deliberately need no source-list
    // edits. Framework ownership follows the upstream family declaration.
    fs.writeFileSync(path.join(root,'Makefile'),[
      'RUNTIME_JNI := runtime/kl_jni.c runtime/jni/new_binding.c',
      'RUNTIME_SHIP := $(RUNTIME_JNI) runtime/kl_image.c runtime/kl_dl.c runtime/guest/kl_driver.c runtime/gfx/new_device.c runtime/xr/kl_openxr.c runtime/guest/kl_ndk.c',
      ''
    ].join('\n'));
    const actual=execFileSync('make',['-s','-f',path.resolve(__dirname,'../src/modules/android/native/source-list.mk'),'maclauncher-source-list'],{cwd:root,encoding:'utf8'}).trim().split('\n');
    assert.deepEqual(actual,['runtime/gfx/new_device.c','runtime/xr/kl_openxr.c','runtime/guest/kl_ndk.c']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
