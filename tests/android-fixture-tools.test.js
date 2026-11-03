const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Tools=require('./helpers/android-fixture-tools.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-tools-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('offline fixture setup reports absent tools without fetching a publisher archive',async t=>{
 const root=fixture(t),result=await Tools.prepareTools({root,fetch:false,download:()=>assert.fail('Offline setup cannot download')});
 assert.equal(result.ready,false);assert.match(result.reason,/absent offline/);
});
test('fixture setup rejects changed publisher tool bytes before installing them',async t=>{
 const root=fixture(t);
 await assert.rejects(Tools.prepareTools({root,fetch:true,download:async(_url,file)=>fs.writeFileSync(file,'changed publisher bytes')}),/differs from its pinned archive/);
 assert.equal(fs.existsSync(Tools.paths(root).aapt2),false);
});
