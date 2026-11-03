const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Payload=require('../src/modules/shared/runtime/payload-files');

function tree(t,files){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'payload-aliases-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const [relative,text]of Object.entries(files)){const file=path.join(root,'input',relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
 return {root,inputs:new Map(Object.keys(files).map(relative=>[relative,path.join(root,'input',relative)]))};
}

test('staging stores identical resolved provider files once per payload and the resolver maps every removed path',async t=>{
 const {resolvedPrefixes,deduplicate,aliasIndex,ALIAS_INDEX}=await import('../scripts/payload-aliases.mjs');
 const {root,inputs}=tree(t,{
  'temporal/p/provider.json':JSON.stringify({resolvedPaths:['shaders/']}),'temporal/p/LICENSE':'same',
  'temporal/p/shaders/1/a.metal':'same','temporal/p/shaders/2/a.metal':'same','temporal/p/shaders/2/b.metal':'other','temporal/p/shaders/3/a.metal':'same',
  'temporal/p/shaders/lib.dylib':'same','temporal/q/provider.json':JSON.stringify({resolvedPaths:['s/']}),'temporal/q/s/a.metal':'same',
  'temporal/r/provider.json':JSON.stringify({files:[]}),'temporal/r/a.metal':'same'});
 const prefixes=resolvedPrefixes(inputs);
 assert.deepEqual(prefixes,[{directory:'temporal/p',prefix:'temporal/p/shaders/'},{directory:'temporal/q',prefix:'temporal/q/s/'}]);
 const result=deduplicate(inputs,{prefixes,keep:new Set(['temporal/p/shaders/lib.dylib'])});
 // Later copies within one payload's resolved paths become aliases. Files
 // outside them, kept executables and other payloads are stored unchanged.
 assert.deepEqual([...result.indexes],[['temporal/p',{'shaders/2/a.metal':'shaders/1/a.metal','shaders/3/a.metal':'shaders/1/a.metal'}]]);
 assert.deepEqual([...inputs.keys()].filter(relative=>!result.inputs.has(relative)),['temporal/p/shaders/2/a.metal','temporal/p/shaders/3/a.metal']);
 const destination=path.join(root,'package');
 for(const [relative,file]of result.inputs){fs.mkdirSync(path.dirname(path.join(destination,relative)),{recursive:true});fs.copyFileSync(file,path.join(destination,relative));}
 for(const [directory,aliases]of result.indexes)fs.writeFileSync(path.join(destination,directory,ALIAS_INDEX),aliasIndex(aliases));
 const provider=path.join(destination,'temporal/p');
 assert.equal(Payload.stored(provider,'shaders/2/a.metal'),'shaders/1/a.metal');
 assert.equal(Payload.stored(provider,'shaders/2/b.metal'),'shaders/2/b.metal');
 assert.equal(Payload.resolve(destination,'temporal/p/shaders/3/a.metal'),path.join(provider,'shaders/1/a.metal'));
 assert.equal(fs.readFileSync(Payload.resolve(provider,'shaders/3/a.metal'),'utf8'),'same');
 assert.equal(Payload.resolve(destination,'temporal/q/s/b.metal'),path.join(destination,'temporal/q/s/b.metal'));
 // A directory whose files are all aliases still exists logically.
 assert.equal(fs.existsSync(path.join(provider,'shaders/3')),false);
 assert.equal(Payload.exists(provider,'shaders/3'),true);assert.equal(Payload.exists(destination,'temporal/p/shaders/3/a.metal'),true);
 assert.equal(Payload.exists(provider,'shaders/4'),false);
 // Unsafe declarations stop staging; an unsafe or malformed index has no aliases.
 fs.writeFileSync(path.join(root,'input/temporal/q/provider.json'),JSON.stringify({resolvedPaths:['../s/']}));
 assert.throws(()=>resolvedPrefixes(inputs),/Invalid resolved payload paths/);
 fs.writeFileSync(path.join(provider,ALIAS_INDEX),JSON.stringify({schema:1,files:{'shaders/2/a.metal':'../escape'}}));
 assert.equal(Payload.stored(provider,'shaders/2/a.metal'),'shaders/2/a.metal');
 fs.writeFileSync(path.join(provider,ALIAS_INDEX),'{');
 assert.equal(Payload.exists(provider,'shaders/3'),false);
});

test('every provider that declares resolved paths opens them through the shared payload resolver',()=>{
 const reshade=path.join(__dirname,'../src/modules/shared/reshade');
 const providers={'temporal/asr':['build.mjs','backend.mm'],'temporal/fsr':['build.mjs','backend.mm'],'generation/fsr3':['build.mjs','metal-backend.hpp'],
  'temporal/fsr4':['build.mjs','provider.mm']};
 for(const [directory,[build,loader]]of Object.entries(providers)){
  assert.match(fs.readFileSync(path.join(reshade,directory,build),'utf8'),/resolvedPaths/,directory);
  const source=fs.readFileSync(path.join(reshade,directory,loader),'utf8');
  assert.match(source,/#include "(?:\.\.\/)+(?:temporal\/)?payload-files\.hpp"/,directory);
  assert.doesNotMatch(source,/ContentsOfFile:\[base stringByAppendingString/,directory);
 }
 // The FSR4 runtime's native model reads are adapted to the same resolver.
 assert.equal((fs.readFileSync(path.join(reshade,'temporal/fsr4/adapt-runtime.mjs'),'utf8').match(/maclauncher::payloadFile/g)||[]).length,2);
});
