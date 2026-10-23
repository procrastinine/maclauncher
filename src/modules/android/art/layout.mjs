import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{namespace}=require('../storage-namespace'),Writable=require('../../shared/writable-input');
const arm32Components=require('../runtime-source').json('native/arm32/components.json');
const NativeAbi=require('../native-abi');
import {guestHooksArchive,runtimeBootClasspath} from './boot-classpath.mjs';
export {guestHooksArchive,runtimeBootClasspath} from './boot-classpath.mjs';

const clean = value => {
  if (typeof value !== 'string' || /[\0\r\n\t]/.test(value)) throw Error('Invalid Android filesystem mapping');
  return value;
};
const record = (kind,guest,host) => [kind,clean(guest),clean(path.resolve(host))].join('\t')+'\n';

/** The Linux ABI uses the map's parent as its shared kernel metadata owner.
 * Different process mount views must retain that same session directory.
 * Bind sources name their physical target at publication, as Android mounts
 * do. Resolve each source once here, not for every guest inode inspection.
 * Absent/unresolvable sources retain their original native lookup behavior. */
export function publishPathMap(runtime,name,text){
 if(!name||path.basename(name)!==name)throw Error('Invalid Android process map name');
 const sources=new Map();
 text=text.split('\n').map(line=>{
  const row=line.split('\t');
  if(row.length!==3||!['root','ro','rw','kernfs','bpf','cgroup2'].includes(row[0]))return line;
  if(!sources.has(row[2])){
   let source=row[2];try{source=fs.realpathSync.native(source);}catch{}
   sources.set(row[2],source);
  }
  row[2]=sources.get(row[2]);return row.join('\t');
 }).join('\n');
 const file=path.join(runtime,clean(name)+'-path-map');
 fs.writeFileSync(file,text,{mode:0o600});return file;
}

/** Linux resolves every ancestor before a bind-mounted file. Materialize only
 * missing mount-point directories in private launch state, never by exposing
 * a host parent directory or changing the original read-only image. */
export function prepareMountParents(text,directory){
 const mounts=text.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split('\t'))
  .filter(row=>['root','ro','rw','kernfs','bpf','cgroup2'].includes(row[0]));
 const parents=new Set();
 for(const [,guest]of mounts)for(let parent=path.posix.dirname(guest);parent!=='/';parent=path.posix.dirname(parent))parents.add(parent);
 const additions=[];
 for(const guest of [...parents].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b))){
  const owner=mounts.filter(([,prefix])=>prefix==='/'||guest===prefix||guest.startsWith(prefix+'/')).sort((a,b)=>b[1].length-a[1].length)[0];
  if(!owner)throw Error('Android mount has no root directory');
  const host=path.join(owner[2],path.posix.relative(owner[1],guest));
  try{fs.lstatSync(host);continue;}catch(error){if(error.code!=='ENOENT')throw error;}
  // Explicit mount sources belong to their producer; an absent source is not
  // replaced with an empty directory and still reports its original error.
  if(owner[1]===guest)continue;
  const empty=path.join(directory,guest.slice(1));fs.mkdirSync(empty,{recursive:true,mode:0o755});
  additions.push(record('ro',guest,empty));mounts.push(['ro',guest,empty]);
 }
 return text+additions.join('');
}

/** Preparation already owns Android's installed split names. Native engines
 * distinguish asset/config packs using those names as well as the manifest. */
export function guestPackageSources(packageName,sources){
 return sources.map((file,index)=>'/data/app/'+clean(packageName)+'/'+(index?path.basename(file):'base.apk'));
}
export function guestNativeLibraryDirectory(packageName,abi=NativeAbi.ARM64){
 if(![NativeAbi.ARM64,...NativeAbi.ARM32].includes(abi))throw Error('Unsupported Android native architecture');
 return '/data/app/'+clean(packageName)+'/lib/'+(NativeAbi.ARM32.includes(abi)?'arm':'arm64');
}
export function guestDataDirectory(packageName){return '/data/user/0/'+clean(packageName);}

/** The authenticated installation catalog owns these immutable code inputs.
 * Peer dataRoot is metadata, never a filesystem capability for this process. */
