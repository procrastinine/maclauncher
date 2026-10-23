const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('ART boot cache publishes only complete images and preserves a same-key winner',async t=>{
 const{publishBootImage}=await import('../src/modules/android/art/boot-image.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-boot-publication-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const destination=path.join(root,'key'),manifest={identity:'key',files:['framework/boot.art']};
 const candidate=(name,value)=>{const built=path.join(root,name);fs.mkdirSync(path.join(built,'framework'),{recursive:true});fs.writeFileSync(path.join(built,manifest.files[0]),value);return built;};
 const first=candidate('first','original image'),second=candidate('second','competing image');
 assert.deepEqual(publishBootImage(first,destination,manifest),{root:destination,...manifest});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination,'boot-image.json'))),manifest);
 assert.equal(fs.existsSync(first),false);
 assert.deepEqual(publishBootImage(second,destination,manifest),{root:destination,...manifest});
 assert.equal(fs.readFileSync(path.join(destination,manifest.files[0]),'utf8'),'original image');
 assert.equal(fs.readFileSync(path.join(second,manifest.files[0]),'utf8'),'competing image');
 const failed=candidate('failed','not published'),absent=path.join(root,'missing-parent/key');
 assert.throws(()=>publishBootImage(failed,absent,manifest),{code:'ENOENT'});assert.equal(fs.existsSync(absent),false);
});
