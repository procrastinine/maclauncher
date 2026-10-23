const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('published Android bind sources resolve once without changing guest paths or missing-source behavior',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-path-map-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const first=path.join(root,'first'),second=path.join(root,'second'),alias=path.join(root,'alias');
 for(const directory of[first,second]){fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'boot.vdex'),'original code');}
 fs.symlinkSync(first,alias,'dir');
 const vdex=path.join(root,'boot-alias.vdex');fs.symlinkSync(path.join(first,'boot.vdex'),vdex);
 const absent=path.join(alias,'not-yet-created'),broken=path.join(root,'broken');fs.symlinkSync(path.join(root,'missing'),broken);
 const lines=[['root','/',alias],['ro','/system/framework/arm64/boot.vdex',vdex],['ro','/system/code',alias],
  ['rw','/data/user/0/example',alias],['rw','/data/service.sock',absent],['ro','/broken',broken]];
 const suffix='# original comment\npropagation\t/\tshared\n';
 const text=lines.map(row=>row.join('\t')+'\n').join('')+suffix;
 const realpath=fs.realpathSync.native,calls=[];
 t.mock.method(fs.realpathSync,'native',source=>{calls.push(source);return realpath(source);});
 const one=publishPathMap(root,'one',text),published=fs.readFileSync(one,'utf8');
 const expected=lines.map(([kind,guest,source])=>[kind,guest,source===alias?first:source===vdex?path.join(first,'boot.vdex'):source].join('\t')+'\n').join('')+suffix;
 assert.equal(published,expected);
 assert.equal(calls.length,new Set(lines.map(row=>row[2])).size,'Aliases shared by mounts are resolved only once per map');
 assert.equal(calls.filter(source=>source===alias).length,1);
 fs.unlinkSync(alias);fs.symlinkSync(second,alias,'dir');
 const two=publishPathMap(root,'two',text);
 assert.equal(fs.readFileSync(one,'utf8'),published,'Published bindings retain their original target');
 assert.ok(fs.readFileSync(two,'utf8').includes('ro\t/system/code\t'+second+'\n'),'A later map resolves the current source');
 assert.equal(fs.readFileSync(two,'utf8').includes('rw\t/data/service.sock\t'+absent+'\n'),true);
 assert.equal(fs.existsSync(absent),false,'Publication never creates an absent mount source');
});
