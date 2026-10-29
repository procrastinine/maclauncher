import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {startComposition} from './composition.mjs';
import {layout,applicationLayout,installedCodeInputs,installedCodeLayout,environment,applicationEnvironment,guestArguments,guestPackageSources,guestNativeLibraryDirectory,guestDataDirectory,guestHooksArchive,prepareMountParents,publishPathMap} from './layout.mjs';
import {prepareIsolation} from './isolation.mjs';
import {compositionCache} from './composition-cache.mjs';
import {processRunning as alive,stopProcess as stop,stopProcesses,waitForExit,retireAll,requireRetired,observeRetirement} from './process-retirement.mjs';
const require=createRequire(import.meta.url),Host=require('../host'),Writable=require('../../shared/writable-input'),Storage=require('../storage'),Preparation=require('../prepare'),Packages=require('../service-packages');
const execute=promisify(execFile);

/** ART replaces app execution only. Profile services, package identities,
 * account selection, clipboard authorization and process capabilities use the
 * ordinary launcher owners. The payload declares this entry only on delivery. */
export async function launch(entry,context,payload,dependencies={}){
 const timing=require('../launch-timing').createLaunchTiming(context.logger);
 let renderer=Host.angleBackend(context,payload);
 let vulkan=await timing.measure('vulkan',()=>(dependencies.resolveVulkan||require('../../shared/vulkan').resolve)(context));
 const supplier=require('./runtime').resolve(payload),java=await timing.measure('java',()=>Host.ensureJava(context,dependencies));
 const platformPayload=await timing.measure('platform-runtime',()=>require('../launch-policy').resolvePlatformRuntime({context,payload},dependencies));
 const apkPayload={...payload,profile:{...payload.profile,arm32Version:supplier.manifest.android.architectures.includes('armeabi-v7a')?1:0}};
 const prepared=await timing.measure('package',()=>(dependencies.prepare||Preparation.prepareApk)(entry,{userDataDir:context.userDataDir,payload:apkPayload,java,execution:'art',signal:context.signal,onToolProcessSpawn:context.onToolProcessSpawn,retain:true}));
 const release=await Preparation.retainPrepared(prepared),storage=Storage.storagePaths(context.userDataDir,entry.gameId);
 // Host runtime mounts and IPC are not Android application files. Keeping
 // their lifetime beside app data also leaves native inode initialization
 // independent of earlier runtime sessions.
 const directory=path.join(storage.runtimeRoot,'art',crypto.randomUUID());Writable.assertOwnDirectory(storage.root,directory);
 const sensorRoot=path.join(directory,'sensors');fs.mkdirSync(sensorRoot,{recursive:true,mode:0o755});
 const nativeState=path.join(directory,'native');fs.mkdirSync(nativeState,{recursive:true});
 const blockNetwork=require('../launch-policy').networkBlocked(context);
 const systemOptions=require('../launch-policy').platformServiceOptions({context,payload,platformPayload,java});
 const config=Host.launchConfig(entry,prepared,payload,context.runtimeSettings);
 require('../web-links').prepareLaunch(config,context,dependencies);
 let application,installed,installedPreparation,installedRetirement,system,systemPreparation,connections,connectionsPreparation,composition,compositionPreparation,binder,game,gamePreparation,retirement;
 const children=new Set();let cancelled=false;
 const releaseInstalled=()=>installedRetirement??=(async()=>{await (installed||await installedPreparation?.catch(()=>null))?.release();})();
 const retire=(phase,operation)=>observeRetirement(phase,operation,context.onRuntimeRetirementStage);
 const close=()=>{cancelled=true;return retirement??=Promise.resolve().then(async()=>{
  await retireAll([
   retire('application-eof',async()=>{game||=await gamePreparation?.catch(()=>null);if(alive(game)){game.stdio?.[5]?.end();await waitForExit(game,2000);}}),
   retire('application',()=>stop(game)),
   retire('connections',async()=>{connections||=await connectionsPreparation?.catch(()=>null);await connections?.close();}),
   retire('composition',async()=>{composition||=await compositionPreparation?.catch(()=>null);await composition?.close();}),
   retire('children',()=>stopProcesses(children)),
   retire('system',async()=>{await (system||await systemPreparation?.catch(()=>null))?.close();}),
   async()=>{
    requireRetired([game,...children]);
    await retireAll([retire('installed-packages',releaseInstalled),retire('prepared',release),retire('directory',()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:4,retryDelay:25}))]);
   }
  ]);
 });};
 const abort=()=>{void close().catch(error=>context.logger?.warn?.('[android] Native process retirement: '+error.message));};context.signal?.addEventListener('abort',abort,{once:true});
 try{
  systemPreparation=require('../platform-services/client').prepare({...systemOptions,role:'system',access:'game',signal:context.signal,logger:context.logger});
  system=await systemPreparation;
  if(cancelled)throw Error('Android native launch was cancelled');
  void timing.measure('platform-services',()=>system.ready).catch(()=>{});
  ({renderer,vulkan}=await timing.measure('gles-provider',()=>require('../graphics-selection').resolveGraphics(
    entry,context,payload,prepared.metadata,{renderer,vulkan},dependencies)));
  if(cancelled)throw Error('Android native launch was cancelled');
  installedPreparation=timing.measure('installed-packages',()=>Packages.prepareInstalled(entry,prepared,context,apkPayload,java,{prepare:(value,options)=>Preparation.prepareApk(value,{...options,execution:'art'})}));
  installedPreparation.catch(()=>{});
  await timing.measure('media-inputs',()=>require('../media-inputs').configureLaunch(config,entry,context,payload,dependencies.mediaSelection));
  await timing.measure('metadata',()=>require('../package-metadata').applyLaunchIdentity(config,entry,prepared,payload,java,context));
  const iconHelper=path.join(payload.root,'native/android-application-icon');
  application=await timing.measure('application',()=>require('../application').prepare({executablePath:supplier.components.presenter,directory:path.join(storage.root,'application'),title:config.title,iconFile:config.iconFile,iconHelper:fs.existsSync(iconHelper)?iconHelper:null,signal:context.signal}));
  const graphics=await timing.measure('graphics',()=>context.getGameEffectsEnvironment()),sharedGraphics=dependencies.sharedGraphicsRoot||require('../../shared/reshade').runtimeRoot(context.app);
  installed=await installedPreparation;
  context.signal?.throwIfAborted();
  config.googleProviderCompatibility=installed.google?.enabled?1:0;
  config.networkAllowed=blockNetwork?0:1;
  // Preserve inherited account/keystore capabilities. The system service lease
  // is also borrowed by native composition; it remains one profile owner.
  const serviceLaunch=async(service,serviceConfig,stdio)=>startApp(service.prepared,service.storage,service.record.uid,{...serviceConfig,networkAllowed:config.networkAllowed,allowAds:config.allowAds,webLinksAllowed:config.webLinksAllowed,serviceProcess:true},stdio);
  connections=await (connectionsPreparation=timing.measure('service-connections',()=>require('../service-processes').prepareConnections({userDataDir:context.userDataDir,installed:{...installed,release:releaseInstalled},game:prepared,config,signal:context.signal,logger:context.logger,...require('../launch-policy').serviceOptions({context,payload,platformPayload,java,installed}),platformOwners:{system},launchService:serviceLaunch})));
  await timing.measure('sensor-storage',()=>execute(supplier.components.bootstrap,['initialize',String(installed.uid),sensorRoot],{signal:context.signal}));
  const binderName='maclauncher.android.art.'+crypto.randomUUID();
  const appMap=applicationLayout({packageName:prepared.metadata.packageName,dataRoot:storage.dataRoot,sourceApks:prepared.sourceApks||[prepared.sourceApk],nativeRoot:prepared.nativeRoot,nativeAbi:prepared.metadata.nativeAbi});
  // Enroll persistent app aliases before creating the native runtime's own
  // filesystem. Its linker namespaces and service data retain their original
  // Android owners while the private host session stays beside app data.
  await timing.measure('application-storage',()=>execute(supplier.components.bootstrap,['initialize',String(installed.uid),storage.dataRoot],{signal:context.signal}));
  const baseMap=layout({supplier,state:nativeState})+appMap;
  const nativeCache=await timing.measure('composition-cache',()=>compositionCache(context.userDataDir,supplier,context.signal));
  const isolated=await timing.measure('sandbox',()=>prepareIsolation({supplier,payload,directory,userDataDir:context.userDataDir,dataRoot:storage.dataRoot,prepared,application,installedPackages:connections.sandbox.installedPackages,physicalDataRoots:installed.services.map(service=>service.storage.dataRoot),graphics,sharedGraphics,binderName,localSockets:connections.sandbox.localSockets?.connect||[],blockNetwork,media:config,signal:context.signal,vulkan,compositionCache:nativeCache}));
  // Darwin confstr returns TMPDIR verbatim. Native framework temporary-file
  // owners append filenames to that directory, including its trailing slash.
  const env={...isolated.environment,...environment(supplier),MACLAUNCHER_ANDROID_EGL_CACHE:nativeCache,TMPDIR:path.join(directory,'ipc')+path.sep};fs.mkdirSync(env.TMPDIR,{recursive:true});
  const spawnProcess=(name,command,args,options,observation={})=>{
   if(cancelled)throw Error('Android native launch was cancelled');
   const child=(dependencies.spawnProcess||spawn)(isolated.command,[...isolated.prefix,command,...args],{...options,cwd:storage.filesRoot,env:{...env,...options.env},detached:true});children.add(child);child.once('close',()=>children.delete(child));context.onToolProcessSpawn?.(child,{stopOnLauncherExit:true,ownerName:name,...observation});return child;
  };
  const senderIdentity=supplier.manifest.binderSenderIdentityVersion;
  if(senderIdentity!==undefined&&senderIdentity!==1)throw Error('Unsupported Android Binder identity version');
  const processTable=path.join(directory,'composition','by-pid');
  if(senderIdentity===1)Writable.assertOwnDirectory(directory,processTable);
  const binderLog=path.join(directory,'binder.log'),log=fs.openSync(binderLog,'w');try{binder=spawnProcess('binder',supplier.components.binder,[...(payload.profile?.processIdentityVersion===1?['--host-module',supplier.components.hostLibrary]:[]),...(senderIdentity===1?['--process-table',processTable]:[]),'--service',binderName],{env,stdio:['ignore',log,log]},{logFiles:[{file:binderLog,channels:['stdout','stderr']}]});}finally{fs.closeSync(log);}
  try{await execute(supplier.components.bootstrap,['wait-binder',binderName],{timeout:6000,signal:context.signal});}
  catch(error){
   const file=fs.openSync(path.join(directory,'binder.log'),'r');let details;
   try{const size=fs.fstatSync(file).size,bytes=Buffer.alloc(Math.min(size,16384));fs.readSync(file,bytes,0,bytes.length,Math.max(0,size-bytes.length));details=bytes.toString().trim();}finally{fs.closeSync(file);}
   throw Error(details||'Android native Binder could not start',{cause:error});
  }
  composition=await (compositionPreparation=timing.measure('composition',()=>startComposition({directory,supplier,payload,sharedGraphics,binderName,env,owner:system,appUid:installed.uid,appLabel:config.title,appIcon:config.iconFile,application,kernelRuntime:nativeState,pathMap:baseMap,cache:nativeCache,spawnProcess,signal:context.signal,sensorRoot,media:config,networkAllowed:!blockNetwork,allowAds:config.allowAds===1,measure:timing.measure,viewport:{width:config.width,height:config.height,densityDpi:require('../device-profile.json').display.densityDpi}})));
  composition.failure.catch(error=>{context.logger?.error?.('[android] Native composition: '+error.message);abort();});
  async function startApp(app,appStorage,uid,launch,stdio){
   context.signal?.throwIfAborted();const processDirectory=path.join(directory,'process-'+crypto.randomUUID());fs.mkdirSync(processDirectory,{recursive:true});
   const sourceApks=app.sourceApks||[app.sourceApk],packageName=app.metadata.packageName,guestBase='/data/app/'+packageName,guestData=guestDataDirectory(packageName);
   const rows=[composition.map,applicationLayout({packageName,dataRoot:appStorage.dataRoot,sourceApks,nativeRoot:app.nativeRoot,nativeAbi:app.metadata.nativeAbi}),installedCodeLayout(connections.sandbox.installedPackages)];
   const map=(mode,guest,host)=>{if(/[\0\r\n\t]/.test(guest+host))throw Error('Invalid Android input path');rows.push([mode,guest,host].join('\t')+'\n');};
   // Only enrolled app/relay processes need the canonical RPC envelope.
   // Unmodified image services retain their matching image Binder library.
   map('ro','/system/lib64/libbinder.so',supplier.components.binderLibrary);
   map('ro',guestBase+'/assets',app.assetsRoot);map('ro',guestBase+'/resources',app.resourcesRoot);
   for(const socket of connections.sandbox.localSockets?.connect||[])map('rw',socket,socket);
   const sensorSource=guestData+'/cache/maclauncher-sensors',guestConfig=guestData+'/cache/maclauncher-launch.json';
   const browserCapability=crypto.randomUUID(),browserSocket='/dev/socket/maclauncher-webkit';
   await composition.browserRegistration({token:browserCapability,root:appStorage.dataRoot,guest:guestData,network:!blockNetwork});
   map('rw',browserSocket,composition.browserSocket);
   if(!launch.serviceProcess)map('rw',sensorSource,sensorRoot);
   const actual={...launch,runtimeUid:uid,browserSocket,browserCapability,browserProviderSource:guestHooksArchive,...(!launch.serviceProcess?{sensorSource}:{}),packageName,versionName:app.metadata.versionName||"unknown",versionCode:Number(app.metadata.versionCode||0),title:app.metadata.label||packageName,nativeServices:!launch.serviceProcess,sourceApk:guestBase+'/base.apk',sourceApks:guestPackageSources(packageName,sourceApks),nativeAbi:app.metadata.nativeAbi,nativeLibraryDir:guestNativeLibraryDirectory(packageName,app.metadata.nativeAbi),assetsRoot:guestBase+'/assets',resourcesRoot:guestBase+'/resources',filesRoot:guestData+'/files',cacheRoot:guestData+'/cache',display:composition.display};
   // Mount below the existing private application namespace. Read-only VFS
   // inputs are root-owned; enclosing host state remains private to this user.
   const browser=require('../web-links').prepareLaunch(actual,context,dependencies);
   const file=path.join(processDirectory,'launch.json');Writable.atomicWrite(file,JSON.stringify(actual)+'\n',{root:processDirectory});fs.chmodSync(file,0o444);map('ro',guestConfig,file);
   const mapFile=publishPathMap(nativeState,path.basename(processDirectory),prepareMountParents(rows.join(''),path.join(processDirectory,'mount-parents')));
   if(launch.serviceProcess)await execute(supplier.components.bootstrap,['initialize',String(uid),appStorage.dataRoot],{signal:context.signal});
   // The same original read-only code owner applies to every enrolled APK and
   // native directory, including peer packages parsed by PackageManager. The
   // peer application's private data retains its own UID and stays unmapped.
   await timing.measure('installed-code',()=>execute(supplier.components.bootstrap,['initialize-package',app.root,...installedCodeInputs(connections.sandbox.installedPackages)],{signal:context.signal}));
   const childIsolation=await prepareIsolation({supplier,payload,directory,userDataDir:context.userDataDir,policyDirectory:processDirectory,dataRoot:appStorage.dataRoot,prepared:app,application,installedPackages:connections.sandbox.installedPackages,graphics,sharedGraphics,binderName,localSockets:connections.sandbox.localSockets?.connect||[],blockNetwork,media:launch,signal:context.signal,vulkan,angleBackend:renderer});
   const descriptors=[...stdio];while(descriptors.length<8)descriptors.push('ignore');descriptors[3]=actual.webLinksAllowed?'pipe':'ignore';descriptors[6]=launch.serviceProcess?'ignore':composition.input;descriptors[7]=composition.control;
   const appCache=path.join(appStorage.cacheRoot,'art-code');Writable.assertOwnDirectory(appStorage.root,appCache);
   const args=guestArguments({supplier,nativeAbi:app.metadata.nativeAbi,binderName,pathMap:mapFile,cache:appCache,uid,packageName,processName:launch.processName||packageName,config:guestConfig,graphics:path.join(payload.root,'native/angle'),display:path.join(directory,'composition/display.sock'),byPid:path.join(directory,'composition/by-pid'),stdio:descriptors});
   if(cancelled)throw Error("Android native launch was cancelled");
   // The shared host process owner uses this capability directly. It is not
   // imported into Android's guest descriptor table above.
   const processEnvironment=applicationEnvironment(supplier,{...env,...childIsolation.environment,MACLAUNCHER_ANDROID_EGL_CACHE:appStorage.cacheRoot});
   const query=require('../process-channel').prepareProcessQuerySpawn(require('../launch-arguments').processOptions(context,{cwd:appStorage.filesRoot,env:processEnvironment,executablePath:supplier.components.linuxRun,graphicsExecutable:supplier.components.linuxRun,networkIsolationApplied:true,stdio:descriptors},launch.serviceProcess),path.join(payload.root,'native/android-supervisor-send'));
   const child=await context.spawnDetachedChecked(childIsolation.command,[...childIsolation.prefix,supplier.components.linuxRun,...args],query.options);
   query.attach(child);
   browser.attach(child,{executablePath:application.executablePath,launchedAt:composition.launchedAt,presentation:composition.presenter});
   children.add(child);child.once('close',()=>{children.delete(child);void composition.browserRegistration({token:browserCapability,retire:true}).catch(error=>context.logger?.warn?.('[android] Browser registration retirement: '+error.message));});if(cancelled){await stop(child);throw Error("Android native launch was cancelled");}return child;
  }
  game=await (gamePreparation=timing.measure('spawn',()=>startApp(prepared,storage,installed.uid,config,connections.stdio(['ignore','ignore','pipe','pipe']))));
  await timing.measure('connect',()=>connections.connect(game,{presentation:composition.presenter}));
  timing.finish();
  const finished=()=>{game.removeListener('exit',finished);game.removeListener('close',finished);context.signal?.removeEventListener('abort',abort);game.runtimeRetirement=close();void game.runtimeRetirement.catch(error=>context.logger?.warn?.('[android] Native process retirement: '+error.message));};game.once('exit',finished);game.once('close',finished);if(!alive(game))finished();
  return Host.captureStderr(game,storage.logFile,storage.root,context.logger,{frameSource:composition.presenter.stderr});
 }catch(error){context.signal?.removeEventListener('abort',abort);try{await close();}catch(cleanup){context.logger?.warn?.('[android] Native process retirement: '+cleanup.message);}throw error;}
}
