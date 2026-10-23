const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('original Rust descriptor creators retire numeric generations while retained descriptions survive',t=>{
 const binary=process.env.ANDROID_ART_DESCRIPTOR_CONTROL;
 if(process.platform!=='darwin'||!binary)return t.skip('Requires compiled original Rust descriptor-generation CPU fixture');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-descriptor-generation-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const result=spawnSync(path.resolve(binary),[root],{encoding:'utf8',timeout:15000,env:{...process.env,MACLAUNCHER_ART_FILE_WRITE_OBSERVATION:'1'}});
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/PASS fresh descriptor generation/);assert.doesNotMatch(result.stderr,/\[android-test-file-write\]/);
});
