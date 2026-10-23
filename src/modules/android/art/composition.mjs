// Original native composition/media lifetime within one enrolled app session.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {once} from 'node:events';
import {prepareMountParents,publishPathMap} from './layout.mjs';
import {boundedLog} from '../../shared/runtime/bounded-log.js';
import {processIdentity,MAX_FRAME} from '../process-channel.js';
import net from 'node:net';
import {stopProcess,stopProcesses,retireAll,requireRetired} from './process-retirement.mjs';
export function nativeServiceIdentity(name,context,uid=1000,groups='1003 1004 3009',capabilities=8388608){
 return `service\t${name}\nuid\t${uid}\ngid\t${uid}\ngroups\t${groups}\ncap_effective\t${capabilities}\ncap_permitted\t${capabilities}\ncap_bounding\t${capabilities}\nseclabel\tu:r:${context}:s0\n`;
}
/** The combined window/network owner embeds original netd's resolver. Like
 * netd.rc it needs CHOWN for per-app route-probe socket ownership; SYS_NICE
 * remains its existing scheduling capability. These are guest credentials,
 * independent of the Mac principal and of application process credentials. */
export function nativeResolverIdentity(name='window-root'){
 return nativeServiceIdentity(name,'system_server',1000,'1003 1004 3009',8388608|1);
}
/** AppKit's native frameworks use Darwin's temporary-directory query. Set the
 * existing private-storage adapter after sandbox-exec's protected entry, just
 * as the JVM entry does; Linux guest services keep their original entry. */
