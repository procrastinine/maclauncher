const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('Android managed families discover only their current project catalogs', {skip: process.arch !== 'arm64'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-managed-delivery-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const families = [
    ['android', 'klepton', require('../src/modules/android/runtime-manager').createManager],
    ['android-aim', 'aim', require('../src/modules/android/providers/aim/manager').createManager]
  ];
  const requests = [], managers = [];
  for (const [id, runtimeId, create] of families) {
    const version = '99.0.0-fixture';
    const manager = create({systemVersionSync:()=> '26.0', fetchUrlBuffer: async url=> {requests.push(url); return {status:404,body:Buffer.alloc(0)};}});
    const userDataDir = path.join(root,'profiles',id), options = {nativeResourceRoot:root};
    const state = manager.getState({userDataDir,...options});
    assert.deepEqual(state.installed, []);
    assert.deepEqual(state.catalog.includedVersions, []);
    assert.equal(state.catalog.recommendedVersion, undefined);
    assert.doesNotMatch(state.catalog.installReason || '', /is not installed\. Install this version/);
    // A missing catalog requests discovery without inventing a package version.
    const fallback = manager.resolveSelection(null,{},userDataDir,options);
    assert.equal(fallback.version,null);
    assert.equal(fallback.selectionRequired,undefined);
    assert.equal(fallback.discoveryRequired,true);
    assert.equal(fallback.ready,false);
    assert.equal(fallback.install,null);
    // A saved explicit choice remains exact even while its package is missing.
    const defaulted = manager.resolveSelection(null,{runtimes:{[id]:{defaultVersion:version}}},userDataDir,options);
    assert.equal(defaulted.version, version);
    for (const selected of [
      manager.resolveSelection(null,{},userDataDir,{...options,version:version}),
      manager.resolveSelection({runtimeData:{[runtimeId]:{version:version}}},{},userDataDir,options),
      ...(state.supportsDefault ? [defaulted] : [])
    ]) {
      assert.equal(selected.version,version);
      assert.equal(selected.ready,false);
      assert.equal(selected.install ?? null,null);
    }
    managers.push({manager,userDataDir,options,version:version,id});
  }
  assert.equal(requests.length,0,'Missing payloads and status never fetch, install or substitute a version');
  for (const {manager,userDataDir,options,version,id} of managers) {
    await assert.rejects(manager.installRuntime({...options,userDataDir,version}), /catalog could not be downloaded/);
    assert.equal(requests.at(-1),`https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/${id}.json`);
    assert.equal(manager.resolveSelection(null,{},userDataDir,{...options,version}).version,version);
  }
  assert.equal(requests.length,2,'Explicit installation discovers only the selected project catalog');
});
