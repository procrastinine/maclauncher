const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');

test('Klepton source discovery retains image, loader and device additions and excludes standalone Java drivers',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-source-owners-'));
  try{
    // New upstream binding and device units deliberately need no source-list
    // edits. The selected JVM or ART owns Java; standalone bootstrap drivers are
    // excluded while the image and dynamic-loader units stay with the native build.
    fs.writeFileSync(path.join(root,'Makefile'),[
      'RUNTIME_JNI := runtime/kl_jni.c runtime/jni/new_binding.c',
      'RUNTIME_SHIP := $(RUNTIME_JNI) runtime/kl_image.c runtime/kl_dl.c runtime/guest/kl_driver.c runtime/guest/kl_mono.c runtime/kl_target.c runtime/gfx/new_device.c runtime/xr/kl_openxr.c runtime/guest/kl_ndk.c',
      ''
    ].join('\n'));
    const actual=execFileSync('make',['-s','-f',path.resolve(__dirname,'../src/modules/android/native/source-list.mk'),'maclauncher-source-list'],{cwd:root,encoding:'utf8'}).trim().split('\n');
    assert.deepEqual(actual,['runtime/kl_image.c','runtime/kl_dl.c','runtime/gfx/new_device.c','runtime/xr/kl_openxr.c','runtime/guest/kl_ndk.c']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
