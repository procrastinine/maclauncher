const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');
const {componentSupplier}=require('./android-art-supplier');
const alive=child=>child.exitCode===null&&child.signalCode===null;

/** One no-APK native Binder/allocator owner shared by graphics component proofs.
 * Optional composition adds original SF/HWC and the normal Mac presenter. */
exports.nativeGraphicsSession=async function({payload,root,gles,overlays=[],classpath,display=false,nativeCache,extraEnvironment={}}){
 payload=path.resolve(payload);root=path.resolve(root);const supplier=componentSupplier(payload),c=supplier.components,children=[];
 const run=(command,args,env=process.env)=>{
  const result=spawnSync(command,args,{env,encoding:'utf8',timeout:20000,maxBuffer:4<<20});
  if(result.error||result.signal||result.status!==0)throw Error(command+': '+(result.error||result.signal||result.status)+'\n'+result.stdout+result.stderr);
  return result.stdout+result.stderr;
 };
 let environment;
 const start=(name,command,args,env=environment,stdio)=>{
  const log=fs.openSync(path.join(root,name+'.log'),'w');
  let child;try{child=spawn(command,args,{env,stdio:stdio||['ignore',log,log],detached:true});}finally{fs.closeSync(log);}
  child.ownerName=name;children.push(child);fs.writeFileSync(path.join(root,'native-owners.json'),JSON.stringify({pids:children.map(child=>({pid:child.pid,owner:child.ownerName})),startedAt:new Date().toISOString()},null,2)+'\n');return child;
 };
 const close=async()=>{
  const {stopProcess}=await import('../../src/modules/android/art/process-retirement.mjs');
  await Promise.all([...children].reverse().map(child=>stopProcess(child)));
  for(const child of children)try{process.kill(child.pid,0);throw Error('Native component process remains: '+child.pid);}catch(error){if(error.code!=='ESRCH')throw error;}
  fs.writeFileSync(path.join(root,'native-cleanup.json'),JSON.stringify({retired:true,pids:children.map(child=>({pid:child.pid,owner:child.ownerName}))},null,2)+'\n');
 };
 try{
  const {layout,prepareMountParents,publishPathMap,environment:guestEnvironment}=await import('../../src/modules/android/art/layout.mjs');
  const {nativeServiceIdentity}=await import('../../src/modules/android/art/composition.mjs');
  const state=path.join(root,'native-state'),properties=path.join(root,'properties'),byPid=path.join(root,'by-pid');
  for(const directory of [state,byPid,path.join(root,'sockets')])fs.mkdirSync(directory,{recursive:true});
  const manifest=path.join(root,'manifest');fs.cpSync(path.join(c.image,'vendor/etc/vintf/manifest'),manifest,{recursive:true});
  for(const name of ['hwc3.xml','android.hardware.graphics.gralloc.ranchu.xml','android.hardware.audio@7.1-impl.ranchu.xml','bluetooth_audio.xml','android.hardware.media.c2@1.0-service-goldfish.xml','android.hardware.sensors-multihal.xml'])fs.rmSync(path.join(manifest,name),{force:true});
  fs.cpSync(c.halManifests,manifest,{recursive:true});
  const mounts=[...overlays,['ro','/vendor/lib64/egl/libGLES_aim.so',path.resolve(gles||c.glesLibrary)],['ro','/vendor/lib64/hw/mapper.aim.so',path.join(c.halRoot,'libmapper.so')],['ro','/vendor/bin/hw/android.hardware.graphics.allocator-service.aim',path.join(c.halRoot,'allocator-service')],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/vendor/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/dev/__properties__',properties],['ro','/vendor/etc/vintf/manifest',manifest],['ro','/vendor/etc/vintf/manifest.xml',c.vendorManifest],['ro','/system/bin/maclauncher-art-service-wait',c.serviceWaiter]];
  if(display)mounts.push(['ro','/vendor/bin/hw/android.hardware.graphics.composer3-service.aim',c.composerHal]);
  mounts.push(...['property_service','property_service_for_system'].map(name=>['rw','/dev/socket/'+name,path.join(root,'sockets',name)]));
  const map=publishPathMap(state,'graphics',prepareMountParents(layout({supplier,state})+mounts.map(row=>row.join('\t')+'\n').join(''),path.join(root,'mounts')));
  environment={...process.env,...guestEnvironment(supplier),...(await require('../../src/modules/android/process-channel').processNamespace(root,1)).environment,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so',KL_ANGLE_BACKEND:'metal',DYLD_LIBRARY_PATH:path.join(payload,'native'),DYLD_FRAMEWORK_PATH:path.join(payload,'native'),...extraEnvironment};
  if(classpath){environment.CLASSPATH=classpath;environment.BOOTCLASSPATH=environment.BOOTCLASSPATH.replace('/system/framework/maclauncher.jar',classpath+':/system/framework/maclauncher.jar');}
  fs.rmSync(properties,{recursive:true,force:true});const propertyOwner=start('properties',c.bootstrap,['serve',c.image,root,byPid]);
  for(let i=0;!fs.existsSync(path.join(root,'sockets/property_service'));i++){
   if(i>=100||!alive(propertyOwner))throw Error('Original property service startup:\n'+fs.readFileSync(path.join(root,'properties.log'),'utf8'));
   await new Promise(resolve=>setTimeout(resolve,30));
  }
  const binderName='maclauncher.android.native-component.'+crypto.randomUUID();
  start('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName]);run(c.bootstrap,['wait-binder',binderName],environment);
  const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--by-pid',byPid,'--path-map',map,'--cache',nativeCache||path.join(root,'cache'),'--gpu',path.join(payload,'native/angle'),'--host-module',c.hostLibrary];
  const artMap=publishPathMap(state,'art','ro\t/system/lib64/libbinder.so\t'+c.binderLibrary+'\n'+fs.readFileSync(map,'utf8')),artBase=[...base];artBase[artBase.indexOf('--path-map')+1]=artMap;
  run(c.linuxRun,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],environment);
  start('servicemanager',c.linuxRun,[...base,'--identity-text',nativeServiceIdentity('servicemanager','servicemanager'),'/system/bin/servicemanager']);
  start('allocator',c.linuxRun,[...base,'--identity-text',nativeServiceIdentity('allocator','hal_graphics_allocator_default'),'/vendor/bin/hw/android.hardware.graphics.allocator-service.aim'],{...environment,LD_PRELOAD:'/vendor/lib64/libandroid-log-stderr.so'});
  const wait=(...names)=>run(c.linuxRun,[...artBase,'--identity-text',nativeServiceIdentity('service-query','system_server'),'/system/bin/maclauncher-art-service-wait',...names],environment);
  wait('android.hardware.graphics.allocator.IAllocator/default');
  let presenter;
  if(display){
   const socket=path.join(root,'display.sock'),shared=require('../../src/modules/shared/reshade').runtimeRoot();fs.rmSync(socket,{force:true});
   const fd=fs.openSync(path.join(root,'presenter.log'),'w');try{
    presenter=start('presenter',c.presenter,[socket,c.hostLibrary],{...environment,KLEPTON_FRAME_LIBRARY:path.join(shared,'libreshade-macos.dylib'),MACLAUNCHER_ANDROID_TITLE:'Android',MACLAUNCHER_ART_BROWSER_SOCKET:path.join(root,'browser.sock'),MACLAUNCHER_ANDROID_ALLOW_ADS:'0',MACLAUNCHER_ART_WIDTH:'128',MACLAUNCHER_ART_HEIGHT:'128',MACLAUNCHER_ART_DENSITY:'160'},['ignore',fd,fd,'pipe','pipe','pipe']);
   }finally{fs.closeSync(fd);}
   for(const stream of presenter.stdio.slice(3))stream?.on('error',()=>{});presenter.stdio[3].on('data',()=>{});for(let i=0;!fs.existsSync(socket);i++){if(i>=100||!alive(presenter))throw Error('Native presenter startup:\n'+fs.readFileSync(path.join(root,'presenter.log'),'utf8'));await new Promise(resolve=>setTimeout(resolve,30));}
   base.push('--display',socket);artBase.push('--display',socket);
   start('hwservicemanager',c.linuxRun,[...base,'--identity-text',nativeServiceIdentity('hwservicemanager','hwservicemanager'),'/system/bin/hwservicemanager']);
   start('composer',c.linuxRun,[...base,'--identity-text',nativeServiceIdentity('composer','hal_graphics_composer_default'),'/vendor/bin/hw/android.hardware.graphics.composer3-service.aim'],{...environment,LD_PRELOAD:'/vendor/lib64/libandroid-log-stderr.so'});
   start('power',c.linuxRun,[...base,'--identity-text',nativeServiceIdentity('power','hal_power_default'),'/apex/com.android.hardware.power/bin/hw/android.hardware.power-service.example']);
   start('surfaceflinger',c.linuxRun,[...base,'--identity-text',nativeServiceIdentity('surfaceflinger','surfaceflinger'),'/system/bin/surfaceflinger']);
   wait('android.hardware.graphics.composer3.IComposer/default','SurfaceFlinger');
  }
  return {supplier,components:c,children,environment,base,artBase,root,run,start,wait,close,presenter,binderName};
 }catch(error){await close();throw error;}
};

