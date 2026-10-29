import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Isolation=require('../../shared/runtime/macos-sandbox');
const Writable=require('../../shared/writable-input');
const quote=value=>{if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid Android native capability path');return JSON.stringify(value);};

/** Same per-app file/network policy as the JVM launcher. Only the Linux/ART
 * executable closure and its private native IPC capabilities are different. */
export async function prepareIsolation({supplier,payload,directory,policyDirectory=directory,dataRoot,userDataDir,prepared,application,installedPackages=[],physicalDataRoots=[],graphics={},sharedGraphics,binderName,localSockets=[],blockNetwork,media={},signal,vulkan=null,angleBackend='metal',compositionCache}){
 if(angleBackend==='vulkan'&&!vulkan)throw Error('No Vulkan implementation is installed. Install MoltenVK or KosmicKrisp in Runtimes → Graphics.');
 const data=await Isolation.canonical(dataRoot,'directory'),runtime=await Isolation.canonical(payload.root,'directory');
 Writable.assertOwnDirectory(directory,policyDirectory);
 const state=path.join(policyDirectory,'state');Writable.assertOwnDirectory(policyDirectory,state);
 const home=path.join(data,'home'),temporary=path.join(data,'cache/tmp'),graphicsOutput=path.join(data,'cache/graphics');
 for(const file of [home,temporary,graphicsOutput])Writable.assertOwnDirectory(data,file);
 const scoped=await Isolation.isolateGraphics(graphics,state,graphicsOutput,signal);
 const vulkanEnvironment=require('../../shared/vulkan').environment(vulkan,state);
 const driverFiles=await Promise.all((vulkan?.readable||[]).map(file=>Isolation.canonical(file,'file')));
 const codeDirectories=[runtime,await Isolation.canonical(prepared.root,'directory')];
 // Managed ART code and the explicitly acquired original image are immutable
 // suppliers beside the common JVM payload, not writable application storage.
 for(const root of [supplier.packageRoot,supplier.root,supplier.components.image])if(root){const actual=await Isolation.canonical(root,'directory');if(!codeDirectories.includes(actual))codeDirectories.push(actual);}
 for(const item of installedPackages){for(const file of [item.nativeRoot,...item.sourceApks.map(file=>path.dirname(file))])codeDirectories.push(await Isolation.canonical(file,'directory'));}
 const access=application?await require('../application').isolation(application):{};
 const readDirectories=[...codeDirectories,...(access.readDirectories||[]),...scoped.readableDirectories,await Isolation.canonical(sharedGraphics,'directory')];
 const c=supplier.components,executables=[c.linuxRun,c.binder,c.bootstrap,c.presenter,path.join(c.image,'system/bin/app_process64'),path.join(c.image,'apex/com.android.runtime/bin/linker64')];
 if(application)executables.push(application.executablePath);
 executables.push(...(scoped.executables||[]));
 if(fs.existsSync(path.join(runtime,'native/libandroid-storage.dylib'))||scoped.graphics.DYLD_INSERT_LIBRARIES)executables.push('/usr/bin/env');
 const physicalRoots=await Promise.all(physicalDataRoots.map(file=>Isolation.canonical(file,'directory')));
 const cacheRoots=compositionCache?[await Isolation.canonical(compositionCache,'directory')]:[];
 const identities=await require('../process-channel').processNamespace(userDataDir,payload.profile?.processIdentityVersion);
 let text=Isolation.profile({readDirectories,readFiles:[...scoped.readable,...driverFiles],writeDirectories:[data,directory,...physicalRoots,...cacheRoots,...identities.writeDirectories,...(access.writeDirectories||[])],executables,blockNetwork,machServices:[binderName,...require('../sandbox').webKitMachServices,...(access.machServices||[])],fileExtensions:{...access.fileExtensions,read:[...(access.fileExtensions?.read||[]),...(scoped.fileExtensions?.read||[])]}})+(scoped.capabilities||'');
 text+=require('../shared-memory-policy').capabilities([temporary,path.join(directory,'ipc')]);
 text+=require('../sandbox').captureCapabilities(media);
 // Original ELF execution checks X_OK before loading through linux-run. The
 // installed runtime and package code are executable suppliers, including
 // native services and app-owned executable libraries selected by Android.
 // Writable application data remains outside these immutable code roots.
 for(const root of codeDirectories)text+='\n(allow process-exec (subpath '+quote(root)+'))\n';
 text+='\n(allow process-info* (target children))\n(allow mach-register (global-name '+quote(binderName)+'))\n';
 // Native Android processes communicate only within this session's writable
 // IPC tree, plus the exact authenticated profile-service sockets.
 text+='(allow network-bind network-inbound (local unix-socket (subpath '+quote(directory)+')))\n';
 text+='(allow network-outbound (remote unix-socket (subpath '+quote(directory)+')))\n';
 for(const socket of localSockets){
  const parent=await Isolation.canonical(path.dirname(socket),'directory');
  if(path.join(parent,path.basename(socket))!==socket)throw Error('Android service socket is not canonical');
  for(let item=parent;item!==path.dirname(item);item=path.dirname(item))text+='(allow file-read-metadata (literal '+quote(item)+'))\n';
  text+='(allow file-read-metadata (literal '+quote(socket)+'))\n(allow network-outbound (remote unix-socket (literal '+quote(socket)+')))\n';
 }
 const file=path.join(policyDirectory,'sandbox.sb');Writable.atomicWrite(file,text,{root:policyDirectory});
 return {command:'/usr/bin/sandbox-exec',prefix:['-f',file],environment:{...Isolation.environment(),...scoped.graphics,...vulkanEnvironment,...identities.environment,KL_ANGLE_BACKEND:angleBackend,HOME:home,CFFIXED_USER_HOME:home,TMPDIR:temporary+path.sep},state};
}
