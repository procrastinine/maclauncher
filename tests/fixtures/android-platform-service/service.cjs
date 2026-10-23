const net = require('node:net'), fs = require('node:fs'), path = require('node:path');
const { receive, send } = require('../../../src/modules/android/process-channel');
const socket = new net.Socket({ fd: 5 }), log = path.join(process.argv[2], 'events.jsonl');
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
record({ op: 'start', pid: process.pid, lock: fs.fstatSync(4).ino });
process.stderr.write('PRIVATE_SERVICE_OUTPUT\n');
receive(socket, message => {
  if (message.schemaVersion === 2) return void send(socket, { op: 'ready' });
  record(message);
  if(message.op==='enroll'&&process.argv[3])return void send(socket,{op:'failed',requestId:message.requestId,error:'Fixture enrollment rejected',failureType:process.argv[3]});
  void send(socket, { op: message.op === 'enroll' ? 'enrolled' : 'retired', requestId: message.requestId });
}, error => { console.error(error); process.exit(1); });
// Hold the lock briefly after owner death, exposing accidental overlapping
// database owners rather than relying on prompt child scheduling.
socket.on('end', () => setTimeout(() => process.exit(0), 600));
