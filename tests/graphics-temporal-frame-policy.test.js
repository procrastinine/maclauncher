const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('declined temporal rows write the real image and preserve declared output views',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'temporal-frame-policy-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'check'),native=path.resolve(__dirname,'../src/modules/shared/reshade/native');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'native/temporal-frame-policy.cpp'),'-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/temporal-frame-policy: pass/);
});
