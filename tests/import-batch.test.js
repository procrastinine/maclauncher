const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');

test('batch attempts every input, reports every failure and counts progress through cancellation', async () => {
  const {runImportBatch} = await import('../src/renderer/src/ui/import-batch.mjs');
  const attempted = [], progress = [];
  const result = await runImportBatch(['/first','/bad','/last','/cancel'], async input => {
    attempted.push(input);
    if (input === '/bad') throw new Error('Pick the game file.');
    if (input === '/cancel') throw new Error('Import cancelled.');
  }, row => progress.push(row));
  assert.deepEqual(attempted, ['/first','/bad','/last','/cancel']);
  assert.equal(result.added, 2);assert.equal(result.total, 4);assert.equal(result.completed, 4);
  assert.deepEqual(result.failures, [{inputPath:'/bad',reason:'Pick the game file.'},{inputPath:'/cancel',reason:'Import cancelled.'}]);
  assert.deepEqual(progress.map(row => [row.completed,row.currentPath]), [[0,'/first'],[1,'/bad'],[2,'/last'],[3,'/cancel'],[4,null]]);
  assert.equal(progress[0].failures.length, 0);
});

test('resolving a failed item updates counts and retains unrelated failures', async () => {
  const {runImportBatch,resolveImportFailure} = await import('../src/renderer/src/ui/import-batch.mjs');
  const original = await runImportBatch(['/bad1','/good','/bad2'], async p => { if (p.startsWith('/bad')) throw Error('Choose a file.'); });
  const selected = await runImportBatch(['/resolved'], async () => {});
  const resolved = resolveImportFailure(original, 0, selected);
  assert.equal(resolved.added, 2);assert.equal(resolved.total, 3);
  assert.deepEqual(resolved.failures, [{inputPath:'/bad2',reason:'Choose a file.'}]);
  const failedRetry = resolveImportFailure(resolved, 0, await runImportBatch(['/bad2'], async () => {throw Error('Still unreadable.')}));
  assert.equal(failedRetry.added, 2);assert.equal(failedRetry.total, 3);
  assert.equal(failedRetry.failures[0].reason, 'Still unreadable.');
});

