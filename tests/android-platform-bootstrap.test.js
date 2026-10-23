const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process'),{once}=require('node:events');
const path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os'),net=require('node:net');
const {connectAuthority}=require('../src/modules/android/platform-services/jvm');
const channel=require('../src/modules/android/process-channel');

async function authority(t){
  const child=fork(path.join(__dirname,'fixtures/android-platform-service/bootstrap.cjs'),[],{stdio:['ignore','ignore','pipe','ipc','ignore','pipe']});
  const bootstrap=once(child,'message'),owner=await connectAuthority(child,'system',1);
  t.after(async()=>{const stopped=child.exitCode!=null||child.signalCode!=null?Promise.resolve():once(child,'close');owner.close();await stopped;});
  const packet=(await bootstrap)[0];assert.equal(packet.schemaVersion,2);assert.equal(packet.self.pid,child.pid);
  assert.equal(packet.self.hostPid,child.pid);assert.equal(packet.self.processName,'android.system');
  assert.equal(packet.self.capabilities,undefined);return {child,owner};
}

test('the inherited authority sends the physical PID before Java reads its first frame',{timeout:5000},async t=>{
  const {child,owner}=await authority(t);let ready=false;owner.ready.then(()=>ready=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(ready,false);
  child.send({op:'ready',processStateVersion:1});await owner.ready;
  assert.equal(owner.identity.processStateVersion,1);assert.equal(owner.deviceReady,undefined);
  const authorization={packages:[{packageName:'example.app',uid:10042,sourceApks:['/installed/example.apk']}]};
  const request=once(child,'message'),pending=owner.enroll({pid:70001,packageName:'example.app',processName:'example.app',uid:10042},authorization);
  const message=(await request)[0];assert.equal(message.op,'enroll');assert.equal(message.peer.pid,70001);
  assert.deepEqual(message.authorization,authorization);
  child.send({op:'enrolled',requestId:message.requestId});await pending;
});

test('platform startup and pending enrollment retire with their owning child',{timeout:5000},async t=>{
  const {child,owner}=await authority(t),request=once(child,'message');
  const pending=owner.enroll({pid:70001});const rejected=assert.rejects(pending,/stopped|closed/);
  await request;child.kill();await Promise.all([rejected,assert.rejects(owner.ready,/stopped|closed/)]);
});

test('physical identity does not consume a nonexistent pre-bootstrap frame or impose a 16-bit PID limit',async()=>{
  const child={pid:70001,exitCode:null,signalCode:null};
  assert.deepEqual(await channel.processIdentity(child),{pid:70001,hostPid:70001});
  await assert.rejects(channel.processIdentity({...child,exitCode:0}),/live native owner/);
});

test('each profile service is acquired directly without circular device or KeyStore leases',{timeout:5000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'android-profile-lease-'));
  const locations={},paths=require('../src/modules/android/platform-services/paths'),events=[],servers=[],sockets=new Set();
  t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));await fs.rm(root,{recursive:true,force:true});});
  const stamp={pid:process.pid,uid:process.getuid(),startedSeconds:1,startedMicros:2};
  t.mock.method(channel,'helperCommand',async()=>stamp);let rejectKey=false;
  for(const role of ['system','keystore','accounts']){
    const socketPath=path.join(root,role+'.sock');locations[role]={controllerSocket:socketPath,platformSocket:socketPath+'.binder',metadata:role};
    const server=net.createServer(socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
      channel.receive(socket,value=>{
        events.push([role,value.op]);assert.equal(value.readiness,undefined);
        if(role==='keystore'&&rejectKey)return void channel.send(socket,{id:value.id,error:'actual key failure',code:'EIO'});
        channel.send(socket,{id:value.id,result:{socketPath:locations[role].platformSocket,
          identity:{uid:role==='keystore'?1017:1000,processName:'android.'+role,
            securityContext:role==='keystore'?'u:r:keystore:s0':'u:r:system_server:s0'}}}).catch(()=>{});
      },()=>socket.destroy());
    });servers.push(server);await new Promise(resolve=>server.listen(socketPath,resolve));
  }
  t.mock.method(paths,'paths',async(_,role)=>locations[role]);
  t.mock.method(paths,'readPrivate',async role=>({schemaVersion:1,socketPath:locations[role].controllerSocket,capability:'fixture',owner:stamp}));
  const modulePath=require.resolve('../src/modules/android/platform-services/client'),previous=require.cache[modulePath];
  delete require.cache[modulePath];const {acquire}=require(modulePath);
  t.after(()=>{delete require.cache[modulePath];if(previous)require.cache[modulePath]=previous;});
  for(const role of ['keystore','accounts','system']){
    events.length=0;const lease=await acquire({userDataDir:root,runtimeRoot:root,role});assert.deepEqual(events,[[role,'hello']]);
    const closed=[...sockets].map(socket=>once(socket,'close'));lease.close();await Promise.all(closed);assert.equal(sockets.size,0);
  }
  rejectKey=true;await assert.rejects(acquire({userDataDir:root,runtimeRoot:root,role:'keystore'}),/actual key failure/);
  await Promise.all([...sockets].map(socket=>once(socket,'close')));assert.equal(sockets.size,0);
});

