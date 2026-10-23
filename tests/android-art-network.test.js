const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('ART network transport retains the shared physical observer and immutable policy',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS Network and SystemConfiguration');
 const home=process.env.JAVA_HOME;if(!home)return t.skip('Set JAVA_HOME to the Java SDK used by the Android native supplier');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-network-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const {prepareNetworkPolicy}=await import('../src/modules/android/native/network-policy-source.mjs');prepareNetworkPolicy(output);
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const native=path.resolve(__dirname,'../src/modules/android/native'),art=path.resolve(__dirname,'../src/modules/android/art/native'),program=path.join(output,'network');
 run('/usr/bin/clang',['-std=c11','-fblocks','-Wall','-Wextra','-Werror','-Wno-error=deprecated-declarations','-I'+native,'-I'+art,'-I'+output,'-I'+home+'/include','-I'+home+'/include/darwin',path.join(__dirname,'fixtures/android-art/NetworkOwner.c'),path.join(native,'network-policy.c'),'-framework','Network','-framework','SystemConfiguration','-framework','CoreFoundation','-o',program]);
 assert.match(run(program,[]),/PASS shared network observer/);
});

test('original Bionic resolver queries the configured Mac DNS through the current ART supplier',{timeout:45000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_RESOLVER_PROBE:probe,ART_DNS_PROBE_NAME:hostname}=process.env;
 if(process.platform!=='darwin'||!payload||!probe||!hostname)return t.skip('Requires the ART supplier, original resolver probe and explicit DNS query name');
 const {spawn}=require('node:child_process'),{once}=require('node:events');
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const {nativeServiceReady,nativeServiceIdentity,nativeResolverIdentity}=await import('../src/modules/android/art/composition.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-resolver-')),children=[],signal=AbortSignal.timeout(35000);
 const retained=process.env.ANDROID_ART_NETWORK_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 t.after(async()=>{
  for(const child of children.toReversed())if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGTERM');}catch{}
  let timer;await Promise.race([Promise.allSettled(children.map(child=>child.closed)),new Promise(resolve=>timer=setTimeout(resolve,1500))]);clearTimeout(timer);
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
  await Promise.allSettled(children.map(child=>child.closed));
  if(retained)for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.log')))fs.copyFileSync(path.join(root,name),path.join(retained,name));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 });
 const state=path.join(root,'state'),profile=path.join(root,'profile'),byPid=path.join(root,'by-pid');
 for(const directory of[state,profile,byPid])fs.mkdirSync(directory,{mode:0o700});
 const env={...process.env,...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(profile,1)).environment,
  ART_DNS_PROBE_NAME:hostname,DYLD_LIBRARY_PATH:path.resolve(payload,'native'),DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
 const run=(command,args)=>{const result=spawnSync(command,args,{env,encoding:'utf8',timeout:10000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const propertiesRoot=path.join(root,'composition'),properties=path.join(propertiesRoot,'properties');
 const overlays=[['ro','/system/bin/resolver-probe',path.resolve(probe)],['ro','/system/bin/maclauncher-art-window',c.compositionRoot],
  ['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],
  ['ro','/apex/com.android.tethering/lib64/libcom.android.tethering.dns_helper.so',c.dnsPolicyLibrary],
  ['ro','/dev/__properties__',properties],['rw','/dev/socket/dnsproxyd',path.join(root,'dnsproxyd')],
  ['rw','/dev/socket/property_service',path.join(propertiesRoot,'sockets/property_service')],
  ['rw','/dev/socket/property_service_for_system',path.join(propertiesRoot,'sockets/property_service_for_system')]].map(row=>row.join('\t')+'\n').join('');
 const map=publishPathMap(state,'resolver-proof',prepareMountParents(overlays+layout({supplier,state}),path.join(root,'mounts')));
 const binderName='maclauncher.android.resolver-proof.'+require('node:crypto').randomUUID();
 const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--by-pid',byPid,'--host-module',c.hostLibrary,'--path-map',map,'--no-cache'];
 const identity=(name,uid)=>nativeServiceIdentity(name,'system_server',uid,String(uid),0);
 function start(name,command,args,{input=false,guest=true}={}){
  const file=path.join(root,name+'.log'),fd=fs.openSync(file,'w');
  const child=spawn(command,args,{env:guest?{...env,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'}:env,stdio:[input?'pipe':'ignore','pipe',fd],detached:true});fs.closeSync(fd);
  child.ownerName=name;child.closed=once(child,'close');child.closed.catch(()=>{});children.push(child);
  child.output='';child.stdout.on('data',bytes=>{child.output+=bytes;fs.appendFileSync(file,bytes);});return child;
 }
 function ready(child,marker){return new Promise((resolve,reject)=>{
  const cleanup=()=>{child.stdout.removeListener('data',observed);child.removeListener('close',closed);signal.removeEventListener('abort',aborted);};
  const observed=()=>{if(child.output.includes(marker)){cleanup();resolve();}};
  const closed=()=>{cleanup();reject(Error(child.ownerName+' stopped: '+fs.readFileSync(path.join(root,child.ownerName+'.log'),'utf8')));};
  const aborted=()=>{cleanup();reject(signal.reason);};
  child.stdout.on('data',observed);child.once('close',closed);signal.addEventListener('abort',aborted,{once:true});observed();
 });}
 const propertyService=start('properties',c.bootstrap,['serve',c.image,propertiesRoot,byPid],{guest:false});
 await ready(propertyService,'Original native property service ready');
 const binder=start('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName],{guest:false});run(c.bootstrap,['wait-binder',binderName]);
 run(c.linuxRun,[...base,'--identity-text',identity('resolver-linker',0),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig']);
 const server=start('resolver',c.linuxRun,[...base,'--identity-text',nativeResolverIdentity('resolver-server'),'/system/bin/resolver-probe','serve'],{input:true});
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(server.exitCode,null,'An original Binder service can start before ServiceManager registers');
 start('servicemanager',c.linuxRun,[...base,'--identity-text',identity('servicemanager',1000),'/system/bin/servicemanager']);
 await ready(server,'READY original resolver');
 const client=start('client',c.linuxRun,[...base,'--identity-text',identity('resolver-client',10001),'/system/bin/resolver-probe','client']);
 await nativeServiceReady(root,client,{signal,dependency:server});
 assert.match(client.output,/PASS original resolver query through configured Mac DNS/);
 assert.match(client.output,/PASS original Bionic DNS socket, nonroot configuration denial and shared advertising policy/);
 server.stdin.end('1');await nativeServiceReady(root,server,{signal});
 assert.match(server.output,/PASS original resolver cache retirement/);
 t.diagnostic('Original Bionic getaddrinfo resolved '+hostname+' through the configured Mac DNS');
});

test('original ART connectivity publication survives GC and retains native absence status',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_CONNECTIVITY_PROBE:probe,JAVA_HOME:jdk,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||![payload,probe,jdk,r8].every(Boolean))return t.skip('Requires ART, original WindowRoot probe, Java and R8');
 const {spawn}=require('node:child_process'),{once}=require('node:events');
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 if(process.env.ANDROID_ART_GUEST_LIBRARY)supplier.components.guestLibrary=path.resolve(process.env.ANDROID_ART_GUEST_LIBRARY);
 const c=supplier.components,{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const {nativeServiceReady,nativeServiceIdentity}=await import('../src/modules/android/art/composition.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-connectivity-')),children=[],signal=AbortSignal.timeout(45000);
 const retained=process.env.ANDROID_ART_NETWORK_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 t.after(async()=>{
  for(const child of children.toReversed())if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGTERM');}catch{}
  let timer;await Promise.race([Promise.allSettled(children.map(child=>child.closed)),new Promise(resolve=>timer=setTimeout(resolve,1500))]);clearTimeout(timer);
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
  await Promise.allSettled(children.map(child=>child.closed));
  if(retained)for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.log')))fs.copyFileSync(path.join(root,name),path.join(retained,name));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 });
 const env={...process.env,...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,TMPDIR:root};
 const run=(command,args)=>{const result=spawnSync(command,args,{env,encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);};
 const classes=path.join(root,'classes'),dex=path.join(root,'dex'),jar=path.join(root,'probe.jar'),state=path.join(root,'state'),composition=path.join(root,'composition'),byPid=path.join(composition,'by-pid');
 for(const dir of[classes,dex,state,byPid])fs.mkdirSync(dir,{recursive:true});
 const api=path.resolve(payload,'android-framework.jar');
 run(path.join(jdk,'bin/javac'),['--release','8','-cp',api,'-d',classes,path.join(__dirname,'fixtures/android-art/ConnectivityPublicationProbe.java')]);
 run(path.join(jdk,'bin/jar'),['cf',jar,'-C',classes,'.']);
 run(path.join(jdk,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',api,'--output',dex,jar]);
 const overlays=[['ro','/system/bin/connectivity-probe',path.resolve(probe)],['ro','/system/bin/maclauncher-art-window',c.compositionRoot],
  ['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],
  ['ro','/data/local/tmp/connectivity.dex',path.join(dex,'classes.dex')],['ro','/dev/__properties__',path.join(composition,'properties')],
  ['rw','/dev/socket/property_service',path.join(composition,'sockets/property_service')],['rw','/dev/socket/property_service_for_system',path.join(composition,'sockets/property_service_for_system')]].map(row=>row.join('\t')+'\n').join('');
 const map=publishPathMap(state,'connectivity',prepareMountParents(overlays+layout({supplier,state}),path.join(root,'mounts')));
 const binderName='maclauncher.android.connectivity-proof.'+require('node:crypto').randomUUID();
 const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--by-pid',byPid,'--host-module',c.hostLibrary,'--path-map',map,'--no-cache'];
 const identity=(name,uid)=>nativeServiceIdentity(name,uid>=10000?'untrusted_app':'system_server',uid,String(uid),0);
 function start(name,command,args,guest=true){
  const file=path.join(root,name+'.log'),fd=fs.openSync(file,'w');
  const child=spawn(command,args,{env:guest?{...env,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'}:env,stdio:['pipe','pipe',fd],detached:true});fs.closeSync(fd);
  child.ownerName=name;child.output='';child.closed=once(child,'close');child.closed.catch(()=>{});children.push(child);
  child.stdout.on('data',bytes=>{child.output+=bytes;fs.appendFileSync(file,bytes);});return child;
 }
 async function ready(child,name,marker){
  while(!fs.readFileSync(path.join(root,name+'.log'),'utf8').includes(marker)){
   assert.equal(child.exitCode,null,fs.readFileSync(path.join(root,name+'.log'),'utf8'));assert.equal(child.signalCode,null);signal.throwIfAborted();
   await new Promise(resolve=>setTimeout(resolve,20));
  }
 }
 const properties=start('properties',c.bootstrap,['serve',c.image,composition,byPid],false);await ready(properties,'properties','Original native property service ready');
 start('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName],false);run(c.bootstrap,['wait-binder',binderName]);
 run(c.linuxRun,[...base,'--identity-text',identity('linkerconfig',0),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig']);
 const manager=start('servicemanager',c.linuxRun,[...base,'--identity-text',identity('servicemanager',1000),'/system/bin/servicemanager']);
 const directory=start('directory',c.linuxRun,[...base,'--identity-text',identity('directory',1000),'/system/bin/maclauncher-art-window','--service-directory']);await nativeServiceReady(root,directory,{signal,dependency:manager});
 const window=start('window',c.linuxRun,[...base,'--identity-text',identity('window',1000),'/system/bin/connectivity-probe','root']);await ready(window,'window','READY original WindowRoot');
 env.BOOTCLASSPATH+=':/data/local/tmp/connectivity.dex';env.CLASSPATH+=':/data/local/tmp/connectivity.dex';
 const javaArgs=(mode,uid)=>[...base,'--identity-text',identity('connectivity-'+mode,uid),'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','maclauncher.android.ConnectivityPublicationProbe',mode,String(process.getuid())];
 const absent=start('absent',c.linuxRun,javaArgs('absent',10003));await nativeServiceReady(root,absent,{signal,dependency:manager});
 const missing=fs.readFileSync(path.join(root,'absent.log'),'utf8');assert.match(missing,/PASS original absent connectivity result/);assert.match(missing,/Original connectivity lookup failed: directory=No error entry=absent output=available/);
 const app=start('publisher',c.linuxRun,javaArgs('publish',10021));await ready(app,'publisher','READY original Java connectivity publication');
 const client=start('client',c.linuxRun,[...base,'--identity-text',identity('client',10003),'/system/bin/connectivity-probe','client']);await nativeServiceReady(root,client,{signal,dependency:app});
 assert.match(client.output,/PASS original cross-UID connectivity lookup/);app.stdin.end('1');await nativeServiceReady(root,app,{signal,dependency:manager});
});
