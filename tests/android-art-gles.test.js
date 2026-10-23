const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Original AIM GLES shares padded buffers and planar video with native fences and original GL lifetime',{timeout:180000},t=>{
 const source=process.env.ANDROID_AIM_SOURCE,target=process.env.ANDROID_AIM_CARGO_TARGET,provider=process.env.ANDROID_ANGLE_VULKAN||process.env.ANDROID_ANGLE_METAL;
 const cases=process.env.ANDROID_GLES_PROBE_CASES?process.env.ANDROID_GLES_PROBE_CASES.split(',').map(value=>value.split(':')):[['metal','es1'],['metal','es1-msaa'],['metal','rgba'],['metal','msaa'],['vulkan','rgba'],['vulkan','msaa'],['vulkan','rgbx'],['metal','yuv'],['vulkan','yuv']];
 for(const [backend,format,...extra]of cases)assert.ok(['metal','vulkan'].includes(backend)&&['rgba','rgbx','msaa','yuv','rgb-upload','es1','es1-msaa','es2'].includes(format)&&!extra.length,'explicit GLES component case');
 if(process.platform!=='darwin'||process.arch!=='arm64'||!source||!target||!provider||(cases.some(([backend])=>backend==='vulkan')&&!process.env.KL_MVK_DYLIB))return t.skip('Requires adapted AIM source, owned ANGLE provider, an available Cargo target and MoltenVK for Vulkan cases');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-gles-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 fs.mkdirSync(path.join(temporary,'src'));fs.copyFileSync(path.resolve('tests/fixtures/android-art-gles/main.rs'),path.join(temporary,'src/main.rs'));
 fs.copyFileSync(path.resolve(source,'crates/aim-host-gpu/src/table.rs'),path.join(temporary,'src/table.rs'));
 fs.writeFileSync(path.join(temporary,'Cargo.toml'),'[package]\nname="android-art-gles-probe"\nversion="0.0.0"\nedition="2024"\n[dependencies]\naim-host-gpu={path='+JSON.stringify(path.resolve(source,'crates/aim-host-gpu'))+'}\naim-hostcall={path='+JSON.stringify(path.resolve(source,'crates/aim-hostcall'))+'}\nlibc="0.2"\n[profile.release]\nstrip=false\n');
 fs.copyFileSync(path.resolve(source,'Cargo.lock'),path.join(temporary,'Cargo.lock'));
 const run=(command,args,env=process.env,timeout=30000)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout,env,maxBuffer:4<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 run('cargo',['build','--offline','--release','-j','2','--manifest-path',path.join(temporary,'Cargo.toml'),'--target-dir',path.resolve(target)],process.env,150000);
 for(const [backend,format] of cases){
  const driverCache=path.join(temporary,'driver-cache-'+backend);if(format==='rgb-upload')fs.mkdirSync(driverCache);
  const env={...process.env,KL_ANGLE_BACKEND:backend,MVK_CONFIG_LOG_LEVEL:'1',...(format==='rgb-upload'?{MACLAUNCHER_ANDROID_EGL_CACHE:driverCache}:{})};
  const output=run(path.resolve(target,'release/android-art-gles-probe'),[path.resolve(provider),format],env);
  // EGL may provide a newer compatible context for a request for ES2.
  assert.match(output,format.startsWith('es1')?/version=OpenGL ES(-CM)? 1\./:format==='es2'?/version=OpenGL ES [23]\./:backend==='metal'?/version=OpenGL ES 3\.0/:/version=OpenGL ES 3\.1/);
  if(format.startsWith('es1')||format==='es2'){
   assert.match(output,/PASS original GLES[12] presentation leaves no GL error and preserves both actual shared colors/);
   assert.match(output,/PASS original GLES[12] asymmetric rows and scaled Android origin preserved/);
   t.diagnostic(backend+' '+format+' original presentation and actual native-fenced colors passed');continue;
  }
  if(format==='rgb-upload'){
   assert.match(output,/PASS forwarded RGB8 extent2 alignment1 actual draw and nine texels \[255, 64, 32, 255\]/);
   assert.match(output,/PASS forwarded RGB8 extent1024 alignment8 actual draw and nine texels \[255, 64, 32, 255\]/);
   assert.match(output,/PASS original GPU hostcall installed the shared persistent EGL cache/);
   const before=fs.readdirSync(path.join(driverCache,'egl-programs')).filter(file=>file.endsWith('.blob')).map(file=>({file,modified:fs.statSync(path.join(driverCache,'egl-programs',file)).mtimeMs}));assert.ok(before.length);
   assert.match(run(path.resolve(target,'release/android-art-gles-probe'),[path.resolve(provider),format],env),/PASS original GPU hostcall installed the shared persistent EGL cache/);
   for(const item of before)assert.equal(fs.statSync(path.join(driverCache,'egl-programs',item.file)).mtimeMs,item.modified,'Warm original shader reuses the same persistent entry');
   t.diagnostic(backend+' original generated RGB8 uploads, draw and FBO texels passed');continue;
  }
  if(format==='yuv'){
   assert.equal((output.match(/PASS planar \[/g)||[]).length,12,'NV12, NV21, YV12 and P010 each update through three frames');
   assert.match(output,/PASS planar converted RGB survives pending conversion, image lease and source mapping retirement/);
   t.diagnostic(backend+' planar video conversion, reuse, source and GPU resource retirement passed');
   continue;
  }
  assert.match(output,/PASS shared GPU buffer \[255, 0, 0, 255\], stride128, guest mapping retired, native fence signaled/);
  assert.match(output,/PASS shared GPU buffer \[0, 0, 255, 255\], stride128, guest mapping retired, native fence signaled/);
  assert.match(output,/PASS resolve before flip\/scale, actual asymmetric rows and application GL state preserved/);
  assert.match(output,/PASS cached imported FBO writes visible after original native fence without presentation/);
  assert.match(output,/PASS existing imported GL object observes host update after native-fence completion/);
  assert.match(output,/PASS original AIM GPU public API: live GL reference survives EGLImage\/mmap retirement; complete cleanup/);
  t.diagnostic(backend+' '+format+' original GPU import, original present, native fences and final-reference cleanup passed');
 }
});