test('pending profile endpoints retain one authenticated lease and join readiness or retirement',{timeout:5000},async t=>{
  const root=await fs.mkdtemp('/private/tmp/android-profile-ready-'),sockets=new Set(),events=[];
  const location={controllerSocket:path.join(root,'controller'),platformSocket:path.join(root,'binder'),metadata:'system'};
  const stamp={pid:process.pid,uid:process.getuid(),startedSeconds:1,startedMicros:2};
  const identity={uid:1000,pid:60001,packageName:'android',processName:'android.system',securityContext:'u:r:system_server:s0'};
  let hello;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    channel.receive(socket,value=>{
      events.push(value.op);
      if(value.op==='hello')hello({socket,value});
      else channel.send(socket,{id:value.id,result:value.op}).catch(()=>{});
    },()=>socket.destroy());
  });
  await new Promise(resolve=>server.listen(location.controllerSocket,resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const locations=require('../src/modules/android/platform-services/paths');
  t.mock.method(locations,'paths',async(_,role)=>{assert.equal(role,'system');return location;});
  t.mock.method(locations,'readPrivate',async()=>({schemaVersion:1,socketPath:location.controllerSocket,capability:'fixture',owner:stamp}));
  t.mock.method(channel,'helperCommand',async()=>stamp);
  const modulePath=require.resolve('../src/modules/android/platform-services/client'),previous=require.cache[modulePath];
  delete require.cache[modulePath];const {prepare}=require(modulePath);
  t.after(()=>{delete require.cache[modulePath];if(previous)require.cache[modulePath]=previous;});
  const options={userDataDir:root,runtimeRoot:root,role:'system'};
  const begin=async fields=>{
    events.length=0;
    const entered=new Promise(resolve=>hello=resolve),lease=await prepare({...options,...fields});
    const request=await entered;
    assert.equal(lease.socketPath,location.platformSocket);assert.equal(lease.identity,undefined);
    assert.deepEqual(events,['hello']);
    return {lease,...request};
  };
  const reply=({socket,value})=>channel.send(socket,{id:value.id,result:{identity,socketPath:location.platformSocket}});
  const active=await begin(),enrolling=active.lease.enroll({pid:10023},{packages:[]});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['hello'],'Enrollment cannot precede original service readiness');
  await reply(active);const owner=await active.lease.ready;assert.deepEqual(owner.identity,identity);assert.equal(active.lease.identity,owner.identity);
  assert.equal(await enrolling,'enroll');assert.equal(await active.lease.processState({pid:10023},2),'process-state');
  assert.equal(await active.lease.retire({pid:10023}),'retire');assert.deepEqual(events,['hello','enroll','process-state','retire']);
  const ended=once(active.socket,'close');await active.lease.close();await ended;

  const late=await begin(),lateEnded=once(late.socket,'close');let closed=false;
  const retiring=late.lease.close().then(()=>closed=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'Retirement retains an unfinished acquisition');
  await reply(late);await retiring;await lateEnded;assert.deepEqual(events,['hello'],'A late-acquired owner closes without enrollment');

  const failed=await begin(),failedEnded=once(failed.socket,'close');
  const rejected=assert.rejects(failed.lease.ready,{message:'Original service rejected startup',code:'EIO'});
  await channel.send(failed.socket,{id:failed.value.id,error:'Original service rejected startup',code:'EIO'});
  await rejected;await failed.lease.close();await failedEnded;

  const cancellation=new AbortController(),cancelled=await begin({signal:cancellation.signal}),cancelledEnded=once(cancelled.socket,'close'),reason=Error('Launch cancelled');
  const stopped=assert.rejects(cancelled.lease.ready,error=>error===reason);
  cancellation.abort(reason);await stopped;await cancelled.lease.close();await cancelledEnded;
  assert.equal(sockets.size,0);
});

