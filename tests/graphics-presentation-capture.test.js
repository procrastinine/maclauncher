const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const native=path.resolve(__dirname,'../src/modules/shared/reshade/native');
test('a screenshot is served from the game drawable while the owned output declines frames before its reveal',{skip:process.platform!=='darwin'},t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'presentation-capture-policy-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'check');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'native/presentation-capture-policy.cpp'),'-o',binary],{encoding:'utf8'});
 assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/presentation-capture-policy: pass/);
});
test('the Metal presentation hook routes declined frames through the screenshot policy',()=>{
 const source=fs.readFileSync(path.join(native,'metal.mm'),'utf8');
 const submit=source.indexOf('presentation->submitDisplayFrame(buffer,source,');assert.ok(submit>0);
 const branch=source.slice(submit,source.indexOf('\n    }\n',submit));
 assert.match(branch,/presentationFrameWithScreenshot\(result,presentation->outputRevealed\(\),\[&\]\{capturePresented\(\);\}\)/);
 assert.doesNotMatch(branch,/if\(result\.busy\)return;/,'a declined frame must not return before the screenshot policy');
});
