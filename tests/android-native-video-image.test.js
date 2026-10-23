const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Android planar video buffers preserve orientation, shared conversion and original EGL image lifetime',t=>{
 const angle=process.env.ANDROID_ANGLE_ROOT,headers=process.env.ANDROID_GLES_HEADERS||path.resolve('src/external/krkrsdl2/external/krkrz/external/angle/include');
 if(process.platform!=='darwin'||process.env.KLEPTON_GRAPHICS_RUN!=='1'||!angle)return t.skip('Requires macOS Metal and an explicit ANGLE provider');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-video-image-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const binary=path.join(directory,'probe'),source=path.resolve('src/modules/android/native');
 const args=['-std=c++20','-O2','-fobjc-arc','-I'+headers,'-I'+source,path.resolve('tests/fixtures/android-native/video-image.mm'),path.join(source,'video-image.mm'),path.join(source,'video-pixels.mm'),'-o',binary];
 for(const name of ['Foundation','Metal','CoreVideo','CoreImage','CoreGraphics','Accelerate'])args.push('-framework',name);
 let result=spawnSync('clang++',args,{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stdout+result.stderr);
 result=spawnSync(binary,[path.resolve(angle)],{encoding:'utf8',timeout:20000});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS original EGL planar video image formats, reuse, bounds and retirement/);t.diagnostic(result.stdout.trim());
});
