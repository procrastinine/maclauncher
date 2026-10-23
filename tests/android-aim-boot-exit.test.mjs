import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {adaptGuestInitExitReport} from '../src/modules/android/providers/aim/source.mjs';

test('native init reports its first stop reason before authenticated namespace retirement', t => {
  const source = process.env.ANDROID_AIM_BOOT_EXIT_SOURCE;
  if (!source) return t.skip('Requires the pinned AIM source');
  const before = fs.readFileSync(path.join(source, 'crates/aim-guest-init/src/boot.rs'), 'utf8');
  const after = adaptGuestInitExitReport(before);
  const run = after.slice(after.indexOf('pub fn run(&mut self)'), after.indexOf('fn sweep_memfds'));
  assert.ok(run.indexOf('maclauncher_boot_stop_report(') < run.indexOf('self.finish();'));
  assert.equal(after.slice(after.indexOf('    fn finish(&mut self)'), after.indexOf('    /// Handles at most one property')), before.slice(before.indexOf('    fn finish(&mut self)'), before.indexOf('    /// Handles at most one property')), 'Original teardown and namespace admission remain unchanged');
  assert.throws(() => adaptGuestInitExitReport(after), /no longer matches/);
});

test('actual original namespace lifecycle retains the first exit report', {timeout: 20000}, t => {
  const executable = process.env.ANDROID_AIM_BOOT_EXIT_EXECUTABLE;
  if (!executable) return t.skip('Requires the compiled original AIM guest-init module');
  const result = spawnSync(executable, ['--exact', 'boot::maclauncher_boot_exit::first_exit_is_visible_before_authenticated_namespace_retirement', '--nocapture', '--test-threads=1'], {encoding: 'utf8', timeout: 15000, maxBuffer: 2 << 20});
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 passed; 0 failed; 0 ignored/);
  t.diagnostic(result.stdout.trim());
});
