const test = require('node:test');
const assert = require('node:assert/strict');
const { createLaunchTiming } = require('../src/modules/android/launch-timing');

test('Launch timing identifies pending work without waiting or altering its result', async () => {
  const messages = [], timing = createLaunchTiming({ info: message => messages.push(message) });
  let release;
  const pending = timing.measure('installed-packages', () => new Promise(resolve => { release = resolve; }));
  assert.deepEqual(messages, ['[android] Preparing: installed-packages']);
  const result = { installed: true };
  release(result);
  assert.equal(await pending, result);
  timing.finish();
  assert.match(messages[1], /^\[android\] Preparation installed-packages \(ms\): \d+$/);
  const summary = JSON.parse(messages[2].slice(messages[2].indexOf('{')));
  assert.ok(summary['installed-packages'] >= 0);
  assert.ok(summary.total >= summary['installed-packages']);
});

test('Launch timing preserves synchronous failures and asynchronous cancellation', async () => {
  const messages = [], timing = createLaunchTiming({ info: message => messages.push(message) });
  const failure = new Error('Original preparation failure');
  await assert.rejects(timing.measure('package', () => { throw failure; }), error => error === failure);
  const cancelled = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(timing.measure('composition', () => Promise.reject(cancelled)), error => error === cancelled);
  assert.equal(messages.filter(message => message.includes('(ms):')).length, 2);
  assert.equal(messages.some(message => message.includes(failure.message)), false);
});