let component;
test.before(async () => {
  const { build } = require('vite'), Module = require('node:module');
  const result = await build({ configFile:false,logLevel:'silent',build:{ssr:path.join(__dirname,'../src/renderer/src/ui/components/ImportBatch.tsx'),write:false,
    rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs'}}}});
  const compiled = new Module(path.join(__dirname,'import-batch.cjs'),module);compiled.paths=module.paths;
  const originalRequire=compiled.require.bind(compiled);compiled.require=id=>id==='react'?require('./helpers/renderer-component').react:originalRequire(id);
  compiled._compile(result.output.find(row=>row.type==='chunk').code,compiled.id);component=compiled.exports;
});

test('batch UI displays current position and every failed item with independent recovery actions', () => {
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const shared={jobs:[],addPaths:()=>{},onCancel:()=>{},resolve:()=>{},dismiss:()=>{}};
  const markup=renderToStaticMarkup(React.createElement(component.ImportBatches,{...shared,batches:[{id:1,total:55,completed:11,added:11,currentPath:'/games/Current',failures:[]}]}));
  assert.match(markup,/Adding 12 of 55/);assert.match(markup,/value="11"/);assert.match(markup,/Current/);
  const result=renderToStaticMarkup(React.createElement(component.ImportBatches,{...shared,batches:[{id:1,total:55,completed:55,added:53,currentPath:null,failures:[{inputPath:'/bad/A',reason:'Select a game file.'},{inputPath:'/bad/B',reason:'Unreadable file.'}]}]}));
  assert.match(result,/Added 53 of 55/);assert.match(result,/Select a game file/);assert.match(result,/Unreadable file/);
  assert.equal((result.match(/Choose game file/g)||[]).length,2);assert.equal((result.match(/>Retry</g)||[]).length,2);
});

test('failures from several imports share one banner with one Dismiss, and a damaged game offers Show in Finder and Remove', async () => {
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const shared={jobs:[],addPaths:()=>{},onCancel:()=>{},resolve:()=>{},dismiss:()=>{}};
  const html=renderToStaticMarkup(React.createElement(component.ImportBatches,{...shared,batches:[
    {id:1,total:2,completed:2,added:1,currentPath:null,failures:[{inputPath:'/games/Dump',reason:'“Dump” could not be added. Switch dump is missing RomFS.',code:'DETECTION_INVALID_INPUT'}]},
    {id:2,total:1,completed:1,added:0,currentPath:null,failures:[{inputPath:'/games/notes.txt',reason:'“notes.txt” is a TXT file MacLauncher does not recognize as a game.'}]},
    {id:3,total:1,completed:1,added:1,currentPath:null,failures:[]}]}));
  assert.equal((html.match(/aria-label="Import results"/g)||[]).length,2,'the failure banner and the fully added batch');
  assert.match(html,/Added 1 of 3/);assert.match(html,/Added 1 of 1/);
  assert.equal((html.match(/>Dismiss</g)||[]).length,2,'one Dismiss for all failures');
  const [damaged,other]=html.split('<li').slice(1);
  assert.match(damaged,/missing RomFS/);assert.match(damaged,/>Show in Finder</);assert.match(damaged,/>Remove</);
  assert.doesNotMatch(damaged,/Choose game file|>Retry</);
  assert.match(other,/Choose game file/);assert.match(other,/>Retry</);assert.match(other,/>Remove</);
  // The import keeps the code it was rejected with; Remove clears one row and Show in Finder reveals the input.
  const {componentHarness}=require('./helpers/renderer-component'),revealed=[];
  const h=componentHarness(()=>component.useImportBatches({openGameDialog:async()=>[],revealInFinder:async p=>{revealed.push(p);return true;},
    addRecent:async p=>{throw {message:'Damaged.',code:'DETECTION_INVALID_INPUT'};}}),{});
  await h.render().addPaths(['/games/A','/games/B']);
  let state=h.render();assert.deepEqual(state.batches[0].failures.map(row=>row.code),['DETECTION_INVALID_INPUT','DETECTION_INVALID_INPUT']);
  state.reveal('/games/A');state.remove(state.batches[0],0);state=h.render();
  assert.deepEqual(state.batches[0].failures.map(row=>row.inputPath),['/games/B']);assert.deepEqual(revealed,['/games/A']);
  state.remove(state.batches[0],0);assert.deepEqual(h.render().batches,[],'removing the last failure clears its batch');h.close();
});

test('per-item chooser cancellation preserves failures and resolving one keeps the other actionable', async () => {
  const {componentHarness}=require('./helpers/renderer-component');
  let chosen=[];const added=[];
  const h=componentHarness(()=>component.useImportBatches({openGameDialog:async()=>chosen,addRecent:async p=>{added.push(p);if(p.startsWith('/bad'))throw Error('Choose a game file.')}}),{});
  await h.render().addPaths(['/bad1','/good','/bad2']);
  let state=h.render();assert.equal(state.batches[0].added,1);
  await state.resolve(state.batches[0],0,true);state=h.render();
  assert.equal(state.batches[0].failures.length,2);assert.equal(state.batches[0].resolving,undefined);
  chosen=['/fixed'];await state.resolve(state.batches[0],0,true);state=h.render();
  assert.equal(state.batches[0].added,2);assert.equal(state.batches[0].total,3);
  assert.equal(state.batches[0].failures[0].inputPath,'/bad2');
  await state.resolve(state.batches[0],0,false);state=h.render();assert.equal(state.batches[0].failures.length,1);
  state.dismiss(state.batches[0].id);assert.deepEqual(h.render().batches,[]);
  assert.deepEqual(added,['/bad1','/good','/bad2','/fixed','/bad2']);h.close();
});

test('a finished batch closes after 30 seconds while failed, running and hovered batches stay', async () => {
  const {componentHarness}=require('./helpers/renderer-component'),{mock}=require('node:test');
  mock.timers.enable({apis:['setTimeout']});
  const notices=new Map();
  try {
    let finish;
    const batches=componentHarness(()=>component.useImportBatches({openGameDialog:async()=>['/fixed'],addRecent:p=>p==='/running'
      ?new Promise(resolve=>{finish=resolve}):p==='/bad'?Promise.reject(Error('Choose a game file.')):Promise.resolve()}),{});
    await batches.render().addPaths(['/good']);await batches.render().addPaths(['/bad']);
    const running=batches.render().addPaths(['/running']);
    // React mounts one ImportBatchNotice per batch; each gets its own harness here.
    const show=()=>{const state=batches.render();for(const batch of state.batches){
      const notice=notices.get(batch.id)||{props:{jobs:[],onCancel(){}}};notices.set(batch.id,notice);
      Object.assign(notice.props,{batch,resolve:state.resolve,dismiss:state.dismiss});
      notice.harness||=componentHarness(component.ImportBatchNotice,notice.props);notice.tree=notice.harness.render();}
      return state.batches.map(batch=>batch.id);};
    assert.deepEqual(show(),[1,2,3]);
    mock.timers.tick(29_999);assert.deepEqual(show(),[1,2,3]);
    mock.timers.tick(1);assert.deepEqual(show(),[2,3]);
    await batches.render().resolve(batches.render().batches[0],0,true);assert.deepEqual(show(),[2,3]);
    notices.get(2).tree.props.onMouseEnter();show();mock.timers.tick(60_000);assert.deepEqual(show(),[2,3]);
    notices.get(2).tree.props.onMouseLeave();show();mock.timers.tick(29_999);assert.deepEqual(show(),[2,3]);
    mock.timers.tick(1);assert.deepEqual(show(),[3]);
    finish();await running;assert.deepEqual(show(),[3]);
    mock.timers.tick(30_000);assert.deepEqual(show(),[]);
    batches.close();
  } finally { for(const notice of notices.values())notice.harness?.close();mock.timers.reset(); }
});
