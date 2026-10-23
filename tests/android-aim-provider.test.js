const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {capture,controlDescriptor} = require('../src/modules/android/providers/aim');
const pin = require('../src/modules/android/providers/aim/source.json');

test('AIM always uses Android services and normalizes saved app-host selections',()=>{
  const {resolveLaunchMode}=require('../src/modules/android/providers/aim');
  const current={manifest:{capabilities:{appHost:true}}},games={manifest:{capabilities:{appHost:true,appHostGameMode:true}}},legacy={manifest:{}};
  assert.equal(resolveLaunchMode(current),'android-services');
  assert.equal(resolveLaunchMode(current,{launchMode:'auto'}),'android-services');
  assert.equal(resolveLaunchMode(current,{launchMode:'app-host'}),'android-services');
  assert.equal(resolveLaunchMode(games),'android-services');
  assert.equal(resolveLaunchMode(games,{launchMode:'auto'}),'android-services');
  assert.equal(resolveLaunchMode(games,{launchMode:'auto'},true),'android-services');
  assert.equal(resolveLaunchMode({manifest:{capabilities:{appHostGameMode:true}}}),'android-services');
  assert.equal(resolveLaunchMode(current,{launchMode:'android-services'}),'android-services');
  assert.equal(resolveLaunchMode(current,{launchMode:'auto'},true),'android-services');
  assert.equal(resolveLaunchMode(current,{launchMode:'app-host'},true),'android-services');
  assert.equal(resolveLaunchMode(legacy),'android-services');
  assert.equal(resolveLaunchMode(legacy,{launchMode:'android-services'}),'android-services');
  assert.equal(resolveLaunchMode(legacy,{launchMode:'app-host'}),'android-services');
  assert.equal(resolveLaunchMode(current,{launchMode:'other'}),'android-services');
  const settings=require('../src/modules/android/manifest.json').runtime.entries.aim.settings;
  assert.equal(Object.hasOwn(settings.defaults,'launchMode'),false);
  assert.ok(settings.fields.every(field=>field.key!=='launchMode'));
});

test('AIM rejects unsupported network and Google access before acquiring a runtime',async()=>{
  const {prepareLaunch}=require('../src/modules/android/providers/aim');
  await assert.rejects(prepareLaunch({context:{},policy:{networkAllowed:true}}),/offline applications/);
  await assert.rejects(prepareLaunch({context:{runtimeSettings:{googleIntegration:true}},policy:{networkAllowed:false}}),/Google integration is unavailable/);
});

test('AIM control passes literal arguments and stdin without a shell',async()=>{
  const input='{"secret":"$(touch forbidden)"}\n';
  const args=['space value','; touch forbidden','$(echo replacement)','"quoted"'];
  const output=await capture(process.execPath,['-e','let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:s})))','--',...args],{input});
  assert.deepEqual(JSON.parse(output),{args,input});
});

test('AIM keeper bounds command output and command duration',async()=>{
  await assert.rejects(capture(process.execPath,['-e','process.stdout.write("x".repeat(65536));setInterval(()=>{},1000)'],{maximum:1024}),/output exceeded/);
  await assert.rejects(capture(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:50}),/timed out/);
});

