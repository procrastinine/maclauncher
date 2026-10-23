const { parentPort } = require('node:worker_threads');
const Github = require('../../src/modules/shared/runtime/github-transport');
const pending = new Map(), controllers = new Set(); let serial = 0;
Github.configureHostTransport((method, ...args) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); parentPort.postMessage({ type: 'callback', id, method, args }); }));
parentPort.on('message', async message => {
  if (message.type === 'callbackResult') { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); if (message.error) task.reject(Object.assign(Error(message.error.message), message.error)); else task.resolve(message.result); return; }
  if (message.type !== 'request') return;
  try { let result; if (message.method === 'peek') result = Github.peekAuthenticationStatus(); else if (message.method === 'auth') result = await Github.authenticationStatus(); else if (message.method === 'abortFetches') { for (const controller of controllers) controller.abort(); result = true; } else { const controller = new AbortController(); controllers.add(controller); try { const response = await Github.request(message.args[0], { signal: controller.signal }); result = { status: response.status, body: response.body.toString('utf8') }; } finally { controllers.delete(controller); } } parentPort.postMessage({ type: 'result', id: message.id, result }); }
  catch (error) { parentPort.postMessage({ type: 'result', id: message.id, error: { message: error.message, name: error.name, code: error.code } }); }
});
