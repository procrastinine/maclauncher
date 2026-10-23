// Test-only native-process stand-in. The production composition owner retains
// real child identities, pipes, readiness dependencies and bounded retirement.
import fs from 'node:fs';
import path from 'node:path';
const [root,name,encoded]=process.argv.slice(2),args=JSON.parse(encoded);
const marks=path.join(root,'marks');fs.mkdirSync(marks,{recursive:true});
const ready=value=>fs.writeFileSync(path.join(marks,value),'ready');
if(name==='linkerconfig')process.exit(0);
if(name==='properties'){
 fs.mkdirSync(path.join(root,'composition/sockets'),{recursive:true});
 fs.writeFileSync(path.join(root,'composition/sockets/property_service'),'');
}
if(name==='presenter')fs.writeFileSync(path.join(root,'composition/display.sock'),'');
if(name==='window-root'){
 ready('window-root-loaded');let bytes=Buffer.alloc(0);
 process.stdin.on('data',data=>{
  bytes=Buffer.concat([bytes,data]);
  const deferred=args.includes('--platform-stdin');
  if(!deferred){ready(name);return;}
  if(bytes.length<5||bytes.length<5+bytes.readUInt32BE(1))return;
  if(bytes[0]!==49||bytes.length!==5+bytes.readUInt32BE(1))throw Error('Invalid native authority packet');
  fs.writeFileSync(path.join(marks,'window-root-authority.json'),JSON.stringify(bytes.subarray(5).toString('utf8').split('\0').slice(0,-1)));
  ready(name);
 });
}
else if(name.startsWith('wait-')){
 const program=args.indexOf('/system/bin/maclauncher-art-service-wait');
 const owners=new Map([
  ['android.hardware.graphics.composer3.IComposer/default','composer'],['SurfaceFlinger','surfaceflinger'],
  ['maclauncher.art.window','window-root'],['android.system.suspend.ISystemSuspend/default','system-suspend'],
  ['media.metrics','mediametrics'],['android.hardware.audio.core.IModule/default','audio-hal']
 ]);
 const dependencies=args.slice(program+1).map(service=>{if(!owners.has(service))throw Error('Unexpected fixture service');return owners.get(service);});
 setInterval(()=>{if(dependencies.every(owner=>fs.existsSync(path.join(marks,owner))))process.exit(0);},5);
}else if(name==='system-suspend'){
 setInterval(()=>{if(fs.existsSync(path.join(marks,'release-suspend')))ready(name);},5);
}else ready(name);
setInterval(()=>{},1000);