export function installedCodeInputs(packages){
 const files=new Set();
 for(const item of packages)for(const file of [...item.sourceApks,item.nativeRoot,...(item.convertedJar?[item.convertedJar]:[])])files.add(clean(file));
 return [...files];
}
export function installedCodeLayout(packages){
 return installedCodeInputs(packages).map(file=>record('ro',file,file)).join('');
}

/** Per-process mappings do not recreate the session's original runtime. */
export function applicationLayout(application){
 const bindings={packageName:application.packageName,partitionsRoot:'/'};
 const guestData=guestDataDirectory(application.packageName);
 const aliases=namespace({...bindings,dataRoot:application.dataRoot}).mappings;
 // Original ART APIs return Android paths, while retained app data may use
 // physical private paths from JVM execution. Expand the same complete alias
 // policy in both coordinate spaces; every target has the same storage owner.
 for(const alias of namespace({...bindings,dataRoot:guestData}).mappings){
  const relative=path.posix.relative(guestData,alias.target);
  if(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative))continue;
  aliases.push({...alias,target:path.join(application.dataRoot,relative)});
 }
 // Apps can retain absolute file names in preferences and databases. Both
 // VMs name the same private data owner, including its physical spelling;
 // this grants no capability for a sibling app or a host parent directory.
 const rows=[record('rw',application.dataRoot,application.dataRoot)],published=new Map([[application.dataRoot,application.dataRoot]]);
 for(const alias of aliases){
  // The native Android session owns /data itself; app aliases remain precise
  // below it. The JVM represents that root through its private host paths.
  if(alias.nativeMount===false)continue;
  const relative=path.relative(application.dataRoot,alias.target);
  if(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative))continue;
  const directory=path.join(application.dataRoot,relative);Writable.assertOwnDirectory(application.dataRoot,directory);
  if(published.has(alias.android)){
   if(published.get(alias.android)!==directory)throw Error('Android storage aliases have conflicting owners');
   continue;
  }
  published.set(alias.android,directory);
  rows.push(record('rw',alias.android,directory));
 }
 const installed=guestPackageSources(application.packageName,application.sourceApks);
 rows.push(record('ro','/data/app/'+application.packageName,path.dirname(application.sourceApks[0])),
   record('ro','/data/app/'+application.packageName+'/lib',path.dirname(application.nativeRoot)));
 application.sourceApks.forEach((file,index)=>rows.push(record('ro',installed[index],file)));
 rows.push(record('ro',guestNativeLibraryDirectory(application.packageName,application.nativeAbi),application.nativeRoot));
 return rows.join('');
}

function initializeResourceCache(supplier,state){
 const directory=path.join(state,'data/data/resource-cache');
 Writable.assertOwnDirectory(state,directory);
 // Original init permits applications to traverse the system-owned idmaps.
 fs.chmodSync(directory,0o771);
 execFileSync(supplier.components.bootstrap,['initialize','1000',directory],{stdio:'pipe'});
}

/** The same image/ART supplier, with a fresh session's writable native state.
 * Application data is mapped separately to the existing Android storage owner.
 * A path map is private launch state, never part of a distributed artifact. */
