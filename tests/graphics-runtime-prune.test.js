const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const generation=(root,name,{at,complete=true}={})=>{
 const directory=path.join(root,name,'universal');fs.mkdirSync(directory,{recursive:true});
 if(!complete)return;const manifest=path.join(directory,'runtime.json');fs.writeFileSync(manifest,'{}\n');
 const time=new Date(at);fs.utimesSync(manifest,time,time);
};
test('staging prunes graphics generations except the selected, the previous selection and those in use',async t=>{
 const {pruneGraphicsRuntimes}=await import('../scripts/prune-graphics-runtimes.mjs');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'graphics-prune-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const name=n=>'0.1.0-'+String(n).repeat(8)+'-'+String(n).repeat(8);
 for(const n of [1,2,3,4,5,6])generation(root,name(n),{at:Date.UTC(2026,9,20+n)});
 generation(root,name(7),{complete:false});
 fs.mkdirSync(path.join(root,'0.1.0','universal'),{recursive:true});
 fs.symlinkSync(path.join(root,name(1)),path.join(root,name(8)));
 const processes='/Applications/Game.app/Contents/MacOS/Game --graphics '+path.join(root,name(4),'universal')+'/libreshade-macos.dylib\n';
 const removed=pruneGraphicsRuntimes(root,{selected:name(6),previous:name(2),processes,alive:()=>false});
 assert.deepEqual(removed.sort(),[name(1),name(3),name(5)]);
 assert.deepEqual(fs.readdirSync(root).sort(),['0.1.0',name(2),name(4),name(6),name(7),name(8)].sort(),
  'The previous selection, a running generation, an incomplete generation and non-generation entries remain');
});
test('without a surviving previous selection the most recently staged other generation is kept',async t=>{
 const {pruneGraphicsRuntimes}=await import('../scripts/prune-graphics-runtimes.mjs');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'graphics-prune-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const [old,recent,selected]=['0.1.0-aaaaaaaa-00000001','0.1.0-bbbbbbbb-00000002','0.1.0-cccccccc-00000003'];
 generation(root,old,{at:Date.UTC(2026,9,1)});generation(root,recent,{at:Date.UTC(2026,9,2)});generation(root,selected,{at:Date.UTC(2026,9,3)});
 assert.deepEqual(pruneGraphicsRuntimes(root,{selected,previous:selected,processes:'',alive:()=>false}),[old]);
 assert.deepEqual(pruneGraphicsRuntimes(root,{selected:'0.1.0-dddddddd-00000004',processes:'',alive:()=>false}),[],'An absent selection removes nothing');
 assert.deepEqual(pruneGraphicsRuntimes(root,{selected,processes:null}),[],'Unavailable process information removes nothing');
 assert.throws(()=>pruneGraphicsRuntimes(root,{selected:'../escape',processes:''}),/selected graphics runtime generation is invalid/);
 assert.deepEqual(fs.readdirSync(root).sort(),[recent,selected]);
});
