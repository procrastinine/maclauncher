const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('ANR accepts declared infinite depth with the B15 program constants',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'anr-frame-camera-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'check'),native=path.resolve(__dirname,'../src/modules/shared/reshade/generation/anr/native');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'native/anr-frame-camera.cpp'),'-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/anr-frame-camera: pass/);
});
