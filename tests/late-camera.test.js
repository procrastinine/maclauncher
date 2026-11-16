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
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/late-camera: pass 23/);
});
test('generation scenes take the late camera before their provider reads the scene',()=>{
 const source=fs.readFileSync(path.join(reshade,'native/effects-execution.mm'),'utf8');
 assert.match(source,/#include "late-camera\.hpp"/);
 // The raw scene keeps the evaluation's own jitter offset; normalized views may scale or clear it.
 assert.match(source,/const auto&raw=rawGuides\?\*rawGuides:source;/);
 assert.match(source,/else attachLateCamera\(actual,raw\);/);
 assert.match(source,/return \{false,"Needs matching renderer camera inputs"\};\n\s*actual\.method=RS_TEMPORAL_OFF;actual\.reserved=0;stage\.encoder->setScene\(actual\);/);
 assert.match(source,/if\(raw\.flags&RS_TEMPORAL_CAMERA_VALID\)return;/);
});
test('a generation row that needs a camera admits a scene whose camera arrives late, then declines a frame without one',()=>{
 const source=fs.readFileSync(path.join(reshade,'native/effects-execution.mm'),'utf8');
 // The scene is received at its evaluation, before the game sets the frame's camera.
 assert.match(source,/bool generationCameraAvailable\(const std::string&method,const RSTemporalFrame\*scene\)\{return sceneGenerationCamera\(method,scene\)\|\|scene&&late_camera::pending\(late_camera::mapped\(\)\);\}/);
 // An execution prepared before the first record is not reused once records arrive.
 assert.match(source,/append\(temporal&&!\(temporal->flags&RS_TEMPORAL_CAMERA_VALID\)&&std::any_of\(snapshot->nodes\.begin\(\),snapshot->nodes\.end\(\),\[\]\(const auto&node\)\{return node\.enabled&&node\.kind=="frame-generation"&&generationRequiresCamera\(node\.method\);\}\)&&late_camera::pending\(late_camera::mapped\(\)\)\);/);
 assert.match(source,/\n\s*if\(stage\.row<impl->rows\.size\(\)&&generationRequiresCamera\(impl->rows\[stage\.row\]\.spec\.method\)&&!sceneGenerationCamera\(impl->rows\[stage\.row\]\.spec\.method,&actual\)\)return \{false,"Needs matching renderer camera inputs"\};/);
});

test('the launcher keeps the late camera file only while an enabled frame-generation row consumes the camera',t=>{
 const Runtime=require('../src/modules/shared/effects/runtime'),Mapped=require('../src/modules/shared/reshade/mapped-demand');
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'late-camera-file-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=Runtime.lateCameraFile(path.join(directory,'effect-plan.json'));assert.equal(file,path.join(directory,'effect-plan.temporal-camera'));
 const anr={id:'generation',kind:'frame-generation',enabled:true,method:'anr',settings:{}};
 assert.equal(Runtime.lateCamera({mode:'advanced',nodes:[anr]}),true);
 for(const node of [{...anr,enabled:false},{...anr,method:'lsfg'},{...anr,method:'xess'},{...anr,kind:'temporal',method:'fsr3'}])
  assert.equal(Runtime.lateCamera({mode:'advanced',nodes:[node]}),false,JSON.stringify(node));
 Mapped.camera(file,true,{root:directory});const created=fs.statSync(file);assert.equal(created.size,4096);
 // the game's processes map it: an existing file keeps its inode and records
 const records=fs.openSync(file,'r+');fs.writeSync(records,Buffer.from([7]),0,1,0);fs.closeSync(records);
 Mapped.camera(file,true,{root:directory});assert.equal(fs.statSync(file).ino,created.ino);assert.equal(fs.readFileSync(file)[0],7);
 Mapped.camera(file,false,{root:directory});assert.equal(fs.existsSync(file),false);
 fs.writeFileSync(file,'x');Mapped.camera(file,true,{root:directory});assert.equal(fs.statSync(file).size,4096);assert.equal(fs.readFileSync(file)[0],0);
 assert.match(fs.readFileSync(path.join(__dirname,'../src/modules/shared/effects/runtime.js'),'utf8'),
  /require\("\.\.\/reshade\/mapped-demand"\)\.camera\(lateCameraFile\(target\), lateCamera\(document\), \{root\}\);/);
});
test('a late scene keyed by its frame\'s owner and id gives that frame\'s generation stage its HUD split and camera',()=>{
 const source=fs.readFileSync(path.join(reshade,'native/effects-execution.mm'),'utf8'),aovs=fs.readFileSync(path.join(reshade,'native/scene-aovs.mm'),'utf8');
 const header=fs.readFileSync(path.join(reshade,'temporal/frame.h'),'utf8');
 assert.match(header,/int rsProcessLateScene\(const RSTemporalFrame \*, RSTemporalResult \*\);/);
 assert.match(source,/extern "C" int rsProcessLateScene\(const RSTemporalFrame\*f,RSTemporalResult\*r\)\{/);
 // the driver binds the frame's attachments first; a late frame has no images of its own
 assert.match(aovs,/if\(f&&v&&v->size==sizeof\(\*v\)&&v->version==1&&macfx::lateSceneFrame\(\*f\)\)\{/);
 assert.match(source,/if\(const auto aovs=macfx::takeLateSceneAovs\(\*f\)\)\{/);
 // copied in the late scene's own command order, then named by owner and frame id
 assert.match(source,/\[blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake\(region\.x,region\.y,0\)/);
 assert.match(source,/const auto&raw=rawGuides\?\*rawGuides:source;const auto late=lateScene\(raw\.owner,raw\.frameId\);/);
 // the HUD split only without other attachments, composed exactly over the presented image
 assert.match(source,/const auto pair=!attachments&&late\?lateScenePair\(\*late,source\.frameId,colour,imageColor\(\)\):nullptr;if\(pair\)attachments=pair;/);
 assert.match(source,/lease->composedColor=colour;lease->composedX=lease->composedY=0;lease->composedWidth=uint32_t\(colour\.width\);lease->composedHeight=uint32_t\(colour\.height\);lease->composedRegionKnown=true;/);
 // the record's camera, with the scene's depth direction, before the camera file
 assert.match(source,/const bool lateCamera=late&&late->camera&&!\(raw\.flags&RS_TEMPORAL_CAMERA_VALID\)&&bool\(late->cameraFlags&RS_TEMPORAL_DEPTH_REVERSED\)==bool\(raw\.flags&RS_TEMPORAL_DEPTH_REVERSED\);/);
 assert.match(source,/else attachLateCamera\(actual,raw\);/);
});

test('preparing a generation stage for a scene whose camera arrives late takes the newest late camera, so the provider can check its camera inputs', () => {
 const source=fs.readFileSync(path.join(reshade,'native/effects-execution.mm'),'utf8'),header=fs.readFileSync(path.join(reshade,'native/late-camera.hpp'),'utf8');
 assert.match(header,/inline bool newest\(const Mailbox \*mailbox, bool reversed, RSTemporalCamera &out\)/);
 // The probe that the provider prepares with takes the newest camera with the scene's depth direction; frames still bind their own.
 assert.match(source,/rsBindTemporalSceneMatrices\(&probe,&\*matrices\);if\(generationRequiresCamera\(node\.method\)\)prepareLateCamera\(probe,rawGuides\?\*rawGuides:\*temporal\);\}/);
 assert.match(source,/static void prepareLateCamera\(RSTemporalFrame&probe,const RSTemporalFrame&raw\)\{\n\s*if\(raw\.flags&RS_TEMPORAL_CAMERA_VALID\)return;/);
 assert.match(source,/newestLateSceneCamera\(raw\.owner,reversed\)[\s\S]{0,200}late_camera::newest\(late_camera::mapped\(\),reversed,camera\)/);
 assert.match(source,/Generation preparation takes the newest late camera from the /);
});
