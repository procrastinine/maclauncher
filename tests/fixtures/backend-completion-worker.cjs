const {parentPort, workerData, threadId} = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), {EventEmitter} = require('node:events'), {PassThrough} = require('node:stream');
const {createBackendOperations} = require('../../src/core/backend-operations');
const {captureRuntimeOutput} = require('../../src/modules/android/provider-output');
const {errorRecord} = require('../../src/core/backend-worker-client');
const root = workerData.userDataDir, gamePath = path.join(root, 'fixture-game'), output = path.join(root, 'output');
fs.mkdirSync(gamePath, {recursive: true});fs.mkdirSync(output, {recursive: true});
let child, entry, neverCompletes = false;
// No native process is started by this worker. Any signal of the terminal
// descriptor is an error, even if an OS PID were subsequently reused.
process.kill = () => {parentPort.postMessage({type: 'event', event: 'unexpectedSignal', payload: {threadId}});throw Error('Terminal diagnostic identities must not be signaled');};
const info = {id: 'completion-fixture', label: 'Completion fixture', gameType: 'native', runtime: {default: 'runner', supported: ['runner'], entries: {runner: {}}}};
const mod = {id: info.id, manifest: info, launchRuntime: async () => {
  child = Object.assign(new EventEmitter(), {pid: 2147483647, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough()});
  if (neverCompletes) child.completionDiagnostics = {pending: true};
  else captureRuntimeOutput(output).attach(child);
  return child;
}};
const registry = {listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod, getModuleInfo: () => info,
  getModuleDir: () => gamePath, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
  detectGameAsync: async () => ({moduleId: info.id, gamePath, contentRootDir: gamePath, name: info.label})};
const operations = createBackendOperations({userDataDir: root, registry, emit: (event, payload) => parentPort.postMessage({type: 'event', event,
  payload: event === 'activity' ? {...payload, diagnosticListeners: child?.listenerCount('diagnostics') || 0} : payload})});
parentPort.on('message', async message => {
  if (message.type === 'beginShutdown') {operations.beginShutdown();return;}
  if (message.type !== 'request') return;
  try {
    let result;
    if (message.method === 'launchEntry') {
      neverCompletes = message.args[1]?.neverCompletes === true;
      entry ||= await operations.importEntry(gamePath, {});
      result = {...await operations.launchEntry(entry, {settings: {}}), threadId};
    } else if (message.method === 'exit') {
      if (!child) throw Error('Original diagnostic owner was evicted');
      child.exitCode = 1;child.emit('exit', 1, null);result = {threadId};
    } else if (message.method === 'completeDiagnostics') {
      if (!child) throw Error('Original diagnostic owner was evicted');
      child.stderr.end('Original final provider error after native exit\n');child.stdout.end();child.emit('close', 1, null);
      result = {threadId, diagnostics: child.completionDiagnostics, diagnosticListeners: child.listenerCount('diagnostics')};
    } else result = {threadId, owned: Boolean(child)};
    parentPort.postMessage({type: 'result', id: message.id, result});
  } catch (error) {parentPort.postMessage({type: 'result', id: message.id, error: errorRecord(error)});}
});
