const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const native=path.resolve(__dirname,'../src/modules/shared/reshade/generation/anr/native');
test('ANR frame constants place the current camera where the B15 program linearizes depth',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'anr-frame-constants-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'check');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'native/anr-frame-constants.cpp'),'-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/anr-frame-constants: pass/);
});
test('the ANR provider builds its frame block from the shared layout',()=>{
 const backend=fs.readFileSync(path.join(native,'backend.mm'),'utf8');
 // A local plane array put the current camera at bytes 0/4, where the program
 // never reads it, and linearized the current depth with the previous planes.
 assert.doesNotMatch(backend,/float values\[\]=\{[^}]*(?:nearPlane|farPlane)/,'frame planes are written outside frameConstants');
 assert.match(backend,/anr::frameConstants\(constants,camera,reset\?camera:c\.previous,/);
 assert.match(backend,/#include "frame_constants\.hpp"/);assert.match(backend,/anr::cameraReason\(\*f\)/);
 assert.match(backend,/\|\|anr::frameCamera\(f\)\.infinite!=c\.previous\.infinite;/);
});
