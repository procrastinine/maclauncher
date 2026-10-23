const { spawn } = require('node:child_process');
const { acquire } = require('../../../src/modules/android/platform-services/client');
(async () => {
  const config = JSON.parse(process.argv[2]);
  const lease = await acquire(config);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const peer = { packageName: 'example.app', processName: 'example.app', pid: child.pid, uid: 10042 };
  process.on('disconnect', () => { child.kill(); lease.close(); });
  process.on('message', async message => {
    try {
      if (message.op === 'enroll') await lease.enroll({ ...peer, ...(message.peer || {}) });
      else if (message.op === 'retire') await lease.retire({ ...peer, ...(message.peer || {}) });
      else if (message.op === 'request') await lease.request(message.peer.command, null, {networkAllowed:message.peer.networkAllowed});
      else if (message.op === 'release') lease.close();
      else if (message.op === 'close') { await lease.retire(peer); lease.close(); child.kill(); process.disconnect(); }
      else throw Error('Unknown fixture command');
      process.send?.({ id: message.id, ok: true });
    } catch (error) { process.send?.({ id: message.id, error: error.message, code:error.code,
      platformRole:error.platformRole, platformConnection:error.platformConnection,
      providerFailureType:error.providerFailureType,providerFailureSite:error.providerFailureSite }); }
  });
  process.send({ ready: true, child: child.pid, identity: lease.identity });
})().catch(error => { console.error(error); process.exit(1); });
