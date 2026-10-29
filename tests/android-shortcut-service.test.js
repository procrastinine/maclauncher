const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Original ShortcutService keeps its package policy, quota, icon and durable state',{timeout:90000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the built Android runtime and JDK21');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-shortcuts-')));let service,child,appChild,storage,lock;
 t.after(async()=>{for(const process of [child,appChild])if(process&&process.exitCode==null&&process.signalCode==null)process.kill('SIGKILL');await service?.close();await lock?.close();if(service)await new Promise(resolve=>setTimeout(resolve,3000));if(storage)fs.rmSync(storage.runRoot,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});});
 const source=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services');
 const cp=[dir,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar'),path.resolve(runtime,'apksig.jar'),source+'/tools/*'].join(path.delimiter);
 const run=(name,args)=>{const r=spawnSync(home+'/bin/'+name,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',dir,fixture+'/SignApkSet.java']);
 const key=dir+'/signer.p12';run('keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Shortcut Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 const prepared=path.join(dir,'android/apps/shortcuts/prepared');fs.mkdirSync(prepared,{recursive:true});const apk=path.join(prepared,'base.apk');
 run('java',['-cp',cp,'SignApkSet',key,path.resolve('tests/fixtures/android-package-metadata/metadata.apk'),apk]);
 run('javac',['--release','21','-cp',cp,'-d',dir,source+'/framework/ServicePortability.java',source+'/framework/PendingIntentCalls.java',
  ...['HostShortcuts','HostUserService','HostPackages','HostRemoteServices','HostFilesystem','HostActivityManager','HostAppOps','HostPermissions','HostProcessServices','HostProcessInfo','HostServices','HostServiceDirectory'].map(name=>source+'/java/maclauncher/android/framework/'+name+'.java'),
  source+'/java/com/android/server/am/HostUidObservers.java',
  source+'/java/maclauncher/android/bridge/Graphics.java',
  source+'/java/com/android/server/pm/HostShortcutService.java',source+'/java/com/android/server/usage/HostUsageEvents.java',
  fixture+'/ShortcutBindings.java',fixture+'/OriginalShortcutsProbe.java',fixture+'/../android-window-session/RuntimeFixture.java',fixture+'/../android-platform-service/ProcessStateProbe.java']);
 run('java',['-cp',cp,'ShortcutBindings',path.resolve(runtime,'android-framework.jar'),dir]);
 const {paths}=require('../src/modules/android/platform-services/paths'),{startProfileService}=require('../src/modules/android/platform-services/jvm');
 const {prepareSandbox}=require('../src/modules/android/sandbox'),{send,processIdentity}=require('../src/modules/android/process-channel');
 const {spawn}=require('node:child_process'),{once}=require('node:events');
 storage=await paths(dir,'system');lock=await fs.promises.open(storage.lock,'w',0o600);
 service=await startProfileService({userDataDir:dir,runtimeRoot:path.resolve(runtime),runtimeIdentity:require('./helpers/android-java').runtimeIdentity(path.resolve(runtime)),javaPath:path.join(home,'bin/java'),moduleRoot:path.resolve('src/modules/android'),role:'system'},storage,lock.fd);await service.ready;
 const data=path.join(dir,'android/apps/shortcuts/data'),files=path.join(data,'files'),cache=path.join(data,'cache');fs.mkdirSync(files,{recursive:true});fs.mkdirSync(cache);
 const program=path.join(data,'fixture.jar');run('jar',['--create','--file',program,...['maclauncher','com','android'].filter(name=>fs.existsSync(path.join(dir,name))).flatMap(name=>['-C',dir,name])]);
 const profile=JSON.parse(fs.readFileSync(path.resolve(runtime,'runtime.json'))).profile;
 // The quota observer belongs to the shared profile ActivityManager. Keep a
 // separately authenticated application alive for its real UID transitions.
 const appData=path.join(dir,'android/apps/shortcut-client/data'),appFiles=path.join(appData,'files'),appCache=path.join(appData,'cache');fs.mkdirSync(appFiles,{recursive:true});fs.mkdirSync(appCache);
 const appProgram=path.join(appData,'fixture.jar');fs.copyFileSync(program,appProgram);
 const appConfig={runtimeRoot:path.resolve(runtime),filesRoot:appFiles,cacheRoot:appCache,sourceApk:apk},appConfigFile=path.join(appData,'launch.json');fs.writeFileSync(appConfigFile,'{}');
 const appSandbox=await prepareSandbox({javaPath:path.join(home,'bin/java'),config:appConfig,configFile:appConfigFile,dataRoot:appData,userDataDir:dir,processIdentityVersion:profile.processIdentityVersion,blockNetwork:true,localSockets:{connect:[service.socketPath]}});
 appChild=spawn(appSandbox.command,[...appSandbox.prefix,...appSandbox.javaArguments,...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-cp',[appProgram,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter),'maclauncher.android.ProcessStateProbe',path.resolve(runtime),appData,'org.maclauncher.metadata.fixture'],{cwd:appFiles,env:appSandbox.environment,stdio:['pipe','pipe','pipe','ignore','ignore','pipe']});
 let appStdout='',appStderr='',appReadyResolve;const appReady=new Promise(resolve=>appReadyResolve=resolve),appEnded=once(appChild,'exit');
 appChild.stdout.on('data',v=>{appStdout+=v;if(/(?:^|\n)READY\r?\n/.test(appStdout))appReadyResolve();});appChild.stderr.on('data',v=>appStderr+=v);
 await once(appChild,'spawn');const appIdentity=await processIdentity(appChild,{version:profile.processIdentityVersion}),appPeer={packageName:'org.maclauncher.metadata.fixture',processName:'org.maclauncher.metadata.fixture',...appIdentity,uid:12000,hostUid:process.getuid()};
 await service.enroll(appPeer,{packages:[{packageName:appPeer.packageName,uid:appPeer.uid,sourceApks:[apk],dataRoot:appData,nativeRoot:path.resolve(runtime,'native'),firstInstallTime:1,lastUpdateTime:1,...(appIdentity.androidId?{androidId:appIdentity.androidId}:{})}]});
 await send(appChild.stdio[5],{schemaVersion:2,self:appPeer,system:{identity:service.identity,socketPath:service.socketPath}});
 await Promise.race([appReady,appEnded.then(([code,signal])=>assert.fail('Application stopped before readiness: '+code+' '+signal+'\n'+appStdout+'\n'+appStderr))]);
 for(const mode of ['publish','restore']){
  const config={runtimeRoot:path.resolve(runtime),filesRoot:files,cacheRoot:cache,sourceApk:apk},configFile=path.join(data,'launch.json');fs.writeFileSync(configFile,'{}');
  const isolated=await prepareSandbox({javaPath:path.join(home,'bin/java'),config,configFile,dataRoot:data,userDataDir:dir,processIdentityVersion:profile.processIdentityVersion,blockNetwork:true,localSockets:{connect:[service.socketPath]}});
  child=spawn(isolated.command,[...isolated.prefix,...isolated.javaArguments,...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',[program,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter),'maclauncher.android.OriginalShortcutsProbe',path.resolve(runtime),data,mode,apk],{cwd:files,env:isolated.environment,stdio:['pipe','pipe','pipe','ignore','ignore','pipe']});
  let stdout='',stderr='',transitionRequested=false,transitionError,transition=Promise.resolve();child.stdout.on('data',v=>{stdout+=v;const states=/^SHORTCUT_QUOTA_READY:(\d+):(\d+)$/m.exec(stdout);if(states&&!transitionRequested){transitionRequested=true;transition=(async()=>{await service.processState(appPeer,Number(states[2]));await service.processState(appPeer,Number(states[1]));await service.processState(appPeer,Number(states[2]));child.stdin.write('foreground\n');})().catch(error=>{transitionError=error;child.kill('SIGKILL');});}});child.stderr.on('data',v=>stderr+=v);const ended=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  try{
   await once(child,'spawn');const identity=await processIdentity(child,{version:profile.processIdentityVersion}),peer={packageName:'android',processName:'android.shortcuts.fixture',...identity,uid:1000,hostUid:process.getuid(),securityContext:'u:r:system_server:s0'};
   await service.enroll(peer);
   await send(child.stdio[5],{schemaVersion:2,self:peer,system:{identity:service.identity,socketPath:service.socketPath}});
   const [code,signal]=await ended;await transition;assert.ifError(transitionError);assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);assert.match(stdout,/PASS original ShortcutManager\/RPC/);await service.retire(peer);
  }finally{clearTimeout(timer);if(child.exitCode==null&&child.signalCode==null){child.kill('SIGKILL');await ended;}}
 }
 appChild.stdin.end('stop\n');const [appCode,appSignal]=await appEnded;assert.equal(appCode,0,appSignal+'\n'+appStdout+'\n'+appStderr);assert.match(appStdout,/OK/);await service.retire(appPeer);
});
