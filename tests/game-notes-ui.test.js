const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');
const { build } = require('vite');
let createNotesWriter;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, '../src/renderer/src/ui/components/queued-write-model.ts'), write: false,
    rollupOptions: { output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'game-notes-model.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  createNotesWriter = compiled.exports.createQueuedWriter;
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test('blur writes during a pending save coalesce to the latest draft and finish after selection changes', async () => {
  const started = [], gates = [deferred(), deferred()];
  let concurrent = 0, maximum = 0;
  const writer = createNotesWriter(async value => {
    const index = started.length; started.push(value);
    maximum = Math.max(maximum, ++concurrent);
    await gates[index].promise; concurrent--;
  });
  let selectedField = value => writer.save(value);
  const first = selectedField('first draft');
  const second = selectedField('middle draft');
  const latest = selectedField('latest draft\nUnicode ✨');
  selectedField = null;
  assert.equal(writer.busy, true); assert.deepEqual(started, ['first draft']);
  gates[0].resolve(); assert.equal(await first, 'first draft');
  assert.deepEqual(started, ['first draft', 'latest draft\nUnicode ✨']);
  gates[1].resolve();
  assert.deepEqual(await Promise.all([second, latest]), ['latest draft\nUnicode ✨', 'latest draft\nUnicode ✨']);
  assert.equal(maximum, 1); assert.equal(writer.busy, false);
});
test('repeated blur or Cmd-S for the same in-flight draft does not submit another write', async () => {
  const gate = deferred(), values = [];
  const writer = createNotesWriter(async value => { values.push(value); await gate.promise; });
  const first = writer.save('same note'), second = writer.save('same note');
  gate.resolve(); assert.deepEqual(await Promise.all([first, second]), ['same note', 'same note']);
  assert.deepEqual(values, ['same note']); assert.equal(writer.busy, false);
});
test('clearing notes while an older draft is saving persists the empty string', async () => {
  const gate = deferred(), values = [];
  const writer = createNotesWriter(async value => { values.push(value); if (values.length === 1) await gate.promise; });
  const first = writer.save('temporary text'), clear = writer.save('');
  gate.resolve(); assert.equal(await first, 'temporary text'); assert.equal(await clear, '');
  assert.deepEqual(values, ['temporary text', '']); assert.equal(writer.busy, false);
});
test('a failed save reports its error without dropping a queued draft or preventing retry', async () => {
  const gate = deferred(), values = [], error = new Error('Write failed');
  const writer = createNotesWriter(async value => { values.push(value); if (values.length === 1) await gate.promise; });
  const first = writer.save('old draft');
  const failure = assert.rejects(first, error);
  const next = writer.save('new draft');
  gate.reject(error); await failure;
  assert.equal(await next, 'new draft'); assert.equal(writer.busy, false);
  assert.equal(await writer.save('retry draft'), 'retry draft');
  assert.deepEqual(values, ['old draft', 'new draft', 'retry draft']);
});
test('different games keep independent note writes while one game waits', async () => {
  const gate = deferred(), firstGame = [], secondGame = [];
  const first = createNotesWriter(async value => { firstGame.push(value); await gate.promise; });
  const second = createNotesWriter(async value => { secondGame.push(value); });
  const pending = first.save('A');
  assert.equal(await second.save('B'), 'B'); assert.equal(first.busy, true); assert.equal(second.busy, false);
  gate.resolve(); assert.equal(await pending, 'A');
  assert.deepEqual(firstGame, ['A']); assert.deepEqual(secondGame, ['B']);
});
test('a rejected settings write still saves the newer queued options snapshot', async () => {
  const gate = deferred(), received = [], error = new Error('Settings write failed');
  const writer = createNotesWriter(async snapshot => { received.push(snapshot); if (received.length === 1) await gate.promise; });
  const older = { enableProtections: false, renderer: 'auto', arguments: [] };
  const newer = { enableProtections: true, renderer: 'metal', arguments: ['--windowed'] };
  const first = writer.save(older), failed = assert.rejects(first, error);
  const queued = writer.save(newer);
  gate.reject(error); await failed;
  assert.equal(await queued, newer);
  assert.deepEqual(received, [older, newer]); assert.equal(writer.busy, false);
});
test('runtime settings Reset submits the displayed draft snapshot for successful acknowledgment', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/components/RuntimeSettingsWindow.tsx'), 'utf8');
  const body = /function onReset\(\) \{([\s\S]*?)\n  \}\n\n  function onFieldChange/.exec(source)?.[1];
  assert.ok(body, 'Use the actual Reset handler');
  const reset = new Function('schema', 'baseDefaults', 'buildRuntimeSettingsDefaults', 'draftRef',
    'setDraft', 'setDirty', 'setSaveError', 'persistDraft', body);
  const defaults = Object.freeze({ windowTitle: '', displayFPS: false });
  const gate = deferred(), writer = createNotesWriter(async () => { await gate.promise; });
  const draftRef = { current: { windowTitle: 'Changed title', displayFPS: true } };
  let displayed = draftRef.current, dirty = false, error = 'Earlier error', written;
  reset({}, defaults, () => { throw Error('Existing defaults are available'); }, draftRef,
    value => { displayed = value; }, value => { dirty = value; }, value => { error = value; },
    value => { written = writer.save(value); });
  assert.deepEqual(displayed, defaults);
  assert.notEqual(displayed, defaults, 'Defaults remain immutable');
  assert.equal(displayed, draftRef.current);
  assert.equal(dirty, true); assert.equal(error, null); assert.equal(writer.busy, true);
  gate.resolve();
  assert.equal(await written, draftRef.current, 'The written snapshot acknowledges the current displayed draft');
  assert.equal(writer.busy, false);
});
