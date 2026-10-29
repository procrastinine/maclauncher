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