export function layout({supplier,state,application}){
  const c=supplier.components,rows=[execFileSync(c.bootstrap,['layout',c.image,state],{encoding:'utf8'})];
  // These original init directories back Layout's /data and /data/user/0
  // mounts. App-only startup does not run init's post-fs-data actions.
  for(const name of ['data','app','resource-cache'])fs.mkdirSync(path.join(state,'data/data',name),{recursive:true,mode:0o755});
  initializeResourceCache(supplier,state);
  for(const file of fs.readdirSync(path.join(c.art,'lib64')).filter(file=>file.endsWith('.so')))
    rows.push(record('ro','/apex/com.android.art/lib64/'+file,path.join(c.art,'lib64',file)));
  rows.push(record('ro','/system/lib64/libart-platform.so',c.guestLibrary),
    record('ro','/system/lib64/libart-authority.so',c.authorityLibrary),record('ro','/system/lib64/libart-rpc.so',c.rpcLibrary),
    record('ro',guestHooksArchive,c.bootstrapDex),record('ro','/system/framework/services.jar',c.servicesJar),record('ro','/system/framework/framework.jar',c.frameworkJar));
  if(c.bootImage)for(const file of supplier.manifest.bootImage.files)rows.push(record('ro','/system/'+file,path.join(c.bootImage,file)));
  if(c.platformPackages)rows.push(record('ro','/system/etc/maclauncher-platform-packages.json',c.platformPackages));
  if(c.hwuiLibrary)rows.push(record('ro','/system/lib64/libhwui.so',c.hwuiLibrary));
  if(c.nativeBridge){
   rows.push(record('ro','/system/lib64/'+arm32Components.bindings.art,c.nativeBridge));
   for(const item of arm32Components.preloads)if(c[item.name])rows.push(record('ro','/system/lib/'+item.file,c[item.name]));
  }
  if(application)rows.push(applicationLayout(application));
  return rows.join('');
}
export function environment(supplier){return {PATH:'/apex/com.android.runtime/bin:/apex/com.android.art/bin:/system/bin',
 ANDROID_ROOT:'/system',ANDROID_DATA:'/data',ANDROID_STORAGE:'/storage',ANDROID_ART_ROOT:'/apex/com.android.art',
 ANDROID_I18N_ROOT:'/apex/com.android.i18n',ANDROID_TZDATA_ROOT:'/apex/com.android.tzdata',ANDROID_ASSETS:'/system/app',HOME:'/',
 BOOTCLASSPATH:runtimeBootClasspath(supplier.bootClasspath).join(':'),
 CLASSPATH:guestHooksArchive};}
export function guestArguments({supplier,binderName,pathMap,cache,uid,packageName,processName,config,graphics,display,byPid,stdio,nativeAbi=NativeAbi.ARM64}){
 if(!Number.isInteger(uid)||uid<10000||!packageName||!processName)throw Error('An installed Android application identity is required');
 const descriptors=stdio.flatMap((value,index)=>index<3||(value!=null&&value!=='ignore')?[index]:[]).join(',');
 const preinit=supplier.manifest.frameworkResourcePreinitVersion===1;
 if(supplier.manifest.frameworkResourcePreinitVersion!=null&&!preinit)throw Error('Unsupported Android resource initialization version');
 const startupUid=preinit?0:uid,startupCapabilities=preinit?0x1c2:0;
 const identity=[['service',processName],['uid',startupUid],['gid',startupUid],...(preinit?[['groups','']]:[]),['cap_effective',startupCapabilities],['cap_permitted',startupCapabilities],['cap_bounding',startupCapabilities],['seclabel','u:r:untrusted_app:s0']].map(row=>row.map(String).map(clean).join('\t')).join('\n')+'\n';
 // ART's app-only entry has no zygote fork. This original runtime option
 // retains and initializes its NativeBridge in the non-zygote lifecycle.
 const bridge=NativeAbi.ARM32.includes(nativeAbi)?['-XX:NativeBridge=libandroid-native-bridge.so','-Xforce-nb-testing']:[];
 if(bridge.length&&!supplier.components.nativeBridge)throw Error('This Android runtime does not include native translation');
 return ['--inherit-env','--guest-fds',descriptors,'--identity-text',identity,'--binder',clean(binderName),
   '--by-pid',byPid,'--path-map',pathMap,'--cache',cache,'--gpu',graphics,'--display',display,'--host-module',supplier.components.hostLibrary,
   supplier.guestEntry,'-Ximage:'+(supplier.components.bootImage?supplier.manifest.bootImage.location:'/nonexistent/boot.art'),'-Xnoimage-dex2oat',...bridge,'/system/bin',supplier.entry,'--config',config];
}

/** The original VM and dynamic linker receive only the selected suppliers.
 * Host graphics bindings remain the explicit, separately scoped selection. */
export function applicationEnvironment(supplier,values){
 const output={...values,...environment(supplier),LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'};
 if(supplier.manifest.frameworkResourcePreinitVersion===1)for(const name of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','ANDROID_JAVA_TOOL_OPTIONS','DALVIK_VM_OPTIONS','ART_VM_OPTIONS','LD_LIBRARY_PATH','LD_CONFIG_FILE','LD_AUDIT','DEX2OATBOOTCLASSPATH','SYSTEMSERVERCLASSPATH','STANDALONE_SYSTEMSERVER_JARS'])delete output[name];
 return output;
}
