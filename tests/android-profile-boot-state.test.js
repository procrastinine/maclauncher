const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {bootCount}=require('../src/modules/android/platform-services/boot-state');
const {readPrivate,writePrivate}=require('../src/modules/android/platform-services/paths');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');

test('profile boot count changes only across host boot sessions, not service restarts',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS boot-session identity');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'android-boot-count-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 assert.equal(await bootCount({root}),1);assert.equal(await bootCount({root}),1);
 const file=path.join(root,'boot.json'),first=await readPrivate(file);
 assert.match(first.session,/^[0-9a-f-]{36}$/i);
 await writePrivate(file,{session:'00000000-0000-0000-0000-000000000000',count:41});
 assert.equal(await bootCount({root}),42);assert.equal(await bootCount({root}),42);
 assert.equal((await readPrivate(file)).session,first.session);
});

test('initial boot metadata reaches an application before lazy profile attachment',{timeout:30000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires Java21 and a complete Android runtime');
 const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
 const {processNamespace,receive,send}=require('../src/modules/android/process-channel');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-initial-settings-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const shared=process.env.ANDROID_BOOT_SHARED_RUNTIME||runtime;
 const cp=[root,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(shared,name))].join(path.delimiter);
 execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',root,
  path.resolve('tests/fixtures/android-process-authority/BootMetadataProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),
  ...['SyntheticResources','PackageManifest'].map(name=>path.resolve('tests/fixtures/android-framework-services/'+name+'.java'))],{stdio:'pipe'});
 const namespace=await processNamespace(root,1),messages=[];
 const child=spawn(path.join(home,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-Djava.awt.headless=true','-cp',cp,'maclauncher.android.BootMetadataProbe',path.resolve(runtime),root,'42'],
  {env:{...process.env,...namespace.environment},stdio:['ignore','pipe','pipe','ignore','ignore','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'close');child.kill('SIGKILL');await stopped;}});
 let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
 const ended=once(child,'close');
 const initialized=new Promise((resolve,reject)=>{
  receive(child.stdio[5],message=>{messages.push(message);if(message.op==='identity')resolve(message);},reject);
  child.once('close',()=>reject(Error('Settings process ended before identity: '+stdout+'\n'+stderr)));
 });
 const hello=await initialized,peer={packageName:'org.example.window',processName:'org.example.window',pid:hello.pid,hostPid:hello.hostPid,uid:10023,hostUid:process.getuid()};
 await send(child.stdio[5],{schemaVersion:2,self:peer,bootCount:42,serviceOwners:{system:{packageName:'android',processName:'android.system'}}});
 const [code,signal]=await ended;assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);
 assert.match(stdout,/PASS initial boot metadata precedes lazy profile attachment/);
 assert.deepEqual(messages.map(message=>message.op),['identity'],'Boot metadata does not start a profile process');
});

test('independent launch supervisors serialize the same private boot transaction',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS boot-session identity and kernel lock');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'android-boot-workers-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'boot.json'),journal=path.join(root,'operations');
 await writePrivate(file,{session:'00000000-0000-0000-0000-000000000000',count:41});
 const script=`const fs=require('node:fs'),path=require('node:path'),profile=require(process.argv[1]);
 const original=profile.readPrivate;
 profile.readPrivate=async file=>{fs.appendFileSync(process.argv[3],process.pid+':enter\\n');
  await new Promise(resolve=>setTimeout(resolve,20));
  try{return await original(file);}finally{fs.appendFileSync(process.argv[3],process.pid+':leave\\n');}};
 require(process.argv[2]).bootCount({root:process.argv[4]}).then(count=>process.stdout.write(String(count))).catch(error=>{console.error(error);process.exitCode=1;});`;
 const invoke=()=>promisify(execFile)(process.execPath,['-e',script,require.resolve('../src/modules/android/platform-services/paths'),require.resolve('../src/modules/android/platform-services/boot-state'),journal,root]);
 const values=await Promise.all(Array.from({length:8},invoke));
 assert.deepEqual(values.map(value=>value.stdout),Array(8).fill('42'));
 const operations=(await fs.readFile(journal,'utf8')).trim().split('\n');
 assert.equal(operations.length,16);
 for(let index=0;index<operations.length;index+=2){
  const [pid,operation]=operations[index].split(':');assert.equal(operation,'enter');
  assert.equal(operations[index+1],pid+':leave','The private read/update transaction cannot overlap another controller');
 }
 const inode=(await fs.stat(path.join(root,'boot.lock'))).ino;
 assert.equal(await bootCount({root}),42);assert.equal((await fs.stat(path.join(root,'boot.lock'))).ino,inode);
 assert.equal((await readPrivate(file)).count,42);
});
