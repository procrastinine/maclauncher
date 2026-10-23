const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {prepareConnections}=require('../src/modules/android/service-processes');
const {prepareSandbox}=require('../src/modules/android/sandbox');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
const {paths}=require('../src/modules/android/platform-services/paths');

test('profile process-info follows authenticated lifecycle and retirement across controllers',{timeout:90000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-process-state-'))),children=new Set(),owners=[];
 const storage=await Promise.all(['system','keystore'].map(role=>paths(root,role)));
 t.after(async()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await Promise.allSettled(owners.map(owner=>owner.close()));await new Promise(r=>setTimeout(r,3000));await fs.rm(root,{recursive:true,force:true});await Promise.all(storage.map(value=>fs.rm(value.runRoot,{recursive:true,force:true})));});
 const privateRuntime=path.join(root,'runtime'),classes=path.join(root,'classes');await fs.mkdir(classes);
 await fs.cp(runtime,privateRuntime,{recursive:true,dereference:true,mode:require('node:fs').constants.COPYFILE_FICLONE,
  filter:file=>!['build','source','build-source.json','build-receipt.json'].includes(path.relative(runtime,file).split(path.sep)[0])});
 const source=path.resolve('src/modules/android/native/java'),cp=['android-host.jar','android-framework.jar'].map(file=>path.join(privateRuntime,file)).join(path.delimiter);
 const changes=['ProcessAuthority','PlatformServiceHost','framework/HostProcessServices','framework/HostProcessInfo','framework/HostActivityManager','framework/HostActivityService','framework/HostServices','framework/HostServiceDirectory','framework/HostAudioPermissions','bridge/Graphics'];
 const toolClasspath=cp+path.delimiter+path.resolve('src/modules/android/native/tools/*');
 execFileSync(home+'/bin/javac',['--release','21','-cp',toolClasspath,'-d',classes,...changes.map(file=>path.join(source,'maclauncher/android',file+'.java')),path.join(source,'com/android/server/am/HostUidObservers.java'),...['ProcessStateProbe','ProfileUidObserver','ProfileUidBindings'].map(name=>'tests/fixtures/android-platform-service/'+name+'.java')]);
 execFileSync(home+'/bin/java',['-cp',classes+path.delimiter+toolClasspath,'ProfileUidBindings',classes]);
 execFileSync(home+'/bin/jar',['--update','--file',path.join(privateRuntime,'android-host.jar'),'-C',classes,'.']);
 const key=path.join(root,'signer.p12');
 execFileSync(home+'/bin/keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Profile Package Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt'],{stdio:'pipe'});
 const signerClasspath=classes+path.delimiter+path.resolve('src/modules/android/native/tools/apksig.jar');
 execFileSync(home+'/bin/javac',['-cp',signerClasspath,'-d',classes,'tests/fixtures/android-framework-services/SignApkSet.java']);
 async function application(uid,name='org.example.window'){
  const data=path.join(root,'app-'+uid),files=path.join(data,'files'),cache=path.join(data,'cache');await fs.mkdir(files,{recursive:true});await fs.mkdir(cache,{recursive:true});
  const prepared=path.join(root,'android/apps','app-'+uid,'prepared'),apk=path.join(prepared,'app.apk');await fs.mkdir(prepared,{recursive:true});
  if(name==='org.maclauncher.metadata.fixture')await fs.copyFile(path.resolve('tests/fixtures/android-package-metadata/metadata.apk'),apk);
  else {const manifest=path.join(prepared,'AndroidManifest.xml');await fs.copyFile(path.resolve('tests/fixtures/android-framework-services/manifests/window.xml.bin'),manifest);execFileSync(home+'/bin/jar',['--create','--file',apk,'-C',prepared,'AndroidManifest.xml']);}
  await fs.rename(apk,apk+'.unsigned');execFileSync(home+'/bin/java',['-cp',signerClasspath,'SignApkSet',key,apk+'.unsigned',apk]);await fs.rm(apk+'.unsigned');
  await fs.copyFile(apk,path.join(data,'app.apk'));
  const config={runtimeRoot:privateRuntime,packageName:name,filesRoot:files,cacheRoot:cache};
  const owner=await prepareConnections({config,game:{metadata:{packageName:name},sourceApk:apk,nativeRoot:path.join(privateRuntime,'native'),filesRoot:files},installed:{uid,services:[],release:async()=>{}},platformOptions:{systemServices:true,userDataDir:root,runtimeRoot:privateRuntime,javaPath:home+'/bin/java',moduleRoot:path.resolve('src/modules/android')}});owners.push(owner);
  const configFile=path.join(data,'launch.json');await fs.writeFile(configFile,'{}');
  const isolated=await prepareSandbox({javaPath:home+'/bin/java',config,configFile,dataRoot:data,blockNetwork:true,localSockets:owner.sandbox.localSockets});
  const child=spawn(isolated.command,[...isolated.prefix,...isolated.javaArguments,...frameworkJvmOptions,'-cp',cp,'maclauncher.android.ProcessStateProbe',privateRuntime,data,name],{cwd:files,env:isolated.environment,stdio:owner.stdio(['pipe','pipe','pipe'])});children.add(child);
  let stdout='',stderr='';const lines=[],waiters=[];let tail='';
  child.stderr.on('data',value=>stderr+=value);
  child.stdout.on('data',value=>{stdout+=value;tail+=value;let end;while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end).trim();tail=tail.slice(end+1);if(line==='READY'||line==='OK'){if(waiters.length)waiters.shift().resolve(line);else lines.push(line);}}});
  const completion=once(child,'close');child.on('close',()=>{children.delete(child);for(const waiter of waiters.splice(0))waiter.reject(Error(stdout+'\n'+stderr));});
  const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
  await once(child,'spawn');await owner.connect(child);assert.equal(await next(),'READY');
  return {child,owner,async command(value){child.stdin.write(value+'\n');assert.equal(await next(),'OK');},async close(){await this.command('stop');const [code,signal]=await completion;assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);await owner.close();}};
 }
 const observedThrough=new Map();
 async function observed(uid,state){
  const file=path.join(storage[0].root,'data/files/uid-events.txt'),expected=uid+':'+state;
  let events='';const until=Date.now()+5000;
  do{events=await fs.readFile(file,'utf8');const lines=events.trim().split('\n'),index=lines.findIndex((line,index)=>index>(observedThrough.get(uid)??-1)&&line===expected);if(index>=0){observedThrough.set(uid,index);return;}await new Promise(r=>setTimeout(r,10));}while(Date.now()<until);
  assert.fail('Original system UID observer did not receive '+expected+'; observed '+events);
 }
 const first=await application(10031,'org.maclauncher.metadata.fixture'),second=await application(10032);
 const audioFile=path.join(storage[0].root,'data/files/audio-package-events.txt');let audio='';const audioDeadline=Date.now()+5000;
 do{audio=await fs.readFile(audioFile,'utf8');if(audio.includes('10031:org.maclauncher.metadata.fixture')&&audio.includes('10032:org.example.window'))break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<audioDeadline);
 assert.match(audio,/10031:org\.maclauncher\.metadata\.fixture/,'Original audio permission provider receives the first enrolled package');
 assert.match(audio,/10032:org\.example\.window/,'Original audio permission provider receives later enrollment without restart');
 await second.command('observe-denied');
 await first.command('prepare');
 await first.command('query:'+first.child.pid+':19');await second.command('query:'+first.child.pid+':19');
 await first.command('top');await second.command('query:'+first.child.pid+':2');
 await observed(10031,2);await second.command('uid:10031:2');
 await second.command('top');await observed(10032,2);await first.command('uid:10032:2');
 await first.command('background');await second.command('query:'+first.child.pid+':19');
 await observed(10031,19);await second.command('uid:10031:19');
 await second.command('invalid');await second.command('scores');await second.command('noscores');
 await first.close();await second.command('query:'+first.child.pid+':20');await observed(10031,20);await second.command('uid:10031:20');await second.command('uid:10032:2');await second.close();
});
