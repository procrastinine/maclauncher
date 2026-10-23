// Owned command fixture for controller orchestration, not an Android service model.
module.exports=function(config){
 const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
 const a=process.argv.slice(2),op=a[2],file=name=>path.join(config.directory,name);
 const log=value=>fs.appendFileSync(file('commands.jsonl'),JSON.stringify({...value,pid:process.pid})+'\n');
 const read=name=>fs.existsSync(file(name))?fs.readFileSync(file(name),'utf8'):'';
 const mode=()=>read('mode');
 const worker=()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{if(process.ppid===1)process.exit(0)},50)'],{stdio:'ignore'});log({event:'worker',child:child.pid});return child;};
 log({event:'command',args:a,mode:mode()});
 if(op==='run'){
  const image=a[a.indexOf('--image')+1],selected=image===config.appHostImage?'app-host':'android-services';
  const previous=Number(read('resident'));if(previous){try{process.kill(previous,0);console.error('Concurrent resident phases');process.exit(9);}catch{}}
  fs.writeFileSync(file('resident'),String(process.pid));fs.writeFileSync(file('mode'),selected);log({event:'resident-start',mode:selected});
  const child=worker();let closing=false;
  const finish=()=>{if(closing)return;closing=true;log({event:'resident-stop',mode:selected});child.once('exit',()=>{if(read('resident')===String(process.pid))fs.rmSync(file('resident'),{force:true});process.exit(config.failShutdown&&selected==='android-services'?7:0);});child.kill('SIGTERM');};
  process.on('SIGTERM',finish);process.on('SIGINT',finish);
  if(config.failAppHost&&selected==='app-host')setTimeout(finish,60);
  setInterval(()=>{if(fs.existsSync(file('close'))||fs.existsSync(file('force-close'))||process.ppid===1)finish();},25);return;
 }
 if(op==='apps'){if(config.failAppList){console.error('Application list fixture error');process.exitCode=1;return;}if(read('installed')==='yes'&&!config.missingInAppHost)console.log('org.example.game  Example game');else console.log('org.example.game.extra  Another game');return;}
 if(op==='open'){log({event:'activity',mode:mode(),target:a[3]});console.log(config.openReply||'Result: Parcel(00000000 0000002a)');fs.writeFileSync(file('close'),'1');return;}
 const guest=a.slice(3),tool=path.basename(guest[0]||'');
 if(tool==='getprop'){
  if(guest[1]==='sys.boot_completed'){if(mode()==='app-host')throw Error('Full boot queried in app-host');console.log('1');}
  else if(guest[1]==='init.svc.aim-app-host-agent'){if(mode()!=='app-host')throw Error('Agent queried in full services');console.log(config.failAppHost?'':'running');}
  return;
 }
 if(tool==='service'){
  if(guest[1]==='call'&&guest[2]==='user'){
   if(mode()!=='app-host'||guest[3]!=='78'||guest[4]!=='i32'||guest[5]!=='0')throw Error('Unexpected user-state interface');
   const count=Number(read('user-state-count'))+1;fs.writeFileSync(file('user-state-count'),String(count));
   const ready=count>(config.userUnlockPolls||0);log({event:'user-state',ready});
   console.log(config.failUserState?'Result: Parcel(fffffffb 00000000)':`Result: Parcel(00000000 ${ready?'00000001':'00000000'})`);return;
  }
  console.log('Service aim.app_host: found');return;
 }
 if(tool==='am'){
  if(guest[1]==='get-started-user-state'){if(mode()==='app-host')throw Error('Full user lifecycle queried in app-host');console.log('RUNNING_UNLOCKED');return;}
  if(guest[1]==='start'){log({event:'activity',mode:mode(),args:guest});console.log('Status: ok\nComplete');fs.writeFileSync(file('close'),'1');return;}
 }
 if(tool==='settings'){if(mode()==='app-host')throw Error('Bootstrap settings used in app-host');console.log('Success');return;}
 if(tool==='pm'){
  if(guest[1]==='path'){if(mode()==='app-host')throw Error('Unsupported package shell used in app-host');if(read('installed')==='yes')console.log('package:/data/app/example/base.apk');return;}
  if(mode()==='app-host')throw Error('Package installation used app-host');
  if(guest[1]==='install-create'){
   if(config.cancelInstall){fs.writeFileSync(file('install-active'),'1');worker();setInterval(()=>{},1000);return;}
   console.log('Success: created install session [42]');return;
  }
  if(guest[1]==='install-commit'){
   if(config.failInstall){console.log('INSTALL_FAILED_FIXTURE');process.exitCode=1;return;}
   fs.writeFileSync(file('installed'),'yes');console.log('Success');return;
  }
  console.log('Success');return;
 }
 throw Error('Unexpected owned command: '+JSON.stringify(a));
};