export function nativePresenterEntry(payload,application,args,env){
 const storage=path.join(payload.root,'native/libandroid-storage.dylib');
 const libraries=[...new Set([...(fs.existsSync(storage)?[storage]:[]),...(env.DYLD_INSERT_LIBRARIES||'').split(path.delimiter).filter(Boolean)])];
 return libraries.length?{command:'/usr/bin/env',args:['DYLD_INSERT_LIBRARIES='+libraries.join(path.delimiter),application.executablePath,...args]}:{command:application.executablePath,args};
}
export function nativePlatformAuthority(owner){
 const peer=owner.identity,fields=[owner.socketPath,String(peer.pid),String(peer.uid),peer.securityContext,peer.packageName,peer.processName];
 if(fields.some(value=>typeof value!=='string'||!value||value.includes('\0')))throw Error('Android platform authority is invalid');
 const bytes=Buffer.from(fields.join('\0')+'\0');if(bytes.length>MAX_FRAME)throw Error('Android platform authority exceeds the supported size');
 const header=Buffer.alloc(5);header[0]=49;header.writeUInt32BE(bytes.length,1);return Buffer.concat([header,bytes]);
}
// libuv owns this pipe's nonblocking writes and descriptor lifetime. A vanished
// presenter rejects outstanding registrations without throwing from app exits.
export function browserRegistrationWriter(fd,onFailure){
 const stream=new net.Socket({fd,readable:false,writable:true});
 stream.on('error',onFailure);
 return {
  send(value){const bytes=Buffer.from(JSON.stringify(value)),frame=Buffer.alloc(4+bytes.length);frame.writeUInt32LE(bytes.length);bytes.copy(frame,4);return new Promise((resolve,reject)=>stream.write(frame,error=>error?reject(error):resolve()));},
  close(){stream.destroy();}
 };
}
export function nativeServiceError(directory,name,code,signal){
 let details='';
 try{
  const descriptor=fs.openSync(path.join(directory,name+'.log'),'r');
  try{const size=fs.fstatSync(descriptor).size,bytes=Buffer.alloc(Math.min(size,8192));fs.readSync(descriptor,bytes,0,bytes.length,Math.max(0,size-bytes.length));details=bytes.toString('utf8').trim();}
  finally{fs.closeSync(descriptor);}
 }catch{}
 return Error('Android service '+name+' stopped ('+(signal??code??'unknown exit')+')'+(details?': '+details:''));
}
export function nativeServiceReady(directory,child,{failure,signal,dependency,dependencies=dependency?[dependency]:[]}={}){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const watched=dependencies.map(value=>({child:value,error:error=>done(error),exit:(code,exitSignal)=>done(nativeServiceError(directory,value.ownerName,code,exitSignal))}));
  const done=error=>{if(settled)return;settled=true;child.removeListener('error',errorExit);child.removeListener('close',exited);for(const value of watched){value.child.removeListener('error',value.error);value.child.removeListener('close',value.exit);}signal?.removeEventListener('abort',aborted);error?reject(error):resolve();};
  const errorExit=error=>done(error),exited=(code,exitSignal)=>done(code===0?null:nativeServiceError(directory,child.ownerName,code,exitSignal));
  const aborted=()=>done(signal.reason??Error('Android native launch was cancelled'));
  child.once('error',errorExit);child.once('close',exited);
  for(const value of watched){value.child.once('error',value.error);value.child.once('close',value.exit);}
  signal?.addEventListener('abort',aborted,{once:true});
  if(signal?.aborted)aborted();
  else if(watched.some(value=>value.child.exitCode!==null||value.child.signalCode!==null)){const value=watched.find(value=>value.child.exitCode!==null||value.child.signalCode!==null);value.exit(value.child.exitCode,value.child.signalCode);}
  else if(child.exitCode!==null||child.signalCode!==null)exited(child.exitCode,child.signalCode);
  failure?.catch(done);
 });
}
export async function startComposition({directory,supplier,payload,sharedGraphics,binderName,env,owner,appUid,appLabel,appIcon,application,kernelRuntime,pathMap,cache,spawnProcess,signal,viewport,networkAllowed,allowAds,sensorRoot,media={},scope='application',measure=(_name,operation)=>operation()}){
 if(!['application','graphics'].includes(scope))throw new TypeError('Invalid Android native composition scope');
 const graphicsOnly=scope==='graphics';
 const c=supplier.components;
 const platformReady=Promise.resolve(owner?.ready||owner);platformReady.catch(()=>{});
 if(typeof spawnProcess!=='function')throw new TypeError('Android native process owner is required');
 const root=path.join(directory,'composition');fs.mkdirSync(root,{recursive:true});
 fs.rmSync(path.join(root,'capture.png'),{force:true});
 const byPid=path.join(root,'by-pid');fs.mkdirSync(byPid,{recursive:true,mode:0o700});fs.rmSync(path.join(root,'properties'),{recursive:true,force:true});fs.rmSync(path.join(root,'sockets'),{recursive:true,force:true});const socket=path.join(root,'display.sock');fs.rmSync(socket,{force:true});
 const manifest=path.join(root,'manifest');fs.mkdirSync(manifest,{recursive:true});
 // Keep the image declarations; replace only the physical HAL suppliers.
 fs.cpSync(path.join(c.image,'vendor/etc/vintf/manifest'),manifest,{recursive:true});
 fs.rmSync(path.join(manifest,'hwc3.xml'),{force:true});fs.rmSync(path.join(manifest,'android.hardware.graphics.gralloc.ranchu.xml'),{force:true});
 for(const name of ['android.hardware.audio@7.1-impl.ranchu.xml','bluetooth_audio.xml'])fs.rmSync(path.join(manifest,name),{force:true});
 // Match AIM's physical-device overlay: Goldfish Codec2 requires the QEMU
 // decoder device. Advertising that absent store makes original Codec2Client
 // wait for it before it can select the image's complete software codecs.
 fs.rmSync(path.join(manifest,'android.hardware.media.c2@1.0-service-goldfish.xml'),{force:true});
 fs.rmSync(path.join(manifest,'android.hardware.sensors-multihal.xml'),{force:true});
 fs.cpSync(c.halManifests,manifest,{recursive:true});
 const maps=['/vendor/lib64/libandroid-log-stderr.so','/system/lib64/libandroid-log-stderr.so','/apex/com.android.hardware.power/lib64/libandroid-log-stderr.so','/apex/com.android.media.swcodec/lib64/libandroid-log-stderr.so'].map((p,i)=>{const file=path.join(root,'log-'+i+'.so');fs.copyFileSync(c.logLibrary,file);return ['ro',p,file];}).concat([['rw','/dev/socket/dnsproxyd',path.join(root,'sockets/dnsproxyd')],['rw','/dev/socket/property_service',path.join(root,'sockets/property_service')],['rw','/dev/socket/property_service_for_system',path.join(root,'sockets/property_service_for_system')],['ro','/dev/__properties__',path.join(root,'properties')],['ro','/vendor/etc/vintf/manifest',manifest],['ro','/vendor/lib64/egl/libGLES_aim.so',path.join(c.halRoot,'libgles.so')],['ro','/vendor/lib64/hw/mapper.aim.so',path.join(c.halRoot,'libmapper.so')],['ro','/vendor/bin/hw/android.hardware.graphics.allocator-service.aim',path.join(c.halRoot,'allocator-service')],['ro','/vendor/bin/hw/android.hardware.graphics.composer3-service.aim',c.composerHal]]);
 maps.unshift(['ro','/system/bin/maclauncher-art-window',c.compositionRoot]);
 if(!graphicsOnly)maps.unshift(['ro','/vendor/bin/hw/android.hardware.sensors-service.aim',c.sensorsHal],['ro','/dev/maclauncher-sensor-source',sensorRoot]);
 if(c.serviceWaiter)maps.unshift(['ro','/system/bin/maclauncher-art-service-wait',c.serviceWaiter]);
 maps.unshift(['ro','/apex/com.android.tethering/lib64/libcom.android.tethering.dns_helper.so',c.dnsPolicyLibrary]);
 maps.unshift(['ro','/vendor/etc/vintf/manifest.xml',c.vendorManifest],['ro','/vendor/bin/hw/android.hardware.audio.service-aidl.aim',path.join(c.halRoot,'audio-service')]);
 const map=prepareMountParents(maps.map(row=>row.join('\t')).join('\n')+'\n'+pathMap,path.join(root,'mount-parents'));const mapFile=publishPathMap(kernelRuntime,'composition',map);
 // Open a real pipe capability without a Node readable stream consuming its
 // bytes before the app inherits it. The pathname is retired immediately.
 const pipe=path.join(root,'input.pipe');fs.rmSync(pipe,{force:true});execFileSync('/usr/bin/mkfifo',['-m','600',pipe]);
 const inputRead=fs.openSync(pipe,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK),inputWrite=fs.openSync(pipe,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);fs.unlinkSync(pipe);
 const controlPipe=path.join(root,'control.pipe');fs.rmSync(controlPipe,{force:true});execFileSync('/usr/bin/mkfifo',['-m','600',controlPipe]);const controlRead=fs.openSync(controlPipe,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK),controlWrite=fs.openSync(controlPipe,fs.constants.O_WRONLY);fs.unlinkSync(controlPipe);
 // Only the launcher holds this registration writer. Guest control/input
 // descriptors cannot mint another application's browser storage capability.
 const browserPipe=path.join(root,'browser.pipe');execFileSync('/usr/bin/mkfifo',['-m','600',browserPipe]);
 const browserRead=fs.openSync(browserPipe,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK),browserWrite=fs.openSync(browserPipe,fs.constants.O_WRONLY);fs.unlinkSync(browserPipe);
 const browserSocket=path.join(root,'browser.sock');
 const descriptors=new Set([inputRead,inputWrite,controlRead,controlWrite,browserRead]);
 let closing=false,failed;const failure=new Promise((resolve,reject)=>{failed=reject;});failure.catch(()=>{});
 const registrationWriter=browserRegistrationWriter(browserWrite,error=>{if(!closing)failed(error);});
 const browserRegistration=value=>closing?Promise.resolve():registrationWriter.send(value);
 const mediaNames=new Set(['system-suspend','mediametrics','audio-hal','audioserver','mediaextractor','media-swcodec','mediaserver','sensors-hal','sensorservice']);const mediaFailures=[];
 const report=(name,error)=>{if(mediaNames.has(name)){mediaFailures.push({service:name,error:String(error)});console.error('Native media service: '+name+': '+error);}else failed(error);};
 const children=[];
 function child(name,command,args,environment=env,transient=false){
  if(closing)throw Error('Composition is closing');
  const guestProgram=args.find(value=>/^\/(system|vendor|apex)\//.test(value))||args.at(-1);
  if(command.endsWith('/linux-run')&&name!=='linkerconfig')environment={...environment,LD_PRELOAD:guestProgram.startsWith('/vendor/')?'/vendor/lib64/libandroid-log-stderr.so':guestProgram.startsWith('/apex/')?guestProgram.split('/').slice(0,3).join('/')+'/lib64/libandroid-log-stderr.so':'/system/lib64/libandroid-log-stderr.so'};
  const observed=name==='presenter',file=path.join(root,name+'.log');
  const log=observed?boundedLog(file):fs.openSync(file,'w');
  const inherited=observed?[inputWrite,controlRead,browserRead]:name==='window-root'?['ignore','ignore','pipe']:[];
  let p;try{p=spawnProcess(name,command,args,{env:environment,stdio:['pipe',observed?'pipe':log,observed?'pipe':log,...inherited],detached:true},{logFiles:[{file,channels:['stdout','stderr']}]});}
  catch(error){if(observed)log.close();else fs.closeSync(log);throw error;}
  if(observed){
   let logFailed=false;
   const data=bytes=>{if(logFailed)return;try{log.write(bytes);}catch(error){logFailed=true;console.error('Android service log: '+error.message);}};
   for(const stream of [p.stdout,p.stderr]){stream.on('data',data);stream.on('error',error=>console.error('Android service output: '+error.message));}
   p.once('close',()=>{try{log.close();}catch(error){console.error('Android service log: '+error.message);}});
  }else fs.closeSync(log);
  p.ownerName=name;p.once('error',error=>{if(!transient)report(name,error);});p.once('close',(code,signal)=>{if(!closing&&!transient)report(name,nativeServiceError(root,name,code,signal));});
  p.stdin?.on('error',error=>{if(!closing&&!transient)report(name,error);});
  p.transient=transient;children.push(p);return p;
 }
 const linux=c.linuxRun,sharedIdentity=payload.profile?.processIdentityVersion===1;
 const args=['--inherit-env','--binder',binderName,'--by-pid',byPid,'--path-map',mapFile,'--cache',cache,'--gpu',path.join(payload.root,'native/angle'),'--display',socket,...(sharedIdentity?['--host-module',c.hostLibrary]:[])];
 const waiterMap=publishPathMap(kernelRuntime,'service-wait',`ro\t/system/lib64/libbinder.so\t${c.binderLibrary}\n`+map),waiterArgs=[...args];waiterArgs[waiterArgs.indexOf('--path-map')+1]=waiterMap;
 const identity=nativeServiceIdentity;
 const waitForFiles=async(condition,label)=>{const end=Date.now()+10000;while(!condition()){signal?.throwIfAborted();if(closing)throw Error('Composition is closing');if(Date.now()>end)throw Error(label+' startup timeout');await Promise.race([new Promise(r=>setTimeout(r,30)),failure]);}signal?.throwIfAborted();};
 const servicesReady=async(services)=>{
  signal?.throwIfAborted();
  if(!c.serviceWaiter&&services.length>1){await Promise.all(services.map(service=>servicesReady([service])));return;}
  const names=services.map(([name])=>name),dependencies=services.map(([,dependency])=>dependency),label=dependencies.map(dependency=>dependency.ownerName).join('-');
  const command=c.serviceWaiter?['/system/bin/maclauncher-art-service-wait',...names]:['/system/bin/maclauncher-art-window','--wait-service',names[0]];
  const waiter=child('wait-'+label,linux,[...waiterArgs,'--identity-text',identity('service-query','system_server'),...command],env,true);
  try{await measure('composition-'+label,()=>nativeServiceReady(root,waiter,{failure,signal,dependencies}));}
  finally{if(waiter.exitCode===null&&waiter.signalCode===null){
   const ended=once(waiter,'close').catch(()=>{});try{process.kill(-waiter.pid,'SIGTERM');}catch{}
   let timer;await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);
   if(waiter.exitCode===null&&waiter.signalCode===null)try{process.kill(-waiter.pid,'SIGKILL');}catch{}
  }}
 };
 const serviceReady=(name,dependency)=>servicesReady([[name,dependency]]);
 let authority,mediaStartup,retirement;
 const close=()=>{closing=true;return retirement??=Promise.resolve().then(()=>retireAll([
  ()=>registrationWriter.close(),
  ()=>stopProcesses([...children].reverse()),
  ()=>mediaStartup,
  async()=>{requireRetired(children);if(authority)await owner.retire(authority);},
  async()=>{requireRetired(children);await retireAll([...descriptors].map(fd=>()=>{fs.closeSync(fd);descriptors.delete(fd);}));}
 ]));};

 try{
 child('properties',c.bootstrap,['serve',c.image,root,byPid],env);
 const entry=nativePresenterEntry(payload,application,[socket,c.hostLibrary],env);
 const launchedAt=Date.now(),presenter=child('presenter',entry.command,entry.args,{...env,KLEPTON_FRAME_LIBRARY:path.join(sharedGraphics,'libreshade-macos.dylib'),MACLAUNCHER_ANDROID_TITLE:appLabel,...(appIcon?{MACLAUNCHER_ANDROID_ICON:appIcon}:{}),MACLAUNCHER_ART_BROWSER_SOCKET:browserSocket,MACLAUNCHER_ANDROID_ALLOW_ADS:allowAds?'1':'0',MACLAUNCHER_ART_WIDTH:String(viewport.width),MACLAUNCHER_ART_HEIGHT:String(viewport.height),MACLAUNCHER_ART_DENSITY:String(viewport.densityDpi)});
 fs.closeSync(controlRead);descriptors.delete(controlRead);fs.closeSync(browserRead);descriptors.delete(browserRead);
 await waitForFiles(()=>fs.existsSync(socket)&&fs.existsSync(path.join(root,'sockets/property_service')),'Presenter and native properties');
 // Original init's generated linker namespaces, from this image's APEX list.
 const linker=child('linkerconfig',linux,[...args,'--identity-text',identity('linkerconfig','init',0,'0'),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],env,true);
 const [linked,linkSignal]=await Promise.race([once(linker,'exit'),new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Original linker configuration timed out')),10000);linker.once('exit',()=>clearTimeout(timer));})]);
 if(linked!==0)throw nativeServiceError(root,'linkerconfig',linked,linkSignal);
 child('servicemanager',linux,[...args,'--identity-text',identity('servicemanager','servicemanager'),'/system/bin/servicemanager']);
 child('hwservicemanager',linux,[...args,'--identity-text',identity('hwservicemanager','hwservicemanager'),'/system/bin/hwservicemanager']);
 // Original Binder clients wait for ServiceManager themselves. Start the
 // physical HALs alongside it; their actual registration remains awaited.
 let composer;
 for(const[name,program,context]of[['allocator','/vendor/bin/hw/android.hardware.graphics.allocator-service.aim','hal_graphics_allocator_default'],['composer','/vendor/bin/hw/android.hardware.graphics.composer3-service.aim','hal_graphics_composer_default'],['power','/apex/com.android.hardware.power/bin/hw/android.hardware.power-service.example','hal_power_default']]){const p=child(name,linux,[...args,'--identity-text',identity(name,context),program]);if(name==='composer')composer=p;}
 // SurfaceFlinger waits for its original composer client itself. Let its
 // independent initialization overlap HAL startup, as Android init does,
 // while still observing both actual service publications before the window.
 const surfaceflinger=child('surfaceflinger',linux,[...args,'--identity-text',identity('surfaceflinger','surfaceflinger'),'/system/bin/surfaceflinger']);
 // Loading the original window's executable closure is independent of these
 // service publications. Its entry publishes the actual process identity, then
 // waits on inherited stdin before contacting either platform or display owner.
 // Keep that load alongside the original publishers rather than after them.
 let window,windowIdentityReady;
 if(!graphicsOnly){
 const windowMap=publishPathMap(kernelRuntime,'window',`ro\t/system/lib64/libbinder.so\t${c.binderLibrary}\n`+`rw\t/dev/socket/maclauncher-platform\t${owner.socketPath}\n`+map);
 const windowArgs=[...args];windowArgs[windowArgs.indexOf('--path-map')+1]=windowMap;
 window=child('window-root',linux,[...windowArgs,...(sharedIdentity?[]:['--host-module',c.hostLibrary]),'--identity-text',nativeResolverIdentity(),'/system/bin/maclauncher-art-window','--platform-stdin',String(appUid),networkAllowed?'1':'0',allowAds?'1':'0']);
 windowIdentityReady=measure('composition-window-identity',()=>processIdentity(window,{version:payload.profile?.processIdentityVersion}));
 windowIdentityReady.catch(()=>{});
 }
 await servicesReady([
  ['android.hardware.graphics.composer3.IComposer/default',composer],
  ['SurfaceFlinger',surfaceflinger]
 ]);
 if(!graphicsOnly){
 let aborted;
 const cancelled=new Promise((resolve,reject)=>{aborted=()=>reject(signal.reason??Error('Android native launch was cancelled'));signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();});
 let readyOwner,windowIdentity;
 try{[readyOwner,windowIdentity]=await Promise.race([Promise.all([owner.ready?measure('composition-platform-services',()=>platformReady):owner,windowIdentityReady]),failure,cancelled]);}
 finally{signal?.removeEventListener('abort',aborted);}
 owner=readyOwner;
 authority={packageName:'android',processName:'android:composition',...windowIdentity,hostUid:process.getuid(),uid:1000,securityContext:'u:r:system_server:s0'};
 await measure('composition-window-enrollment',()=>owner.enroll(authority));
 signal?.throwIfAborted();await Promise.race([failure,Promise.resolve()]);
 // The guest path is the exact namespace alias already granted above. The
 // remaining fields retain the authenticated profile owner's original values.
 const registration=nativePlatformAuthority({socketPath:'/dev/socket/maclauncher-platform',identity:owner.identity});
 await new Promise((resolve,reject)=>window.stdin.end(registration,error=>error?reject(error):resolve()));
 await serviceReady('maclauncher.art.window',window);
 // Original services wait on their original Binder dependencies. The app
 // publishes its shared source before providers; no launcher readiness loop
 // or second native sensor owner is introduced here.
 child('sensors-hal',linux,[...args,'--identity-text',identity('sensors-hal','hal_sensors_default',1000,'1000'),'/vendor/bin/hw/android.hardware.sensors-service.aim','/dev/maclauncher-sensor-source']);
 child('sensorservice',linux,[...args,'--identity-text',identity('sensorservice','system_server',1000,'1000 1005 3009'),'/system/bin/sensorservice']);

 mediaStartup=(async()=>{
 // These original publishers initialize independently. One owned waiter
 // observes all registrations before their shared audioserver consumer.
 const suspend=child('system-suspend',linux,[...args,'--identity-text',identity('system_suspend','system_suspend',1000,'1000 3010'),'/system/bin/hw/android.system.suspend-service']);
 const metrics=child('mediametrics',linux,[...args,'--identity-text',identity('mediametrics','mediametrics',1013,'1013'),'/system/bin/mediametrics']);
 const audioHal=child('audio-hal',linux,[...args,...(sharedIdentity?[]:['--host-module',c.hostLibrary]),'--identity-text',identity('audio-hal','hal_audio_default',1041,'1005 1013'),'/vendor/bin/hw/android.hardware.audio.service-aidl.aim'],{...env,MACLAUNCHER_ANDROID_AUDIO_INPUT_UID:media.audioInputUid||''});
 await servicesReady([
  ['android.system.suspend.ISystemSuspend/default',suspend],
  ['media.metrics',metrics],
  ['android.hardware.audio.core.IModule/default',audioHal]
 ]);
 child('audioserver',linux,[...args,'--identity-text',identity('audioserver','audioserver',1041,'1005 1006 1013 1031 3009'),'/system/bin/audioserver']);
 // AudioPolicyService registers its UID observer with the application's
 // existing ActivityManager endpoint. Let that app bootstrap publish its
 // original Binder before waiting for audio, avoiding a startup dependency
 // cycle. Native AudioSystem retains its normal service wait semantics.
 child('mediaextractor',linux,[...args,'--identity-text',identity('mediaextractor','mediaextractor',1040,'1026 1031'),'/system/bin/mediaextractor']);
 // SoundPool/MediaCodec retain the matching image's complete media services.
 // Their original init identities/groups are preserved; only physical PCM
 // leaves the guest through the shared CoreAudio owner.
 child('media-swcodec',linux,[...args,'--identity-text',identity('media.swcodec','mediacodec',1046,'1006 1026 1031'),'/apex/com.android.media.swcodec/bin/mediaswcodec']);
 child('mediaserver',linux,[...args,'--identity-text',identity('media','mediaserver',1013,'1005 1006 3003 3002 3001 3007 1026 1031'),'/system/bin/mediaserver']);
 })().catch(error=>{if(!closing)report('audioserver',error);});
 }
 const display=()=>JSON.parse(fs.readFileSync(path.join(root,'display.json'),'utf8'));console.log(graphicsOnly?'Original SurfaceFlinger ready':'Original SurfaceFlinger ready; audio awaits the canonical ActivityManager');const capture=async(name)=>{const out=fs.openSync(path.join(root,name),'w'),captureLog=path.join(root,'capture.log'),log=fs.openSync(captureLog,'w');const p=spawnProcess('capture',linux,[...args,'--identity-text',identity('capture','system_server'),'/system/bin/screencap','-p'],{env,stdio:['ignore',out,log],detached:true},{logFiles:[{file:captureLog,channels:['stderr']}]});fs.closeSync(out);fs.closeSync(log);p.ownerName='capture';children.push(p);const[code,signal]=await once(p,'exit');if(code!==0)throw Error('Original display capture failed: '+(code??signal));return path.join(root,name);};return {map,close,failure,args,env,get display(){return display();},presenter,launchedAt,input:inputRead,control:controlWrite,browserSocket,browserRegistration,capture,mediaFailures,mediaStartup};
 }catch(error){try{await close();}catch(cleanup){console.error('Android composition retirement: '+cleanup.message);}throw error;}
}
