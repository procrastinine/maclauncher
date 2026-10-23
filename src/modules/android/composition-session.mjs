import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import{spawn,execFile}from'node:child_process';
import{promisify}from'node:util';
import{createRequire}from'node:module';
import{startComposition,nativeServiceIdentity}from'./art/composition.mjs';
import{layout,environment,publishPathMap,prepareMountParents,guestHooksArchive}from'./art/layout.mjs';
import{prepareIsolation}from'./art/isolation.mjs';
import{compositionCache}from'./art/composition-cache.mjs';
import{retireAll,stopProcesses,requireRetired}from'./art/process-retirement.mjs';
const require=createRequire(import.meta.url),execute=promisify(execFile),Writable=require('../shared/writable-input');

export async function retireCompositionSession({authority,children,composition,directory}){
 await retireAll([
  ()=>authority?.close(),
  ()=>stopProcesses(children),
  ()=>composition?.close(),
  ()=>{requireRetired(children);fs.rmSync(directory,{recursive:true,force:true});}
 ]);
}

/** The JVM borrows the production native graphics lifecycle. No media/audio or
 * second window owner is started to obtain original layer/buffer capabilities. */
export async function prepareCompositionSession({context,payload,prepared,storage,config,graphics={},installed,dependencies={}}){
 const supplier=dependencies.supplier||require('./art/runtime').resolve(payload),c=supplier.components;
 const library=dependencies.compositionSurface||c.compositionSurface;
 if(!library)throw Error('The included Android native composition binding is unavailable.');
 const directory=path.join(storage.runtimeRoot,'composition',crypto.randomUUID()),state=path.join(directory,'native');
 Writable.assertOwnDirectory(storage.root,directory);fs.mkdirSync(state,{recursive:true});
 const socketPath=path.join(directory,'layers.sock'),guestSocket='/dev/socket/maclauncher-native-composition',binderName='maclauncher.android.composition.'+crypto.randomUUID();
 const sharedGraphics=dependencies.sharedGraphicsRoot||require('../shared/reshade').runtimeRoot(context.app);
 const application=await require('./application').prepare({executablePath:c.presenter,directory:path.join(storage.root,'application'),title:config.title,iconFile:config.iconFile,iconHelper:path.join(payload.root,'native/android-application-icon'),signal:context.signal});
 const cache=await compositionCache(context.userDataDir,supplier,context.signal),blockNetwork=require('./launch-policy').networkBlocked(context);
 const isolated=await prepareIsolation({supplier,payload,directory,userDataDir:context.userDataDir,dataRoot:storage.dataRoot,prepared,application,installedPackages:[],graphics,sharedGraphics,binderName,localSockets:[],blockNetwork:true,media:{},signal:context.signal,compositionCache:cache});
 const env={...isolated.environment,...environment(supplier),TMPDIR:path.join(directory,'ipc')};fs.mkdirSync(env.TMPDIR,{recursive:true});
 const children=new Set();let composition,authority,retirement,closing=false;
 const start=(name,command,args,options,observation={})=>{if(closing)throw Error('Android composition is closing');const child=(dependencies.spawnProcess||spawn)(isolated.command,[...isolated.prefix,command,...args],{...options,cwd:storage.filesRoot,env:{...env,...options.env},detached:true});children.add(child);context.onToolProcessSpawn?.(child,{stopOnLauncherExit:true,ownerName:name,...observation});return child;};
 const close=()=>{closing=true;return retirement??=Promise.resolve().then(()=>retireCompositionSession({authority,children,composition,directory}));};
 try{
  const log=fs.openSync(path.join(directory,'binder.log'),'w');try{start('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName],{env,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
  await execute(c.bootstrap,['wait-binder',binderName],{signal:context.signal,timeout:6000});
  const base=layout({supplier,state});
  composition=await startComposition({scope:'graphics',directory,supplier,payload,sharedGraphics,binderName,env,application,kernelRuntime:state,pathMap:base,cache,spawnProcess:start,signal:context.signal,appLabel:config.title,appIcon:config.iconFile,networkAllowed:!blockNetwork,allowAds:config.allowAds===1,viewport:{width:config.width,height:config.height,densityDpi:require('./device-profile.json').display.densityDpi}});
  const rows=[['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/system/lib64/libmaclauncher-composition-surface.so',library],['rw',guestSocket,socketPath]];
  const map=publishPathMap(state,'layer-owner',prepareMountParents(rows.map(row=>row.join('\t')+'\n').join('')+composition.map,path.join(directory,'mount-parents'))),args=[...composition.args];args[args.indexOf('--path-map')+1]=map;
  const output=path.join(directory,'layers.log'),fd=fs.openSync(output,'w');let child;
  try{child=start('layer-owner',c.linuxRun,[...args,'--guest-fds','0,1,2,5','--identity-text',nativeServiceIdentity('composition','system_server'),'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','maclauncher.android.NativeCompositionHost',guestSocket,'/system/lib64/libmaclauncher-composition-surface.so'],{env:{...env,CLASSPATH:guestHooksArchive,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'},stdio:['ignore',fd,fd,'ignore','ignore','pipe']},{logFiles:[{file:output,channels:['stdout','stderr']}]});}finally{fs.closeSync(fd);}
  authority=await require('./platform-services/jvm').connectAuthority(child,'composition',undefined,payload.profile?.processIdentityVersion);
  await authority.ready;
  const display=composition.display;
  return{...authority,socketPath,display,composition,close,requireRetired:()=>requireRetired(children),presentation:{child:composition.presenter,executablePath:application.executablePath,launchedAt:composition.launchedAt},
   stdio(base){const descriptors=[...base];while(descriptors.length<8)descriptors.push('ignore');descriptors[6]=composition.input;descriptors[7]=composition.control;return descriptors;},
   config:{nativeInputFd:6,nativeControlFd:7},
   sandbox:{localSockets:{connect:[socketPath]}}};
 }catch(error){try{await close();}catch(cleanup){context.logger?.warn?.('[android] Native composition retirement: '+cleanup.message);}throw error;}
}