const keeper=path.resolve(__dirname,'../src/modules/android/providers/aim/resources/maclauncher-aim');
test('native AIM controller installs base and split APKs with one original PackageInstaller session and preserves its inputs',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-package-'));
  try {
    const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),log=path.join(root,'commands.jsonl'),data=path.join(root,'android');
    const profile=path.join(root,'profile'),started=path.join(root,'started');
    fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
    fs.writeFileSync(ctl,'#!'+process.execPath+'\nconst fs=require("node:fs");const a=process.argv.slice(2),started='+JSON.stringify(started)+';fs.appendFileSync('+JSON.stringify(log)+',JSON.stringify(a)+"\\n");if(a[2]==="run"){setInterval(()=>{if(fs.existsSync(started))process.exit(0)},50)}else if(a.includes("sys.boot_completed"))process.stdout.write("1\\n");else if(a.includes("get-started-user-state"))process.stdout.write("RUNNING_UNLOCKED\\n");else{if(a.includes("/system/bin/am")&&a.includes("start"))fs.writeFileSync(started,"1");process.stdout.write(a.includes("install-create")?"Success: created install session [42]\\n":a.includes("start")?"Status: ok\\nComplete\\n":"Success\\n")}\n',{mode:0o755});
    const files=['base.apk','split with spaces.apk'].map((name,index)=>{const file=path.join(root,name);fs.writeFileSync(file,'apk'+index);return file;});
    const gameArguments=JSON.stringify(['space value','','quote" slash\\','line\nbreak','✨']);
    const configuration=path.join(root,'launch.json');fs.writeFileSync(configuration,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data,root:profile,packageName:'org.example.game',activity:'org.example.game.LauncherAlias',key:'example',apks:files,gameArguments}));
    assert.match(await capture(keeper,[configuration],{timeout:10000}),/Android game started/);
    const commands=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(args=>args.includes('/system/bin/pm'));
    assert.deepEqual(commands.map(args=>args[4]),['install-create','install-write','install-write','install-commit']);
    assert.deepEqual(commands.slice(1,3).map(args=>args.slice(5,9)),[['-S','4','42','base.apk'],['-S','4','42','split_1.apk']]);
    assert.deepEqual(fs.readdirSync(path.join(data,'data/local/tmp')),[]);
    assert.equal(fs.readFileSync(files[0],'utf8'),'apk0');
    const startedCommand=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).find(args=>args.includes('/system/bin/am')&&args.includes('start'));
    assert.equal(startedCommand[startedCommand.indexOf('-n')+1],'org.example.game/org.example.game.LauncherAlias');
    assert.deepEqual(startedCommand.slice(-3),['--es','maclauncher.arguments',gameArguments]);
    const runCommand=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).find(args=>args[2]==='run');
    assert.equal(runCommand[runCommand.indexOf('--host-runtime')+1],path.join(runtime,'bin'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('AIM launches use a private Binder service namespace and default to no uplink',()=>{
  const root=path.join(os.tmpdir(),'android-aim-policy');
  const storage={root,androidRoot:path.join(root,'android'),home:path.join(root,'home'),temporary:path.join(root,'tmp')};
  const runtime={root:path.join(root,'runtime'),bin:path.join(root,'runtime/bin'),version:'test'};
  const descriptor=controlDescriptor({runtime,storage,policy:{networkAllowed:false},args:['status']});
  assert.equal(descriptor.env.MACLAUNCHER_AIM_NETWORK,'deny');
  assert.match(descriptor.machServicePrefixes[0],/^org\.maclauncher\.android\.aim\.[a-f0-9]{24}\.$/);
  assert.deepEqual(descriptor.machServicePrefixes,descriptor.machRegistrationPrefixes);
  assert.equal(descriptor.env.MACLAUNCHER_AIM_NO_SHIMS,'1');
  assert.equal(descriptor.command,path.join(runtime.bin,'aimctl'));
  const appHost=path.join(root,'images/app-host/identity/root');
  const modes=controlDescriptor({runtime,storage,policy:{networkAllowed:false},prepared:{directory:path.join(root,'images'),image:path.join(root,'images/derived/root'),appHostImage:appHost},args:['status']});
  assert.ok(modes.executableDirectories.includes(appHost));
  assert.equal(modes.env.MACLAUNCHER_AIM_NETWORK,'deny');
});

test('Android provider isolation retains selected graphics injection and exact file access', {skip:process.platform!=='darwin'}, async t=>{
  t.mock.method(console,'warn',()=>{});
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-provider-graphics-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const storage={root,packagesRoot:path.join(root,'packages'),runtimeRoot:path.join(root,'runtime'),
    cacheRoot:path.join(root,'cache'),home:path.join(root,'home'),temporary:path.join(root,'tmp')};
  for(const directory of Object.values(storage))fs.mkdirSync(directory,{recursive:true});
  const selected=path.join(root,'selected graphics.dylib');fs.writeFileSync(selected,'selected adapter');
  const {prepareIsolation}=require('../src/modules/android/policy');
  const descriptor={command:process.execPath,args:[],env:{},readDirectories:[],readFiles:[]};
  const isolated=await prepareIsolation(descriptor,storage,{networkAllowed:false},{graphics:{
    DYLD_INSERT_LIBRARIES:[selected,selected].join(path.delimiter),DYLD_LIBRARY_PATH:'/unselected',UNRELATED_SECRET:'excluded'}});
  assert.equal(isolated.environment.DYLD_INSERT_LIBRARIES,selected);
  assert.equal(isolated.graphics.DYLD_INSERT_LIBRARIES,selected);
  assert.ok(isolated.args.includes('DYLD_INSERT_LIBRARIES='+selected));
  assert.equal(isolated.environment.DYLD_LIBRARY_PATH,undefined);assert.equal(isolated.environment.UNRELATED_SECRET,undefined);
  assert.ok(isolated.profile.includes('(literal "'+selected+'")'));
  assert.match(isolated.profile,/\(deny network\*\)/);
  const fallback=await prepareIsolation(descriptor,storage,{networkAllowed:false},{graphics:{DYLD_INSERT_LIBRARIES:path.join(root,'absent.dylib')}});
  assert.deepEqual(fallback.graphics,{});assert.equal(fallback.environment.DYLD_INSERT_LIBRARIES,undefined);
});

test('native AIM controller preserves stdout failures and identifies the failed Android tool',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-error-'));
  try {
    const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),profile=path.join(root,'profile');
    fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
    fs.writeFileSync(ctl,'#!'+process.execPath+'\nconst a=process.argv.slice(2);if(a[2]==="run")setInterval(()=>{},1000);else if(a.includes("sys.boot_completed"))process.stdout.write("1\\n");else if(a.includes("get-started-user-state"))process.stdout.write("RUNNING_UNLOCKED\\n");else if(a.includes("/system/bin/settings")){process.stdout.write("Unable to change the secure setting\\n");process.exitCode=1;}\n',{mode:0o755});
    const config=path.join(root,'launch.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data:root,root:profile,packageName:'org.example.game',activity:'.Main',key:'example',apks:[path.join(root,'base.apk')]}));
    await assert.rejects(capture(keeper,[config],{timeout:10000}),/Android settings: Unable to change the secure setting/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('native AIM controller waits for the original user unlock state before settings, installation or Activity start',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-unlock-'));
  try {
    const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),profile=path.join(root,'profile');
    const log=path.join(root,'commands.jsonl'),state=path.join(root,'state.json'),started=path.join(root,'started');
    fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
    fs.writeFileSync(state,JSON.stringify({requested:false,queries:0}));
    fs.writeFileSync(ctl,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),state=${JSON.stringify(state)},started=${JSON.stringify(started)};
const s=JSON.parse(fs.readFileSync(state));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,state:s})+'\\n');
if(a[2]==='run')setInterval(()=>{if(fs.existsSync(started))process.exit(0)},50);
else if(a.includes('sys.boot_completed'))console.log('1');
else if(a.includes('get-started-user-state')){
  s.queries++;fs.writeFileSync(state,JSON.stringify(s));
  console.log(s.requested?(s.queries>=3?'RUNNING_UNLOCKED':'RUNNING_UNLOCKING'):'RUNNING_LOCKED');
}else if(a.includes('unlock-user')){
  if(a.slice(-2).join(' ')!=='unlock-user 0')process.exit(2);
  s.requested=true;fs.writeFileSync(state,JSON.stringify(s));console.log('Success: user unlocked');
}else{
  if(!s.requested||s.queries<3){console.error('application work before user unlock');process.exit(3);}
  if(a.includes('/system/bin/am')&&a.includes('start'))fs.writeFileSync(started,'1');
  console.log(a.includes('install-create')?'Success: created install session [42]':a.includes('start')?'Status: ok\\nComplete':'Success');
}
`,{mode:0o755});
    const apk=path.join(root,'base.apk');fs.writeFileSync(apk,'apk');
    const config=path.join(root,'launch.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data:path.join(root,'android'),root:profile,packageName:'org.example.game',activity:'.Main',key:'example',apks:[apk]}));
    assert.match(await capture(keeper,[config],{timeout:10000}),/Android game started/);
    const commands=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    const unlock=commands.findIndex(({args})=>args.includes('unlock-user'));
    assert.ok(unlock>0);
    assert.equal(commands.filter(({args})=>args.includes('unlock-user')).length,1);
    assert.ok(commands.slice(0,unlock).some(({args})=>args.includes('get-started-user-state')));
    const app=commands.filter(({args})=>args.includes('/system/bin/settings')||args.includes('/system/bin/pm')||(args.includes('/system/bin/am')&&args.includes('start')));
    assert.ok(app.length>=3);
    assert.ok(app.every(({state})=>state.requested&&state.queries>=3));
    assert.deepEqual(commands.find(({args})=>args.includes('unlock-user')).args.slice(-3),['/system/bin/am','unlock-user','0']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('native AIM controller refuses app startup after a credential unlock refusal or user-state Binder error',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  for(const scenario of ['credential','binder']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-locked-'));
    try{
      const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),profile=path.join(root,'profile'),log=path.join(root,'commands.jsonl');
      fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
      fs.writeFileSync(ctl,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[2]==='run')setInterval(()=>{},1000);
else if(a.includes('sys.boot_completed'))console.log('1');
else if(a.includes('get-started-user-state')){
  if(${JSON.stringify(scenario)}==='binder'){console.error('android.os.DeadObjectException: user service unavailable');process.exitCode=1;}
  else console.log('RUNNING_LOCKED');
}else if(a.includes('unlock-user'))console.error('Error: could not unlock user');
else{console.error('application work before user unlock');process.exitCode=3;}
`,{mode:0o755});
      const config=path.join(root,'launch.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data:root,root:profile,packageName:'org.example.game',activity:'.Main',key:'example',apks:[path.join(root,'base.apk')]}));
      await assert.rejects(capture(keeper,[config],{timeout:10000}),scenario==='credential'?/could not be unlocked[\s\S]*PIN, pattern or password[\s\S]*RUNNING_LOCKED[\s\S]*Error: could not unlock user/:/Android am: android\.os\.DeadObjectException: user service unavailable/);
      const commands=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(commands.some(args=>args.includes('get-started-user-state')));
      assert.equal(commands.some(args=>args.includes('/system/bin/settings')||args.includes('/system/bin/pm')||(args.includes('/system/bin/am')&&args.includes('start'))),false);
      assert.equal(fs.existsSync(path.join(profile,'runtime/aim-installed.json')),false);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('native AIM controller resolves an ambiguous original unlock refusal using the actual subsequent user state',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  for(const stateAfterRefusal of ['RUNNING_UNLOCKED','RUNNING_UNLOCKING','BOOTING','binder-error','unexpected-stderr']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-unlock-race-'));
    try{
      const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),profile=path.join(root,'profile');
      const log=path.join(root,'commands.jsonl'),state=path.join(root,'state.json'),started=path.join(root,'started');
      fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
      fs.writeFileSync(path.join(profile,'runtime/aim-installed.json'),JSON.stringify({key:'example'}));
      fs.writeFileSync(state,JSON.stringify({requested:false,queries:0,unlocked:false}));
      fs.writeFileSync(ctl,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),state=${JSON.stringify(state)},scenario=${JSON.stringify(stateAfterRefusal)};
const s=JSON.parse(fs.readFileSync(state));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,state:s})+'\\n');
if(a[2]==='run')setInterval(()=>{if(fs.existsSync(${JSON.stringify(started)}))process.exit(0)},50);
else if(a.includes('sys.boot_completed'))console.log('1');
else if(a.includes('get-started-user-state')){
  s.queries++;
  if(!s.requested)console.log('RUNNING_LOCKED');
  else if(scenario==='binder-error'){console.error('android.os.DeadObjectException: user query failed');process.exitCode=1;}
  else{const value=scenario==='RUNNING_UNLOCKING'&&s.queries>=3?'RUNNING_UNLOCKED':scenario;s.unlocked=value==='RUNNING_UNLOCKED';console.log(value);}
  fs.writeFileSync(state,JSON.stringify(s));
}else if(a.includes('unlock-user')){
  s.requested=true;fs.writeFileSync(state,JSON.stringify(s));
  console.error(scenario==='unexpected-stderr'?'android.os.SecurityException: unlock denied':'Error: could not unlock user');
}else{
  if(!s.unlocked){console.error('application work before actual unlocked state');process.exit(3);}
  if(a.includes('path'))console.log('package:/data/app/base.apk');
  else if(a.includes('/system/bin/am')&&a.includes('start')){console.log('Status: ok\\nComplete');fs.writeFileSync(${JSON.stringify(started)},'1');}
  else console.log('Success');
}
`,{mode:0o755});
      const config=path.join(root,'launch.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data:root,root:profile,packageName:'org.example.game',activity:'.Main',key:'example',apks:[path.join(root,'base.apk')]}));
      const succeeds=stateAfterRefusal==='RUNNING_UNLOCKED'||stateAfterRefusal==='RUNNING_UNLOCKING';
      if(succeeds)assert.match(await capture(keeper,[config],{timeout:10000}),/Android game started/);
      else await assert.rejects(capture(keeper,[config],{timeout:10000}),stateAfterRefusal==='BOOTING'?/BOOTING[\s\S]*Error: could not unlock user/:stateAfterRefusal==='binder-error'?/Android am: android\.os\.DeadObjectException: user query failed/:/Android am: android\.os\.SecurityException: unlock denied/);
      const commands=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(commands.filter(({args})=>args.includes('unlock-user')).length,1,'No unlock retry');
      const app=commands.filter(({args})=>args.includes('/system/bin/settings')||args.includes('/system/bin/pm')||(args.includes('/system/bin/am')&&args.includes('start')));
      assert.equal(app.length>0,succeeds);
      assert.ok(app.every(({state})=>state.unlocked),'Only the original unlocked state permits application work');
      if(stateAfterRefusal==='unexpected-stderr')assert.equal(commands.filter(({args})=>args.includes('get-started-user-state')).length,1,'Unrecognized errors are not ignored');
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('native AIM controller preserves ordinary Close and reports an original resident shutdown failure',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  for(const residentExit of [0,7]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-close-'));
    try{
      const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),profile=path.join(root,'profile');
      fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
      fs.writeFileSync(path.join(profile,'runtime/aim-installed.json'),JSON.stringify({key:'example'}));
      fs.writeFileSync(ctl,`#!${process.execPath}
const a=process.argv.slice(2);
if(a[2]==='run'){process.on('SIGTERM',()=>process.exit(${residentExit}));setInterval(()=>{},1000);}
else if(a.includes('sys.boot_completed'))console.log('1');
else if(a.includes('get-started-user-state'))console.log('RUNNING_UNLOCKED');
else if(a.includes('path'))console.log('package:/data/app/base.apk');
else console.log(a.includes('start')?'Status: ok\\nComplete':'Success');
`,{mode:0o755});
      const config=path.join(root,'launch.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data:root,root:profile,packageName:'org.example.game',activity:'.Main',key:'example',apks:[path.join(root,'base.apk')]}));
      const child=spawn(keeper,[config],{stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='',closed=false;
      child.stdout.on('data',bytes=>{stdout+=bytes;if(!closed&&stdout.includes('Android game started.')){closed=true;child.kill('SIGTERM');}});
      child.stderr.on('data',bytes=>{stderr+=bytes;});
      const timer=setTimeout(()=>child.kill('SIGTERM'),5000);
      let exit;
      try{exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}
      finally{clearTimeout(timer);}
      assert.equal(closed,true,'ordinary Close follows Activity start');
      assert.equal(exit.signal,null);
      assert.equal(exit.code,residentExit===0?0:1);
      if(residentExit===0)assert.equal(stderr,'');
      else assert.match(stderr,/Android shutdown failed[\s\S]*7/);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('native AIM controller rejects an unsuccessful original ActivityManager wait result even when the command exits zero',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper)},async()=>{
  for(const response of [
    {out:'Starting: Intent { cmp=org.example.game/.Main }\nStatus: timeout\nWaitTime: 10000\nComplete\n',error:'',expected:/activity did not finish starting[\s\S]*Status: timeout/},
    {out:'Starting: Intent { cmp=org.example.game/.Main }\n',error:'',expected:/did not report an activity launch result/},
    {out:'Status: ok\n',error:'Error: Activity not started, permission denied\n',expected:/Android am:[\s\S]*permission denied/},
  ]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-wait-result-'));
    try{
      const runtime=path.join(root,'runtime'),ctl=path.join(runtime,'bin/aimctl'),profile=path.join(root,'profile'),finished=path.join(root,'finished');
      fs.mkdirSync(path.dirname(ctl),{recursive:true});fs.mkdirSync(path.join(profile,'runtime'),{recursive:true});
      fs.writeFileSync(path.join(profile,'runtime/aim-installed.json'),JSON.stringify({key:'example'}));
      fs.writeFileSync(ctl,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),finished=${JSON.stringify(finished)};
if(a[2]==='run')setInterval(()=>{if(fs.existsSync(finished))process.exit(0)},25);
else if(a.includes('sys.boot_completed'))console.log('1');
else if(a.includes('get-started-user-state'))console.log('RUNNING_UNLOCKED');
else if(a.includes('path'))console.log('package:/data/app/base.apk');
else if(a.includes('/system/bin/am')&&a.includes('start')){
  process.stdout.write(${JSON.stringify(response.out)});process.stderr.write(${JSON.stringify(response.error)});fs.writeFileSync(finished,'1');
}else console.log('Success');
`,{mode:0o755});
      const config=path.join(root,'launch.json');fs.writeFileSync(config,JSON.stringify({schemaVersion:1,runtime,image:root,userdata:root,data:root,root:profile,packageName:'org.example.game',activity:'.Main',key:'example',apks:[path.join(root,'base.apk')]}));
      await assert.rejects(capture(keeper,[config],{timeout:10000}),response.expected);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});
