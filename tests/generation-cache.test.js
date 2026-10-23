const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('generation leases merge selections and use kernel lifetime rather than a reusable PID',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires Darwin open-time exclusive file locks');
 const {withGenerationCache,retainGeneration,liveGenerationPaths}=await import('../scripts/generation-cache.mjs');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'generation-lease-')));let release;
 t.after(()=>{release?.();fs.rmSync(root,{recursive:true,force:true});});
 await withGenerationCache(root,()=>{
  release=retainGeneration(root,[path.join(root,'first')]);
  retainGeneration(root,[path.join(root,'second')]);
  assert.deepEqual(liveGenerationPaths(root,{alive:()=>false}).sort(),[path.join(root,'first'),path.join(root,'second')]);
  assert.equal(fs.readdirSync(path.join(root,'.generation-leases')).length,1,'One kernel descriptor owns all selections in this Node context/cache');
 });
 release();
 await withGenerationCache(root,()=>{
  const stale=path.join(root,'.generation-leases',process.pid+'-'+ 'a'.repeat(24)+'.json');
  fs.writeFileSync(stale,JSON.stringify({schemaVersion:2,pid:process.pid,paths:[path.join(root,'first')]}));
  assert.deepEqual(liveGenerationPaths(root,{alive:()=>true}),[],'An unlocked lease is stale even with the current live PID');
  assert.equal(fs.existsSync(stale),false);
 });
});
test('worker termination closes only its own generation lease without retaining descriptors in the process',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires Darwin open-time exclusive file locks');
 const {Worker}=require('node:worker_threads'),{pathToFileURL}=require('node:url');
 const {withGenerationCache,retainGeneration,liveGenerationPaths}=await import('../scripts/generation-cache.mjs');
 const moduleURL=pathToFileURL(path.resolve(__dirname,'../scripts/generation-cache.mjs')).href;
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'generation-worker-lease-'))),workers=[];let release;
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.terminate()));release?.();fs.rmSync(root,{recursive:true,force:true});});
 await withGenerationCache(root,()=>{release=retainGeneration(root,[path.join(root,'main')]);});
 async function owner(name){
  const worker=new Worker(`const {parentPort,workerData,threadId}=require('node:worker_threads');
   (async()=>{const {withGenerationCache,retainGeneration}=await import(workerData.moduleURL);
    await withGenerationCache(workerData.root,()=>{for(let n=0;n<20;n++)retainGeneration(workerData.root,[workerData.selected]);});
    parentPort.on('message',()=>{});parentPort.postMessage({threadId});
   })().catch(error=>{throw error;});`,{eval:true,workerData:{moduleURL,root,selected:path.join(root,name)}});
  workers.push(worker);await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});return worker;
 }
 const first=await owner('first'),second=await owner('second');
 await withGenerationCache(root,()=>{
  const records=fs.readdirSync(path.join(root,'.generation-leases')).map(name=>JSON.parse(fs.readFileSync(path.join(root,'.generation-leases',name))));
  assert.equal(records.length,3,'Repeated resolves retain one descriptor for each independent context');
  assert.equal(new Set(records.map(record=>record.threadId)).size,3);
  assert.deepEqual(liveGenerationPaths(root,{alive:()=>false}).sort(),['first','main','second'].map(name=>path.join(root,name)));
 });
 await first.terminate();
 await withGenerationCache(root,()=>{
  assert.deepEqual(liveGenerationPaths(root,{alive:()=>true}).sort(),['main','second'].map(name=>path.join(root,name)),'A terminated worker cannot keep its descriptor locked through the still-live process');
  assert.equal(fs.readdirSync(path.join(root,'.generation-leases')).length,2);
 });
 release();await second.terminate();
 await withGenerationCache(root,()=>{assert.deepEqual(liveGenerationPaths(root,{alive:()=>true}),[]);});
});
