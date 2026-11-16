'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const reshade=path.join(__dirname,'../src/modules/shared/reshade');

test('a frame the HUD difference does not apply to still generates from its final image',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hud-difference-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 // The core build names the shared temporal headers temporal-*.h.
 for(const name of ['frame','camera','scene-aovs'])fs.copyFileSync(path.join(reshade,`temporal/${name}.h`),path.join(directory,`temporal-${name}.h`));
 const binary=path.join(directory,'check');
 const build=spawnSync('xcrun',['clang++','-std=c++20','-fobjc-arc','-I'+path.join(reshade,'native'),'-I'+path.join(reshade,'native/base/src'),'-I'+directory,
  path.join(__dirname,'native/hud-difference.mm'),path.join(reshade,'native/image-admission.mm'),'-framework','Metal','-framework','Foundation','-framework','IOSurface','-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);
 if(/Metal device unavailable/.test(run.stderr))return t.skip('no Metal device in this environment');
 assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/hud-difference: pass 6/);
});

test('a generation scene is never refused for lacking a HUD difference',()=>{
 const source=fs.readFileSync(path.join(reshade,'native/effects-execution.mm'),'utf8');
 const start=source.indexOf('ShaderResult EffectExecution::bindGenerationScene(');
 const end=source.indexOf('actual.method=RS_TEMPORAL_OFF;actual.reserved=0;',start);
 assert.ok(start>=0&&end>start);
 const body=source.slice(start,end);
 // A HUD-less-only late scene (Deep Rock Galactic's) binds no HUD split and generates with the HUD in the scene.
 assert.doesNotMatch(body,/return \{false,hudDifferenceReason\}/);
 assert.match(body,/const auto difference=bindHudDifference\(stage\.encoder,commands,colour,attachments,source,origin\);if\(!difference\.encoded\)return difference;/);
 const header=fs.readFileSync(path.join(reshade,'native/hud-difference.hpp'),'utf8');
 const bind=header.slice(header.indexOf('ShaderResult bindDifference('),header.indexOf('void setScene('));
 assert.doesNotMatch(bind,/return \{false,/);
 // HUD data is optional: a frame the composition cannot take generates as an ordinary frame, never busy or refused.
 const encode=header.slice(header.indexOf('GenerationResult encodeColorTimed('),header.indexOf('GenerationResult encodeInterval('));
 assert.doesNotMatch(encode,/result\.reason=hudDifferenceReason|result\.busy=true/);
 assert.doesNotMatch(header.slice(header.indexOf('GenerationResult encodeInterval(')),/ordinary real-endpoint generation path/);
});
