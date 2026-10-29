const test=require('node:test'),assert=require('node:assert/strict');
const {create,lifecycleFailure,providerFailureDetails}=require('../src/modules/android/account-stages');
test('Original Java rejection classes survive the diagnostic transport without provider text',()=>{
 assert.deepEqual(providerFailureDetails({failureType:'java.lang.SecurityException',message:'PRIVATE_TOKEN'}),{providerFailureType:'java.lang.SecurityException'});
 assert.deepEqual(providerFailureDetails({providerFailureType:'java.io.IOException',failureType:'java.lang.SecurityException'}),{providerFailureType:'java.io.IOException'});
 assert.deepEqual(providerFailureDetails({providerFailureType:'java.io.IOException',get failureType(){throw Error('Alias must not replace canonical type');}}),{providerFailureType:'java.io.IOException'});
 assert.deepEqual(providerFailureDetails({failureType:'private@example.com',providerFailureSite:'oauth_token=PRIVATE_TOKEN'}),{});
 assert.equal(lifecycleFailure({failureType:'java.lang.SecurityException'},'enroll-system').type,'java.lang.SecurityException');
});
test('Lifecycle failure identities exclude dynamic error text and preserve the owner phase',()=>{
  const error=TypeError('PRIVATE_SECRET');error.name='PRIVATE_NAME';error.stack='oauth_token=PRIVATE_TOKEN';error.code='PRIVATE_CODE';
  Object.defineProperty(error,'message',{get(){throw Error('Message must not be inspected');}});
  assert.deepEqual(lifecycleFailure(error,'initialize-services'),{stage:'initialize-services',type:'TypeError',sites:[],causes:[]});
  error.providerFailureType='private@example.com';error.providerFailureSite='https://invalid/PRIVATE_TOKEN';
  assert.doesNotMatch(JSON.stringify(lifecycleFailure(error,'initialize-services')),/PRIVATE|oauth|private@|https/);
  error.providerFailureType='java.io.IOException';error.providerFailureSite='fixture.Packages.verify:42';
  assert.deepEqual(lifecycleFailure(error,'prepare-connections'),{stage:'prepare-connections',type:'java.io.IOException',sites:['fixture.Packages.verify:42'],causes:[]});
  assert.equal(lifecycleFailure(new Proxy({},{getPrototypeOf(){throw Error('private');}}),'invalid private stage').type,'Error');
});
test('Lifecycle diagnostics retain fixed failure codes and validate the pre-return phase',()=>{
  assert.deepEqual(lifecycleFailure({code:'ENOENT',platformStartupStage:'resolve-account-runtime'},'start-service'),
    {stage:'resolve-account-runtime',type:'Error',sites:[],causes:[],code:'ENOENT'});
  assert.deepEqual(lifecycleFailure({code:'PRIVATE_CODE',platformStartupStage:'private@example.com'},'start-service'),
    {stage:'start-service',type:'Error',sites:[],causes:[]});
  assert.equal(lifecycleFailure({code:'ACCOUNT_PROVIDER_ERROR'},'initialize-services').code,'ACCOUNT_PROVIDER_ERROR');
});
test('Account stage diagnostics retain counters across arbitrary chunks without provider text',()=>{
  const stages=create(),text='password=PRIVATE_SECRET\nJSBridge: closeView\n-- Request --\noauth_token=PRIVATE_TOKEN\n-- Response --\njava.net.SocketTimeoutException: PRIVATE_URL';
  for(const byte of Buffer.from(text))stages.write(Buffer.from([byte]));
  const output=stages.snapshot();assert.equal(output.counters.webClosed,1);assert.equal(output.counters.httpRequested,1);assert.equal(output.counters.httpResponded,1);assert.equal(output.counters.socketTimeout,1);assert.equal(output.latest,'socketTimeout');
  assert.doesNotMatch(JSON.stringify(output),/PRIVATE|password|oauth|URL/);
  stages.write(Buffer.alloc(1024*1024,65));assert.deepEqual(stages.snapshot(),output);
  const old=stages.begin('addAccount'),recent=stages.begin('removeAccount');old(false);assert.deepEqual(stages.snapshot().operation,{kind:'removeAccount',phase:'pending'});recent(true);assert.deepEqual(stages.snapshot().operation,{kind:'removeAccount',phase:'complete'});
});
test('Account startup diagnostics retain exception identities and sites without credential messages',()=>{
  const stages=create(),text='Exception in thread "private-thread" java.lang.IllegalArgumentException: PRIVATE_SECRET\n'+
    '\tat maclauncher.android.LaunchConfig$Parser.number(LaunchConfig.java:174)\n'+
    'Caused by: java.lang.IllegalStateException: oauth_token=PRIVATE_TOKEN\n'+
    '\tat java.base@21.0.1/java.lang.Thread.run(Thread.java:1583)\n'+
    '\tat private=https://example.invalid/PRIVATE_URL\n';
  for(const byte of Buffer.from(text))stages.write(Buffer.from([byte]));
  assert.deepEqual(stages.snapshot().failure,{type:'java.lang.IllegalArgumentException',sites:['maclauncher.android.LaunchConfig$Parser.number(LaunchConfig.java:174)'],
    causes:[{type:'java.lang.IllegalStateException',sites:['java.base@21.0.1/java.lang.Thread.run(Thread.java:1583)']}]});
  assert.doesNotMatch(JSON.stringify(stages.snapshot()),/PRIVATE|private-thread|oauth|https/);
  stages.write(Buffer.from('\tat '+ 'x'.repeat(1024*1024)+'\n'));assert.equal(stages.snapshot().failure.causes[0].sites.length,1);
});
test('The first account command rejection survives later retirement warnings and chunk boundaries',()=>{
 const stages=create(),text='android.os.ServiceManager$ServiceNotFoundException: optional service\n'+
  '[android-host] Account command failed: android.os.DeadSystemRuntimeException\n'+
  '[android-host] at android.os.StatsServiceManager$ServiceRegisterer.get(StatsServiceManager.java:58)\n'+
  '[android-host] Account command failed: android.os.DeadSystemException\n'+
  '[android-host] at android.os.RemoteException.rethrowFromSystemServer(RemoteException.java:83)\n'+
  'java.lang.IllegalStateException: PRIVATE_TOKEN\n'+
  '\tat android.os.MessageQueue.enqueueMessageUnchecked(MessageQueue.java:2749)\n';
 for(const byte of Buffer.from(text))stages.write(Buffer.from([byte]));
 assert.deepEqual(stages.snapshot().failure,{type:'android.os.DeadSystemRuntimeException',sites:['android.os.StatsServiceManager$ServiceRegisterer.get(StatsServiceManager.java:58)'],causes:[]});
 assert.doesNotMatch(JSON.stringify(stages.snapshot()),/PRIVATE|optional service|enqueueMessageUnchecked/);
});
test('A later account operation gets its own first failure while stage counters remain cumulative',()=>{
 const stages=create(),finish=stages.begin('addAccount');
 stages.write('[android-host] Account command failed: java.lang.SecurityException: PRIVATE_TOKEN\n-- Request --\n');finish(false);
 assert.equal(stages.snapshot().failure.type,'java.lang.SecurityException');
 const remove=stages.begin('removeAccount');assert.equal(stages.snapshot().failure,undefined);
 stages.write('Exception in thread "PRIVATE_THREAD" java.lang.IllegalStateException: PRIVATE_SECRET\n'+
  '\tat example.AccountOwner.remove(AccountOwner.java:42)\n');
 assert.equal(stages.snapshot().failure.type,'java.lang.IllegalStateException');
 stages.write('[android-host] Account command failed: java.io.IOException: PRIVATE_PATH\n'+
  '\tat example.AccountOwner.command(AccountOwner.java:57)\n'+
  'java.lang.RuntimeException: later cleanup\n');remove(false);
 assert.deepEqual(stages.snapshot().failure,{type:'java.io.IOException',sites:['example.AccountOwner.command(AccountOwner.java:57)'],causes:[]});
 assert.equal(stages.snapshot().counters.httpRequested,1);assert.deepEqual(stages.snapshot().operation,{kind:'removeAccount',phase:'failed'});
 assert.doesNotMatch(JSON.stringify(stages.snapshot()),/PRIVATE|later cleanup/);
});
