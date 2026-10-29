const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {createLauncher}=require('../src/core/launcher'),Host=require('../src/modules/android/host'),Sandbox=require('../src/modules/android/sandbox'),ReShade=require('../src/modules/shared/reshade');

test('UI dispatch, direct game context and diagnostic adapter preserve the same Android final spawn and sandbox', {skip:process.platform!=='darwin'},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'launch-context-parity-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const userDataDir=path.join(root,'profile'),runtime=path.join(root,'runtime'),jdk=path.join(root,'jdk'),java=path.join(jdk,'bin/java'),graphicsRoot=path.join(root,'processor'),core=path.join(graphicsRoot,'core.dylib');
 for(const p of [userDataDir,runtime,path.dirname(java),path.join(jdk,'lib'),graphicsRoot])fs.mkdirSync(p,{recursive:true});
 for(const p of [java,path.join(jdk,'lib/jspawnhelper'),core,path.join(runtime,'android-host.jar')])fs.writeFileSync(p,'fixture input');
 const game=path.join(root,'original.apk');fs.writeFileSync(game,'original archive');
 const plan={schema:1,mode:'advanced',video:[{id:'crt',kind:'shader',enabled:true,shader:{enabled:true,preset:'grayscale',parameters:{contrast:[0.75],channels:[0.2,0.2]}}}]};
 const entry={moduleId:'android',runtimeId:'klepton',gameType:'native',gameId:'same-game',gamePath:game,name:'Same game',effects:plan};
 const storage=path.join(userDataDir,'android/apps/same-game'),data=path.join(storage,'data'),files=path.join(data,'files'),cache=path.join(data,'cache');
 const resources=path.join(root,'resources'),assets=path.join(root,'assets'),native=path.join(root,'native');
 for(const p of [files,cache,resources,assets,native])fs.mkdirSync(p,{recursive:true});
 const converted=path.join(root,'converted.jar');fs.writeFileSync(converted,'converted');
 const prepared={metadata:{packageName:'org.example.same',versionName:'1',versionCode:1,launchers:[{activity:'org.example.same.Main'}]},convertedJar:converted,filesRoot:files,cacheRoot:cache,assetsRoot:assets,nativeRoot:native,resourcesRoot:resources,sourceApk:game};
 const effectRoot=path.join(userDataDir,'effects'),effectFile=path.join(effectRoot,'effect-plan.json');fs.mkdirSync(effectRoot);fs.writeFileSync(effectFile,JSON.stringify({schema:1,nodes:[{id:'crt',kind:'shader',enabled:true,parameters:plan.video[0].shader.parameters}]}));
 const manifest={id:'android',label:'Android',gameType:'native',runtime:{default:'klepton',supported:['klepton'],entries:{klepton:{graphicsHost:'explicit'}}}};
 let selected=true,prepareError=false,preparedCount=0,lastSpawn,lastSandbox,adapterCalls=0;
 t.mock.method(ReShade,'prepare',async(value,options)=>{
  preparedCount++;assert(selected);assert.deepEqual(value.effects,plan);assert.equal(options.graphicsHost,'explicit');assert.equal(options.explicitHost,true);assert.equal(options.root,graphicsRoot);
  if(prepareError)throw Error('Selected shader cannot be prepared');
  return {DYLD_INSERT_LIBRARIES:core,RESHADE_EXPLICIT_HOST:'1',RESHADE_EFFECT_PLAN:effectFile,RESHADE_EFFECT_PLAN_ROOT:effectRoot,RESHADE_CAPTURE_PREFIX:path.join(effectRoot,'frame-capture'),RESHADE_CAPTURE_TRIGGER:path.join(effectRoot,'frame-capture.request')};
 });
 t.mock.method(ReShade,'bindLaunchProcess',()=>{});
 const manager={id:'java',normalizeSettings:()=>({lines:{21:{}}}),core:{java:{resolveBestInstalled:()=>({javaPath:java,line:21,variant:'arm64',version:'21'})}}};
 const dependencies={manager,prepare:async()=>prepared,prepareInstalledServices:async()=>null,focusOwnedNativeGame:()=>{},
  prepareSandbox:async options=>{lastSandbox=await Sandbox.prepareSandbox({...options,config:{...options.config,title:undefined}});return lastSandbox;}};
 const payload={root:runtime,profile:{}},invoke=(_runtime,value,context)=>Host.launch(value,context,payload,dependencies);
 const mod={id:'android',manifest,runtimeManagers:[manager],resolveGraphicsInputs:()=>null,launchRuntime:invoke};
 const registry={listModules:()=>[manifest],getModule:()=>mod,getModuleInfo:()=>manifest};
 const launcher=createLauncher({userDataDir,registry,logger:{},rosetta:{requiresForExecutable:()=>false},spawn:(command,args,options)=>{
  lastSpawn={command,args,options};const child=new EventEmitter();Object.assign(child,{pid:process.pid,exitCode:null,signalCode:null,stderr:new PassThrough(),stdout:new PassThrough(),ref(){},unref(){},kill(){assert.fail('No process signalling in parity fixture');}});queueMicrotask(()=>child.emit('spawn'));return child;
 }});
 const settings={modules:{},runtimes:{}},runtimeSettings={networkIsolation:true,execution:'jvm'};
 const diagnostic=async(command,args,options,translation,next)=>{adapterCalls++;assert.equal(options.env.RESHADE_EFFECT_PLAN,selected&&!prepareError?effectFile:undefined);assert.equal(options.networkIsolation,true);const environment={...options.env,DIAGNOSTIC_FIXTURE:'1'};for(const key of Object.keys(environment))if(key.startsWith('RESHADE_')||key==='DYLD_INSERT_LIBRARIES')delete environment[key];return next(command,[...args,'--diagnostic-fixture'],{...options,env:environment,networkIsolation:false},translation);};
 async function run(mode){
  const options={settings,autoInstallRuntime:false,runtimeId:'klepton',runtimeSettings,graphicsRuntimeRoot:graphicsRoot,...(mode==='diagnostic'?{processAdapter:diagnostic}:{})};
  const child=mode==='ui'?(await launcher.launchEntry(entry,options)).child:await invoke('klepton',entry,launcher.getGameLaunchContext(entry,settings,options));
  const output={command:lastSpawn.command,args:lastSpawn.args.filter(arg=>arg!=='--diagnostic-fixture'),env:{...lastSpawn.options.env},cwd:lastSpawn.options.cwd,profile:lastSandbox.profile,graphics:{...lastSandbox.graphics},config:JSON.parse(fs.readFileSync(path.join(storage,'launch.json')))};
  delete output.env.DIAGNOSTIC_FIXTURE;child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);return output;
 }
 const oldSecret=process.env.MACLAUNCHER_PARITY_SECRET,oldDYLD=process.env.DYLD_INSERT_LIBRARIES;process.env.MACLAUNCHER_PARITY_SECRET='must-not-forward';process.env.DYLD_INSERT_LIBRARIES='/ambient/forbidden.dylib';
 t.after(()=>{for(const [key,value] of [['MACLAUNCHER_PARITY_SECRET',oldSecret],['DYLD_INSERT_LIBRARIES',oldDYLD]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const ui=await run('ui'),direct=await run('direct'),observed=await run('diagnostic');assert.deepEqual(direct,ui);assert.deepEqual(observed,ui);assert.equal(adapterCalls,1);assert.equal(preparedCount,3,'One lazy preparation per launch');
 assert.equal(ui.env.RESHADE_EFFECT_PLAN,effectFile);assert.equal(ui.env.RESHADE_EXPLICIT_HOST,'1');assert.equal(ui.env.RESHADE_CAPTURE_PREFIX,path.join(cache,'graphics/frame-capture'));assert.equal(ui.env.RESHADE_CAPTURE_TRIGGER,path.join(cache,'graphics/frame-capture.request'));assert.equal(ui.env.DYLD_INSERT_LIBRARIES,core);
 assert.equal(ui.env.MACLAUNCHER_PARITY_SECRET,undefined);assert(!JSON.stringify(ui).includes('/ambient/forbidden.dylib'));assert(ui.profile.includes('(deny network*)'));assert(ui.profile.includes('(literal "'+effectFile+'")'));assert(ui.profile.includes('(literal "'+core+'")'));assert.equal(ui.config.graphicsLibrary,core);assert(ui.args.includes('maclauncher.android.Host'));assert.deepEqual(JSON.parse(fs.readFileSync(effectFile)).nodes[0].parameters,plan.video[0].shader.parameters);
 selected=false;delete entry.effects;const plain=await run('ui');assert.deepEqual(await run('direct'),plain);assert.deepEqual(await run('diagnostic'),plain);assert.equal(preparedCount,3,'Unfiltered routes do not prepare graphics');assert.equal(plain.env.RESHADE_EFFECT_PLAN,undefined);assert.equal(plain.env.DYLD_INSERT_LIBRARIES,undefined);
 selected=true;entry.effects=plan;prepareError=true;for(const mode of ['ui','direct','diagnostic']){lastSpawn=null;const failed=await run(mode);assert.notEqual(lastSpawn,null,'Graphics is additive: a failed selection still starts the original game');assert.deepEqual(failed,plain,'Failed preparation leaves the original unfiltered launch');assert.equal(failed.env.RESHADE_EFFECT_PLAN,undefined);}
});
