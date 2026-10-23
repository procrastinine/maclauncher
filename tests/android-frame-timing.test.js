const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events');
const History=require('../src/modules/android/frame-history');
function directory(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-frames-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function record(index){return Buffer.from('[android-frame] '+JSON.stringify({surface:1,path:'native',hostSeconds:index,sourceFps:42,intervalP95Ms:34,padding:'x'.repeat(500)})+'\n');}
function read(files){return files.flatMap(file=>fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));}
test('frame histories survive SDK log noise, split records, rotation and process failure',t=>{
 const root=directory(t),file=path.join(root,'runtime.log'),child=new EventEmitter();child.stderr=new EventEmitter();
 require('../src/modules/android/host').captureStderr(child,file,root);
 const line=record(1);child.stderr.emit('data',line.subarray(0,7));child.stderr.emit('data',line.subarray(7));
 child.stderr.emit('data',Buffer.alloc(40000,65));child.stderr.emit('data',record(2));
 child.emit('close',null,'SIGKILL');
 assert.deepEqual(read(child.completionDiagnostics.frameLogFiles).map(item=>item.hostSeconds),[1,2]);
 const history=History.open(root);t.after(()=>history.close());
 for(let i=2;i<1500;i++){history.feed(record(i));history.flush();}
 const rows=read(history.files).sort((a,b)=>a.hostSeconds-b.hostSeconds);
 assert.equal(rows.at(-1).hostSeconds,1499);assert.ok(rows.length>=150&&rows.length<500);
 assert.ok(history.files.every(file=>fs.statSync(file).size<=128*1024));
 assert.ok(rows.every(item=>Number.isSafeInteger(item.recordedAt)));
 history.close();history.close();
});
test('frame history retains open inodes without recreating removed game storage',t=>{
 const root=directory(t),storage=path.join(root,'game');fs.mkdirSync(storage);
 const history=History.open(storage);t.after(()=>history.close());
 const retained=path.join(root,'retained');fs.renameSync(storage,retained);fs.mkdirSync(storage);
 history.feed(record(1));history.close();
 assert.equal(fs.readdirSync(storage).length,0);
 assert.equal(read([path.join(retained,'frame-times.0.jsonl')])[0].sourceFps,42);
});
test('interleaved ART application and composition streams retain independent record boundaries',t=>{
 const root=directory(t),child=new EventEmitter(),source=new EventEmitter();child.stderr=new EventEmitter();
 require('../src/modules/android/host').captureStderr(child,path.join(root,'runtime.log'),root,undefined,{frameSource:source});
 const frame=Buffer.from('[android-frame] '+JSON.stringify({surface:1,path:'surfaceflinger',stage:'composition',hostSeconds:1,sourceFps:45})+'\n');
 source.emit('data',frame.subarray(0,20));child.stderr.emit('data',record(99));source.emit('data',frame.subarray(20));
 child.emit('close',0,null);
 assert.deepEqual(read(child.completionDiagnostics.frameLogFiles).map(row=>[row.path,row.sourceFps]),[['native',42],['surfaceflinger',45]]);
 assert.equal(source.listenerCount('data'),0,'retired app releases its presentation diagnostic subscription');
});
test('an earlier process cannot overwrite the next launch frame history',t=>{
 const root=directory(t),earlier=History.open(root),current=History.open(root);
 t.after(()=>earlier.close());t.after(()=>current.close());
 current.feed(record(2));current.close();earlier.feed(record(1));earlier.close();
 assert.deepEqual(read(current.files).map(item=>item.hostSeconds),[2]);
});
test('first source observations survive the same bounded history without inventing FPS',t=>{
 const root=directory(t),history=History.open(root);t.after(()=>history.close());
 const first={surface:1,path:'native',stage:'application',counterScope:'source',hostSeconds:1.001,sourceFps:null,observedFrames:1,intervals:0,firstFrameHostSeconds:1,lastFrameHostSeconds:1};
 const feed=value=>history.feed(Buffer.from('[android-frame] '+JSON.stringify(value)+'\n'));
 feed(first);feed({...first,observedFrames:0});feed({...first,intervals:1});feed({...first,lastFrameHostSeconds:.5});
 history.flush();const rows=read(history.files);assert.equal(rows.length,1);assert.equal(rows[0].sourceFps,null);assert.equal(rows[0].observedFrames,1);assert.equal(rows[0].lastFrameHostSeconds,1);assert.ok(Number.isSafeInteger(rows[0].recordedAt));
});
test('native frame timing preserves slow frames without allocating a per-frame queue',{skip:process.platform!=='darwin'},t=>{
 const root=directory(t),binary=path.join(root,'probe');
 let result=spawnSync('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native'),path.resolve('tests/fixtures/android-native/frame-timing.cpp'),'-o',binary],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);result=spawnSync(binary,[],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS bounded frame intervals/);
});
test('shared native reporter separates composition and presentation rates across presenter replacement',{skip:process.platform!=='darwin'},t=>{
 const root=directory(t),binary=path.join(root,'observation');
 const native=path.resolve('src/modules/android/native'),objects=['android-log.c','process-ids.c'].map(file=>{
  const output=path.join(root,file+'.o'),compiled=spawnSync('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+native,'-c',path.join(native,file),'-o',output],{encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stderr);return output;
 });
 let result=spawnSync('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+native,path.resolve('tests/fixtures/android-native/frame-observation.cpp'),...objects,'-o',binary],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);result=spawnSync(binary,[],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const emitted=result.stderr.trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf('[android-frame] ')+16)));
 assert.equal(emitted[0].sourceFps,null);assert.equal(emitted[0].observedFrames,1);
 const rows=emitted.filter(row=>row.sourceFps!==null);
 assert.equal(rows.length,3);assert.ok(rows.every(row=>row.stage==='composition'&&row.path==='surfaceflinger'));
 assert.ok(rows.every(row=>Number.isFinite(row.sourceFps)&&row.sourceFps===1));
 assert.equal(rows[0].presentedAvailable,true);assert.equal(rows[0].presentedFps,0,'initial cumulative presentation count is not a new interval');
 assert.equal(rows[1].presentedAvailable,true);assert.ok(rows[1].presentedFps>1.9&&rows[1].presentedFps<2.1,'replacement presenter resets its cumulative counters');
 assert.equal(rows[2].presentedAvailable,false);assert.equal(rows[2].presentedFps,0);
 assert.equal(rows[0].sourceWidth,640);assert.equal(rows[0].outputWidth,1280);
 for(const mode of ['single','burst','closed']){
  result=spawnSync(binary,[mode],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const evidence=result.stderr.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line.slice(line.indexOf('[android-frame] ')+16)));
  assert.ok(evidence.length>0,mode+' followed by idle must retain its actual producer observation');
  assert.equal(evidence[0].sourceFps,null,'one frame supplies no frame interval or FPS');
  assert.equal(evidence[0].observedFrames,1);assert.equal(evidence[0].intervals,0);
  assert.equal(evidence[0].firstFrameHostSeconds,1);assert.equal(evidence[0].lastFrameHostSeconds,1);
  if(mode!=='single'){assert.equal(evidence.at(-1).observedFrames,2);assert.equal(evidence.at(-1).intervals,1);assert.equal(evidence.at(-1).lastFrameHostSeconds,1.016);assert.equal(evidence.at(-1).sourceFps,62.5);}
  if(mode==='closed'){
   const history=History.open(root);history.feed(Buffer.from(result.stderr));history.close();
   assert.deepEqual(read(history.files).map(row=>[row.observedFrames,row.sourceFps]),[[1,null],[2,62.5]],'actual retained native output reaches the existing history parser after guest stderr closes');
  }
 }
});
