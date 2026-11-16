const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const native=path.resolve(__dirname,'../src/modules/shared/reshade/native');
test('diagnostic intake dumps keep only the latest depth and motion pair',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'intake-dump-files-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'check');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'native/intake-dump-files.cpp'),'-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/intake-dump-files: pass/);
});
test('the temporal intake writes its dumps only to the fixed latest-pair paths',()=>{
 const source=fs.readFileSync(path.join(native,'temporal.mm'),'utf8');
 const begin=source.indexOf('IntakeObservation observeIntake('),end=source.indexOf('\nvoid reportIntake(',begin);assert.ok(begin>0&&end>begin);
 const observe=source.slice(begin,end);
 assert.equal((observe.match(/intakeDump\(commands,/g)||[]).length,2);
 assert.match(observe,/temporalIntakeDumpPath\(prefix,"depth"\)/);assert.match(observe,/temporalIntakeDumpPath\(prefix,"motion"\)/);
 assert.doesNotMatch(observe,/"-intake-"\+std::to_string/,'a dump path must not carry the frame ID');
});
