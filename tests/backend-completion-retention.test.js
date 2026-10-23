const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createBackendService} = require('../src/core/backend-worker-client');
const {observeGameProcess} = require('../src/core/game-process-events');
const workerPath = path.join(__dirname, 'fixtures/backend-completion-worker.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backend-completion-'))), events = [];
  let retired;const retirement = new Promise(resolve => {retired = resolve;});
  const service = createBackendService({userDataDir: root, workerPath, maxIdleWorkers: 0, idleMs: 5,
    onEvent: (event, payload) => {events.push({event, payload, at: performance.now()});if (event === 'activity' && payload.processes === 0) retired();}});
  t.after(async () => {await service.close();fs.rmSync(root, {recursive: true, force: true});});
  const entry = {gameId: 'completion', gamePath: path.join(root, 'fixture-game')};
  return {root, service, entry, lane: 'game:completion', events, retirement};
}
test('worker pressure preserves pending completion diagnostics and immediate frontend exit', {timeout: 5000}, async t => {
  const f = fixture(t), launched = await f.service.launchEntry(f.entry, {}), failures = [];
  let exited = false;
  observeGameProcess(launched.child, {onExit: () => {exited = true;}, onFailure: result => failures.push(result)});
  await f.service.request(f.lane, 'exit');
  assert.equal(exited, true, 'game running state clears before diagnostic drain');
  assert.equal(failures.length, 0);assert.equal(launched.child.completionDiagnostics.pending, true);
  const completed = await f.service.request(f.lane, 'completeDiagnostics');
  assert.equal(completed.threadId, launched.threadId, 'the original worker must survive maxIdleWorkers=0 until diagnostics arrive');
  assert.equal(failures.length, 1);assert.match(failures[0].diagnostics.message, /Original final provider error after native exit/);
  assert.equal(launched.child.completionDiagnostics.pending, false);
  assert.equal(completed.diagnosticListeners, 0, 'the original retention listener is detached');
  assert.equal(f.events.some(row => row.event === 'unexpectedSignal'), false);
});
test('missing completion IPC releases worker retention within the existing bounded wait', {timeout: 5000}, async t => {
  const f = fixture(t), launched = await f.service.launchEntry(f.entry, {neverCompletes: true});
  let exited = false;
  observeGameProcess(launched.child, {onExit: () => {exited = true;}});
  const before = performance.now();await f.service.request(f.lane, 'exit');assert.equal(exited, true);
  await f.retirement;
  const elapsed = performance.now() - before;
  assert.ok(elapsed >= 1400, `pending completion was evicted after only ${elapsed}ms`);
  assert.ok(elapsed < 3000, `missing completion retained the worker for ${elapsed}ms`);
  assert.equal(f.events.filter(row => row.event === 'activity' && row.payload.processes === 0).length, 1);
  assert.equal(f.events.find(row => row.event === 'activity' && row.payload.processes === 0).payload.diagnosticListeners, 0);
  await f.service.close();assert.equal(f.events.some(row => row.event === 'unexpectedSignal'), false);
});
