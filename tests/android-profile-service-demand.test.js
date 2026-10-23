const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{EventEmitter,once}=require('node:events');
const {randomUUID}=require('node:crypto');
const {frame,receive,processNamespace}=require('../src/modules/android/process-channel');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');

test('early profile lookup shares actual authority demand and authority EOF releases a blocked main Looper',{timeout:30000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, Java21 and the Android native runtime');
 const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-profile-demand-'))),children=new Set();
 t.after(()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null)try{process.kill(-child.pid,'SIGKILL');}catch{}fs.rmSync(temporary,{recursive:true,force:true});});
 const cp=[temporary,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 const source=path.resolve('src/modules/android/native/java/maclauncher/android');
 execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,
  ...['ProcessAuthority','framework/HostProcessServices','framework/HostRemoteServices','framework/HostServices','framework/HostSystemServices','framework/HostStartupTiming','framework/HostKeyStore','framework/HostAccounts','framework/HostUriGrants','framework/HostShortcuts'].map(name=>path.join(source,name+'.java')),
  path.resolve('tests/fixtures/android-process-authority/ProfileServiceDemandProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
 const namespace=await processNamespace(temporary,1);
 function launch(mode){
  const data=path.join(temporary,mode);fs.mkdirSync(data);
  const child=spawn(path.join(home,'bin/java'),[...frameworkJvmOptions,'-Xverify:all','-Djava.awt.headless=true','-cp',cp,'maclauncher.android.ProfileServiceDemandProbe',path.resolve(runtime),data,mode,path.join(temporary,'profile.sock'),String(process.getuid())],
   {env:{...process.env,...namespace.environment},detached:true,stdio:['pipe','pipe','pipe','ignore','ignore',mode==='owner'?'ignore':'pipe']});
  children.add(child);child.once('exit',()=>children.delete(child));
  const events=new EventEmitter(),values=[];let stdout='',stderr='',pending='';
  child.stdout.on('data',chunk=>{stdout+=chunk;pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{values.push(JSON.parse(line));}catch{}events.emit('change');}});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.once('exit',()=>events.emit('change'));
  child.details=()=>stdout+'\n'+stderr;
  child.wait=predicate=>new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>finish(Error('Profile demand event timed out: '+child.details())),7000);
   const changed=()=>{const value=values.find(predicate);if(value)return finish(null,value);if(child.exitCode!=null||child.signalCode!=null)finish(Error('Profile demand process ended: '+child.details()));};
   function finish(error,value){clearTimeout(timer);events.removeListener('change',changed);error?reject(error):resolve(value);}
   events.on('change',changed);changed();
  });
  return child;
 }
 const owner=launch('owner'),ready=await owner.wait(value=>value.event==='ready');
 for(const scenario of ['connect','eof']){
  const child=launch(scenario),messages=[],changes=new EventEmitter();
  receive(child.stdio[5],value=>{messages.push(value);changes.emit('change');},error=>changes.emit('failure',error));
  const incoming=predicate=>new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>finish(Error('Authority frame timed out: '+child.details())),7000);
   const changed=()=>{const value=messages.find(predicate);if(value)finish(null,value);};
   function finish(error,value){clearTimeout(timer);changes.removeListener('change',changed);changes.removeListener('failure',finish);error?reject(error):resolve(value);}
   changes.on('change',changed);changes.once('failure',finish);changed();
  });
  const hello=await incoming(value=>value.op==='identity');assert.equal(hello.hostPid,child.pid);
  const peer={packageName:'example.lazy',processName:'example.lazy',pid:hello.pid,hostPid:hello.hostPid,uid:10023,hostUid:process.getuid(),securityContext:'u:r:untrusted_app:s0'};
  owner.stdin.write(JSON.stringify({op:'enroll',peer})+'\n');await owner.wait(value=>value.event==='enroll'&&value.pid===peer.pid);
  child.stdio[5].write(frame({schemaVersion:2,self:peer,serviceOwners:{system:{packageName:'android',processName:'android.system'}}}));
  const request=await incoming(value=>value.op==='connect');await child.wait(value=>value.event==='duplicate');
  assert.equal(request.packageName,'android');assert.equal(request.processName,'android.system');assert.equal(typeof request.requestId,'string');
  assert.equal(messages.filter(value=>value.op==='connect').length,1,'Concurrent queries retain one pending process activation');
  const ended=once(child,'exit');
  if(scenario==='connect')child.stdio[5].write(frame({op:'connect',role:'system',peer:ready.identity,socketPath:path.join(temporary,'profile.sock'),connectionId:randomUUID()}));
  else child.stdio[5].end();
  const [code,signal]=await ended;assert.equal(code,0,signal+'\n'+child.details());
  assert.match(child.details(),scenario==='connect'?/PASS early main and duplicate lookups share one authority demand and authenticated native Binder directory/:/PASS authority EOF releases main and duplicate lookup before application monitor or Looper dispatch/);
  assert.equal(messages.filter(value=>value.op==='connect').length,1,'Resolving both queries never sends another demand');
  owner.stdin.write(JSON.stringify({op:'retire',peer})+'\n');await owner.wait(value=>value.event==='retire'&&value.pid===peer.pid);
 }
 const ownerEnded=once(owner,'exit');owner.stdin.end(JSON.stringify({op:'close'})+'\n');const [code,signal]=await ownerEnded;assert.equal(code,0,signal+'\n'+owner.details());
});
