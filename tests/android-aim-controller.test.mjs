import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const controller=process.env.ANDROID_AIM_CONTROLLER_EXECUTABLE||fileURLToPath(new URL('../src/modules/android/providers/aim/resources/maclauncher-aim',import.meta.url));
const supported=process.platform==='darwin'&&process.arch==='arm64'&&fs.existsSync(controller);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function scenario(options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aim-controller-phases-')),runtime=path.join(directory,'runtime'),root=path.join(directory,'profile'),data=path.join(directory,'android'),userdata=path.join(directory,'userdata.asif');
 const image=path.join(directory,'original'),appHostImage=path.join(directory,'app-host');fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(path.join(root,'runtime'),{recursive:true});fs.writeFileSync(userdata,'ORIGINAL_USER_DATA');
 const config={directory,appHostImage,...options};
 fs.writeFileSync(path.join(runtime,'bin/aimctl'),'#!'+process.execPath+'\nrequire('+JSON.stringify(fileURLToPath(new URL('./fixtures/android-aim-controller/aimctl.cjs',import.meta.url)))+')('+JSON.stringify(config)+');\n',{mode:0o755});
 const record=path.join(root,'runtime/aim-installed.json');if(options.record)fs.writeFileSync(record,JSON.stringify(options.record));if(options.installed)fs.writeFileSync(path.join(directory,'installed'),'yes');
 const apks=['base.apk','split.apk'].map((name,index)=>{const f=path.join(directory,name);fs.writeFileSync(f,'original-apk-'+index);return f;});
 const configuration={schemaVersion:1,runtime,root,data,userdata,image,originalImage:image,appHostImage,packageName:'org.example.game',activity:'.Launcher',key:'new',apks,launchMode:'app-host',...options.launch};
 const file=path.join(directory,'launch.json');fs.writeFileSync(file,JSON.stringify(configuration));
 const child=spawn(controller,[file],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 const timeout=setTimeout(()=>{fs.writeFileSync(path.join(directory,'force-close'),'1');child.kill('SIGTERM');},12000);
 try{
  if(options.cancelInstall){const until=Date.now()+8000;while(!fs.existsSync(path.join(directory,'install-active'))&&Date.now()<until)await pause(20);assert.ok(fs.existsSync(path.join(directory,'install-active')));child.kill('SIGTERM');}
  const status=await completion,events=fs.existsSync(path.join(directory,'commands.jsonl'))?fs.readFileSync(path.join(directory,'commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  const run=events.filter(e=>e.event==='resident-start'),stop=events.filter(e=>e.event==='resident-stop'),activities=events.filter(e=>e.event==='activity');
  const commands=events.filter(e=>e.event==='command');
  for(const e of commands.filter(e=>e.args[2]==='run')){assert.equal(e.args[e.args.indexOf('--userdata')+1],userdata);assert.equal(e.args[1],data);}
  assert.equal(fs.readFileSync(userdata,'utf8'),'ORIGINAL_USER_DATA');for(const [i,f]of apks.entries())assert.equal(fs.readFileSync(f,'utf8'),'original-apk-'+i);
  for(const pid of new Set([...run.map(e=>e.pid),...events.filter(e=>e.event==='worker').map(e=>e.child)])){
   const until=Date.now()+2000;let alive;do{try{process.kill(pid,0);alive=true;}catch{alive=false;}if(alive)await pause(20);}while(alive&&Date.now()<until);assert.equal(alive,false,'Owned fixture process remains: '+pid);
  }
  return {status,stdout,stderr,events,commands,run,stop,activities,record:fs.existsSync(record)?JSON.parse(fs.readFileSync(record)):null,temporary:fs.existsSync(path.join(data,'data/local/tmp'))?fs.readdirSync(path.join(data,'data/local/tmp')):[]};
 }finally{clearTimeout(timeout);fs.writeFileSync(path.join(directory,'force-close'),'1');fs.rmSync(directory,{recursive:true,force:true});}
}

test('new and updated app-host installs use original services before a nonoverlapping app-host phase',{skip:!supported,timeout:30000},async()=>{
 for(const record of [undefined,{key:'old',packageName:'org.example.game'}]){
  const result=await scenario({record,installed:Boolean(record)});assert.equal(result.status.code,0,result.stderr);
  assert.deepEqual(result.run.map(e=>e.mode),['android-services','app-host']);assert.deepEqual(result.stop.map(e=>e.mode),['android-services','app-host']);
  const firstStop=result.events.findIndex(e=>e.event==='resident-stop'),secondStart=result.events.findIndex((e,i)=>i>0&&e.event==='resident-start'&&e.mode==='app-host');assert.ok(firstStop<secondStart);
  assert.deepEqual(result.activities.map(e=>e.mode),['app-host']);assert.equal(result.activities[0].target,'org.example.game/.Launcher');
  assert.deepEqual(result.commands.filter(e=>e.args.includes('/system/bin/pm')&&e.args[4]!=='path').map(e=>e.args[4]),['install-create','install-write','install-write','install-commit']);
  assert.deepEqual(result.record,{key:'new',packageName:'org.example.game'});assert.deepEqual(result.temporary,[]);
 }
});
test('matching app-host installs start directly and validate the original package state',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new',packageName:'org.example.game'},installed:true});assert.equal(result.status.code,0,result.stderr);assert.deepEqual(result.run.map(e=>e.mode),['app-host']);
 assert.ok(result.commands.some(e=>e.args.includes('init.svc.aim-app-host-agent')));assert.ok(result.commands.some(e=>e.args.includes('aim.app_host')));assert.ok(result.commands.some(e=>e.args[2]==='apps'));
 assert.ok(result.commands.every(e=>!e.args.includes('/system/bin/pm')));
 assert.ok(result.commands.every(e=>!e.args.includes('sys.boot_completed')&&!e.args.includes('get-started-user-state')&&!e.args.includes('/system/bin/settings')&&!e.args.includes('install-create')));
});
test('a stale install record triggers one original reinstall and app-host restart',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new',packageName:'org.example.game'}});assert.equal(result.status.code,0,result.stderr);assert.deepEqual(result.run.map(e=>e.mode),['app-host','android-services','app-host']);assert.equal(result.activities.length,1);
});
test('app-host package verification matches an enabled launcher package exactly',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new',packageName:'org.example.game'},installed:true,missingInAppHost:true});
 assert.equal(result.status.code,1);assert.match(result.stderr,/installed Android package is unavailable/);assert.equal(result.activities.length,0);
 assert.deepEqual(result.run.map(e=>e.mode),['app-host','android-services','app-host']);
});
test('app-host application-list errors preserve the actual failure without reinstalling',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new'},installed:true,failAppList:true});
 assert.equal(result.status.code,1);assert.match(result.stderr,/AIM application list: Application list fixture error/);
 assert.deepEqual(result.run.map(e=>e.mode),['app-host']);assert.equal(result.activities.length,0);assert.deepEqual(result.record,{key:'new'});
});
test('app-host opening waits for the selected runtime user-state interface to report unlocking',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new'},installed:true,userUnlockPolls:2,launch:{appHostUserUnlockTransaction:78}});
 assert.equal(result.status.code,0,result.stderr);assert.deepEqual(result.events.filter(e=>e.event==='user-state').map(e=>e.ready),[false,false,true]);
 const ready=result.events.findIndex(e=>e.event==='user-state'&&e.ready),opened=result.events.findIndex(e=>e.event==='activity');assert.ok(ready>=0&&opened>ready);
 assert.deepEqual(result.run.map(e=>e.mode),['app-host']);assert.ok(result.commands.every(e=>!e.args.includes('/system/bin/pm')));
});
test('app-host user-state exceptions are preserved without activity retries or reinstallation',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new'},installed:true,failUserState:true,launch:{appHostUserUnlockTransaction:78}});
 assert.equal(result.status.code,1);assert.match(result.stderr,/AIM user state: Result: Parcel\(fffffffb/);assert.equal(result.activities.length,0);
 assert.deepEqual(result.run.map(e=>e.mode),['app-host']);assert.deepEqual(result.record,{key:'new'});
});
test('app-host start requires a successful Binder result with a process PID',{skip:!supported,timeout:30000},async()=>{
 for(const openReply of ['Result: Parcel(fffffffb 00000000)','Result: Parcel(00000000 00000000)','Result: Parcel(\n  0x00000000: 00000000 0000002a ....\n)']){
  const result=await scenario({record:{key:'new'},installed:true,openReply});
  assert.equal(result.status.code,openReply.includes('0000002a')?0:1,result.stderr);
  if(result.status.code)assert.match(result.stderr,/could not start the activity/);
 }
});
test('failed or canceled installation preserves prior metadata and retires all owned phases',{skip:!supported,timeout:30000},async()=>{
 for(const options of [{failInstall:true},{cancelInstall:true}]){
  const result=await scenario({...options,record:{key:'old',packageName:'org.example.game'},installed:true});assert.equal(result.status.code,1);assert.deepEqual(result.run.map(e=>e.mode),['android-services']);assert.equal(result.activities.length,0);assert.deepEqual(result.record,{key:'old',packageName:'org.example.game'});assert.deepEqual(result.temporary,[]);
  assert.match(result.stderr,options.failInstall?/INSTALL_FAILED_FIXTURE/:/startup was canceled/);
 }
});
test('app-host readiness failure does not launch or alter installed state',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({record:{key:'new'},installed:true,failAppHost:true});assert.equal(result.status.code,1);assert.match(result.stderr,/stopped before startup completed/);assert.equal(result.activities.length,0);assert.deepEqual(result.record,{key:'new'});
});
test('failed original-services shutdown prevents the app-host phase',{skip:!supported,timeout:15000},async()=>{
 const result=await scenario({failShutdown:true});assert.equal(result.status.code,1);assert.match(result.stderr,/Android shutdown failed/);assert.deepEqual(result.run.map(e=>e.mode),['android-services']);assert.equal(result.activities.length,0);
});
test('legacy configurations preserve full services and literal launch arguments; app-host rejects extras before spawn',{skip:!supported,timeout:15000},async()=>{
 const args=JSON.stringify(['space value','','literal $(touch forbidden)','line\nbreak']);
 const legacy=await scenario({record:{key:'new'},installed:true,launch:{launchMode:undefined,gameArguments:args}});assert.equal(legacy.status.code,0,legacy.stderr);assert.deepEqual(legacy.run.map(e=>e.mode),['android-services']);assert.deepEqual(legacy.activities[0].args.slice(-3),['--es','maclauncher.arguments',args]);
 const rejected=await scenario({launch:{gameArguments:args}});assert.equal(rejected.status.code,1);assert.match(rejected.stderr,/Custom launch arguments require Android services mode/);assert.equal(rejected.events.length,0);
});