test('existing-owner reservations stay lazy, retain compatible owners and reject busy owners without retry',{timeout:5000},async t=>{
  const root=await fs.mkdtemp('/private/tmp/android-existing-owner-'),sockets=new Set(),events=[];
  const location={controllerSocket:path.join(root,'controller'),platformSocket:path.join(root,'binder'),metadata:'owner'};
  const stamp={pid:process.pid,uid:process.getuid(),startedSeconds:1,startedMicros:2};
  const identity={uid:1000,pid:60001,packageName:'android',processName:'android.system',securityContext:'u:r:system_server:s0'};
  let absent=true,busy=false;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    channel.receive(socket,value=>{
      events.push(value.op);assert.equal(value.op,'hello');
      channel.send(socket,busy?{id:value.id,error:'Close running Android games before changing the Android runtime.',code:'EBUSY'}:
        {id:value.id,result:{identity,socketPath:location.platformSocket}}).catch(()=>{});
    },()=>socket.destroy());
  });
  await new Promise(resolve=>server.listen(location.controllerSocket,resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const locations=require('../src/modules/android/platform-services/paths');
  t.mock.method(locations,'paths',async()=>location);
  t.mock.method(locations,'readPrivate',async()=>{if(absent)throw Object.assign(Error('No owner'),{code:'ENOENT'});return{schemaVersion:1,socketPath:location.controllerSocket,capability:'fixture',owner:stamp};});
  t.mock.method(channel,'helperCommand',async()=>stamp);
  t.mock.method(require('node:child_process'),'spawn',()=>assert.fail('Reservation must never start a service owner'));
  const modulePath=require.resolve('../src/modules/android/platform-services/client'),previous=require.cache[modulePath];
  delete require.cache[modulePath];const{retainExisting}=require(modulePath);
  t.after(()=>{delete require.cache[modulePath];if(previous)require.cache[modulePath]=previous;});
  const options={userDataDir:root,runtimeRoot:root,role:'system'};
  assert.equal(await retainExisting(options),null);assert.deepEqual(events,[]);
  absent=false;const lease=await retainExisting(options);assert.deepEqual(lease.identity,identity);
  assert.equal(sockets.size,1,'A compatible existing owner remains reserved before application enrollment');
  assert.deepEqual(events,['hello']);const ended=[...sockets].map(socket=>once(socket,'close'));lease.close();await Promise.all(ended);
  busy=true;events.length=0;await assert.rejects(retainExisting(options),{code:'EBUSY',message:'Close running Android games before changing the Android runtime.'});
  await Promise.all([...sockets].map(socket=>once(socket,'close')));
  assert.deepEqual(events,['hello'],'Busy owners must not be retried or replaced');assert.equal(sockets.size,0);
});
