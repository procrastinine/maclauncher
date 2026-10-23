const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {processIdentity,processNamespace,frame,receive}=require('../src/modules/android/process-channel');
function child(){const value=new EventEmitter();Object.assign(value,{pid:987654,exitCode:null,signalCode:null,stdio:[null,null,null,null,null,new PassThrough()]});return value;}
test('identity handshake authenticates the physical child and hands off unconsumed authority packets',async()=>{
 const process=child(),stream=process.stdio[5],hello=frame({op:'identity',pid:123,hostPid:process.pid});
 const first=processIdentity(process,{version:1}),concurrent=processIdentity(process,{version:1});
 stream.write(hello.subarray(0,2));stream.write(hello.subarray(2,8));stream.write(Buffer.concat([hello.subarray(8),frame({op:'ready'})]));
 assert.deepEqual(await first,{pid:123,hostPid:987654});assert.deepEqual(await concurrent,await first);
 const packets=new EventEmitter(),next=once(packets,'packet');receive(stream,value=>packets.emit('packet',value),error=>packets.emit('error',error));
 const timer=setTimeout(()=>packets.emit('error',Error('authority handoff stalled')),1000);
 try{assert.deepEqual((await next)[0],{op:'ready'});}finally{clearTimeout(timer);stream.destroy();}
 assert.equal(process.listenerCount('exit'),0);
});
test('identity handshake rejects forged physical ownership and retires a stopped child',async()=>{
 const forged=child(),identity=processIdentity(forged,{version:1});
 forged.stdio[5].write(frame({op:'identity',pid:123,hostPid:1}));
 await assert.rejects(identity,/native owner/);assert.equal(forged.listenerCount('exit'),0);forged.stdio[5].destroy();
 const stopped=child(),pending=processIdentity(stopped,{version:1});stopped.emit('exit',1,null);
 await assert.rejects(pending,/stopped before/);assert.equal(stopped.stdio[5].listenerCount('readable'),0);stopped.stdio[5].destroy();
});
test('immutable physical-ID contracts require no identity packet',async()=>{
 const process=child();assert.deepEqual(await processIdentity(process),{pid:987654,hostPid:987654});
 assert.equal(process.stdio[5].listenerCount('readable'),0);process.stdio[5].destroy();
});
test('authenticated identity carries the existing installation ID without accepting other value shapes',async()=>{
 const process=child(),identity=processIdentity(process,{version:1});
 process.stdio[5].write(frame({op:'identity',pid:123,hostPid:process.pid,androidId:'0123456789abcdef'}));
 assert.deepEqual(await identity,{pid:123,hostPid:process.pid,androidId:'0123456789abcdef'});process.stdio[5].destroy();
 for(const androidId of [null,1234567812345678,'', '0123456789abcdeg']){
  const process=child(),identity=processIdentity(process,{version:1});process.stdio[5].write(frame({op:'identity',pid:123,hostPid:process.pid,androidId}));await assert.rejects(identity,/application identity is invalid/);process.stdio[5].destroy();
 }
});
test('live identity enrollment survives slow initialization and follows authority cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const slow=child();let settled=false;
 const identity=processIdentity(slow,{version:1});identity.then(()=>{settled=true;},()=>{settled=true;});
 t.mock.timers.tick(120000);await Promise.resolve();
 assert.equal(settled,false,'elapsed startup time does not reject a live authenticated owner');
 slow.stdio[5].write(frame({op:'identity',pid:321,hostPid:slow.pid}));
 assert.deepEqual(await identity,{pid:321,hostPid:slow.pid});slow.stdio[5].destroy();
 for(const operation of ['end','destroy']){
  const cancelled=child(),pending=processIdentity(cancelled,{version:1});
  cancelled.stdio[5][operation]();await assert.rejects(pending,/authority closed/);
  assert.equal(cancelled.listenerCount('exit'),0);
  assert.equal(cancelled.stdio[5].listenerCount('readable'),0);cancelled.stdio[5].destroy();
 }
});
test('both execution bindings select one private process lease directory per profile',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-process-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const [one,two]=await Promise.all([processNamespace(root,1),processNamespace(root,1)]);
 assert.deepEqual(one,two);const directory=one.environment.KL_ANDROID_ID_DIRECTORY;
 assert.equal(directory,path.join(fs.realpathSync(root),'android','process-ids'));assert.deepEqual(one.writeDirectories,[directory]);
 assert.equal(fs.statSync(directory).mode&0o777,0o700);
 assert.deepEqual(await processNamespace(root),{environment:{},writeDirectories:[]});
});
