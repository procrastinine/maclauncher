const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Models = require('../src/modules/shared/reshade/neural/models'), Manager = require('../src/modules/shared/reshade/runtime/neural-models-manager');
const Neural = require('../src/modules/shared/reshade/neural'), Preparation = require('../src/modules/shared/reshade/neural/model-preparation');
const Origins = require('../src/core/runtime-install-origins');
const {createRuntimeCoordinator} = require('../src/core/runtime-coordinator');
const {runRuntimeManagerAction} = require('../src/core/runtime-manager-service');
const version = digit => 'sha256-' + digit.repeat(64);
test('actual neural manager variants keep automatic operation families and protected copies distinct', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-retention-'));t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const definitions = [['1','rife'], ['2','rife'], ['0','depth-anything-v2-small'], ['9','nafnet'], ['3','realesrgan'], ['4','realesrgan']];
  const rows = definitions.map(([digit, operation]) => {
    const installDir = path.join(userDataDir, 'runtimes', Models.ID, version(digit));fs.mkdirSync(installDir, {recursive: true});
    const modelPath = path.join(installDir, 'model');fs.mkdirSync(modelPath);
    return {version: version(digit), operation, method: operation, installDir, modelPath, ready: true, removable: true};
  });
  const custom = {version: path.join(userDataDir, 'original.depthmodel'), operation: 'depth-anything-v2-small', ready: true, external: true, custom: true};
  fs.mkdirSync(custom.version);rows.push(custom);
  const installed = () => rows.filter(row => fs.existsSync(row.installDir || row.version));
  t.mock.method(Models, 'listInstalled', installed);t.mock.method(Models, 'listManaged', installed);
  t.mock.method(Neural, 'hostSupported', () => true);t.mock.method(Neural, 'resolve', () => ({}));
  const state = Manager.getState({userDataDir}), byVersion = new Map(state.installed.map(row => [row.version, row]));
  assert.equal(byVersion.get(version('1')).variant, 'operation:rife');assert.equal(byVersion.get(version('0')).variant, 'operation:depth-anything-v2-small');
  t.mock.method(Models, 'resolveModel', async (_root, version) => installed().find(row => row.version === version));
  assert.equal((await Manager.installRuntime({userDataDir, version: version('1')})).variant, byVersion.get(version('1')).variant);
  const plan = {schema: 2, mode: 'advanced', enabled: true, video: [{id: 'rife', kind: 'frame-generation', method: 'rife', enabled: true, settings: {modelPath: null}}]};
  const download = Preparation.downloads(plan, {userDataDir}, {neural: {listModels: () => []}, provider: {supportedMethods: ['rife']}})[0];
  assert.equal(download.installOptions.variant, byVersion.get(version('1')).variant);assert.equal(download.automatic, true);
  for (const digit of ['1','2','0','3']) {
    const result = byVersion.get(version(digit));assert.equal(Origins.recordPlayInstall({userDataDir, manager: Manager,
      plan: {automatic: true, installOptions: {sectionId: 'default', variant: result.variant}}, result}), true);
  }
  assert.equal(Origins.recordPlayInstall({userDataDir, manager: Manager, plan: {automatic: true}, result: custom}), false);
  const settings = {runtimes: {[Models.ID]: {defaultVersions: {realesrgan: version('3')}}}};
  const coordinator = createRuntimeCoordinator({userDataDir, isProcessAlive: async () => true}).client();
  const identity = Models.identityForPath(userDataDir, byVersion.get(version('1')).modelPath);
  assert.equal(identity.variant, 'operation:rife');assert.equal(identity.sourcePath, byVersion.get(version('1')).installDir);
  const use = await coordinator.acquireUse(identity);t.after(() => {try{coordinator.release(use);}finally{coordinator.close();}});await coordinator.bindUse(use, process.pid);
  const options = {userDataDir, managers: [Manager], settings, gameIds: [], isRunning: () => false,
    remove: ({managerId, ...payload}) => runRuntimeManagerAction({manager: Manager, action: 'uninstall', payload, userDataDir, runtimeCoordinator: coordinator})};
  assert.deepEqual((await Origins.pruneSuperseded(options)).removed, [], 'the older same-operation copy is in use; other operation families are not superseded');
  await coordinator.release(use);
  assert.deepEqual((await Origins.pruneSuperseded(options)).removed.map(row => row.version), [version('1')]);
  assert.equal(installed().filter(row => row.operation === 'rife').length, 1);
  for (const digit of ['0','9','3','4']) assert.equal(fs.existsSync(byVersion.get(version(digit)).installDir), true, digit);
  assert.equal(fs.existsSync(custom.version), true);
});
test('live effect acquisition retains automatic version intent and uses canonical multi-operation identity', async () => {
  const plan = {schema: 2, mode: 'advanced', enabled: true, video: [{id: 'model', kind: 'upscale', method: 'realesrgan', enabled: true, settings: {modelPath: null}}]};
  const dependencies = {neural: {listModels: () => []}};
  const automatic = await Preparation.prepare(plan, {}, dependencies);
  assert.equal(automatic.pending[0].acquisition.source.automatic, true);
  assert.equal(automatic.pending[0].acquisition.source.variant, 'operation:realesrgan');
  const saved = await Preparation.prepare(plan, {settings: {runtimes: {[Models.ID]: {defaultVersions: {realesrgan: version('1')}}}}}, dependencies);
  assert.equal(saved.pending[0].acquisition.source.automatic, false);
  const model = {version: version('5'), architecture: Models.SR_ARCHITECTURE, operation: 'mlx-sr-image', compatibleMethods: ['mlx-sr-image', 'mlx-sr-scene']};
  assert.equal(Models.variantFor(model), 'operation:mlx-sr-image');
  assert.equal(Models.variantFor({...model, method: 'mlx-sr-scene'}), 'operation:mlx-sr-image');
});
