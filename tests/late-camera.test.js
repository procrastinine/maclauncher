const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const reshade=path.resolve(__dirname,'../src/modules/shared/reshade');
test('a camera set after its frame\'s evaluation binds only to that frame by its exact jitter offset',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'late-camera-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 // The core build names the shared temporal headers temporal-camera.h and temporal-frame.h.
 fs.copyFileSync(path.join(reshade,'temporal/camera.h'),path.join(directory,'temporal-camera.h'));
 fs.copyFileSync(path.join(reshade,'temporal/frame.h'),path.join(directory,'temporal-frame.h'));
 const binary=path.join(directory,'check');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I'+path.join(reshade,'native'),'-I'+directory,path.join(__dirname,'native/late-camera.cpp'),'-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/late-camera: pass 15/);
});
test('generation scenes take the late camera before their provider reads the scene',()=>{
 const source=fs.readFileSync(path.join(reshade,'native/effects-execution.mm'),'utf8');
 assert.match(source,/#include "late-camera\.hpp"/);
 // The raw scene keeps the evaluation's own jitter offset; normalized views may scale or clear it.
 assert.match(source,/attachLateCamera\(actual,rawGuides\?\*rawGuides:source\);\n\s*actual\.method=RS_TEMPORAL_OFF;actual\.reserved=0;stage\.encoder->setScene\(actual\);/);
 assert.match(source,/if\(raw\.flags&RS_TEMPORAL_CAMERA_VALID\)return;/);
});
