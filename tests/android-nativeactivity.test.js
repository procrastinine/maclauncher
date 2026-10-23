const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'../src/modules/android/native');
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
test('NativeActivity keeps the complete original lifecycle and JNI object owner',t=>{
 const framework=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!framework)return t.skip('KLEPTON_AOSP_FRAMEWORK identifies the original framework archive');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-nativeactivity-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(file=>path.join(source,'tools',file.path)).join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',asm,'-d',output,path.join(source,'framework/NativeBindings.java'),path.join(__dirname,'fixtures/android-framework-policy/NativeActivityOwnerProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-cp',output+path.delimiter+asm,'NativeActivityOwnerProbe',framework]),/PASS original NativeActivity bytes and \d+ JNI declarations preserved/);
});
test('Retained native graphics helpers consume the real EGL device and have no NDK handle owner',async t=>{
 const klepton=process.env.ANDROID_KLEPTON_SOURCE||path.resolve(__dirname,'../src/external/klepton');
 if(!fs.existsSync(path.join(klepton,'runtime/gfx/kl_egl.c')))return t.skip('Pinned Klepton source is required');
 const {retireEglDispatch}=await import('../src/modules/android/native/native-surface-sources.mjs');
 const result=retireEglDispatch(fs.readFileSync(path.join(klepton,'runtime/gfx/kl_egl.c'),'utf8'));
 assert.doesNotMatch(result,/kl_ndk_|g_(?:display|configs|surfaces|contexts|egl|gl_handle)\b|klegl_\w+/);
 assert.match(result,/klj_resolve_import\("eglGetCurrentContext"\)/);
 assert.match(result,/klj_resolve_import\("klj_native_egl_swap_count"\)/);
 assert.match(result,/kl_glfb_sym\(name\)/,'Preserve existing GL/XR physical helpers');
 const makefile=fs.readFileSync(path.join(source,'source-list.mk'),'utf8');
 assert.match(makefile,/MACLAUNCHER_FRAMEWORK_OWNED\s*:=[\s\S]*runtime\/guest\/kl_ndk\.c/);
 const owners=JSON.parse(fs.readFileSync(path.join(source,'platform-boundaries.json'))).nativeRegistrationOwners;
 for(const name of ['android.content.res.AssetManager','android.os.MessageQueue','android.view.InputQueue'])assert.ok(owners.some(owner=>owner.owner==='guest'&&owner.classes?.includes(name)),name);
});
