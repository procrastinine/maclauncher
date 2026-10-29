const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {browserGraphicsEnvironment, ENV, TOKEN} = require('../src/modules/shared/web/runtime/browser-graphics');
function fixture(t, api=1) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'libreshade-macos.dylib'),'fixture');
  fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({features:{graphics:{browserFrameAPI:api}}}));
  fs.writeFileSync(path.join(root,'launch.json'),JSON.stringify({launchId:'12345678-1234-1234-1234-123456789abc'}));
  return {root,env:{DYLD_INSERT_LIBRARIES:path.join(root,'libreshade-macos.dylib'),RESHADE_CONTROL_FILE:path.join(root,'controls'),RESHADE_WINDOW_STATE:path.join(root,'window-state')}};
}
test('dedicated host opts in only to selected completed-source API and private launch token',t=>{
  const {env}=fixture(t);const result=browserGraphicsEnvironment(env,{platform:'darwin'});
  assert.match(result[TOKEN],/^[a-f0-9]{32}$/);
  const bytes=fs.readFileSync(result[ENV]);assert.equal(bytes.length,64);assert.equal(bytes.subarray(0,8).toString(),'MLBRSRC1');
  assert.equal(bytes.subarray(8,24).toString('hex'),result[TOKEN]);assert.equal(bytes.readUInt32LE(32),0);
  assert.equal(fs.statSync(result[ENV]).mode&0o777,0o600);
  assert.equal(env[ENV],undefined); // No launcher/global environment mutation.
});
test('older/missing native payload retains existing source and strips inherited opt-in',t=>{
  const {env}=fixture(t,0);const input={...env,[ENV]:'/stale',[TOKEN]:'bad'};
  const result=browserGraphicsEnvironment(input,{platform:'darwin'});assert.equal(result[ENV],undefined);assert.equal(result[TOKEN],undefined);
});
test('absent graphics preparation and non-Mac host create no browser state',t=>{
  const {root,env}=fixture(t);const before=fs.readdirSync(root);
  assert.equal(browserGraphicsEnvironment({...env,RESHADE_CONTROL_FILE:undefined},{platform:'darwin'})[ENV],undefined);
  assert.equal(browserGraphicsEnvironment(env,{platform:'linux'})[ENV],undefined);
  assert.deepEqual(fs.readdirSync(root),before);
});

test('real core final and process-adapter merges retain only this browser launch channel', {skip:process.platform!=='darwin'}, async t=>{
  const {createLauncher}=require('../src/core/launcher');
  const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
  const {TOKEN_ENV,PROTOCOL_PREFIX}=require('../src/core/hosted-process');
  const ReShade=require('../src/modules/shared/reshade');
  const {prepareBrowserGraphicsEnvironment}=require('../src/modules/shared/web/runtime/browser-graphics');
  const first=fixture(t), second=fixture(t), calls=[];
  const selected=new Map([['first',first.env],['second',second.env]]);
  t.mock.method(ReShade,'prepare',async entry=>selected.get(entry.gameId));
  const manifest={id:'browser-test',runtime:{default:'browser',supported:['browser'],entries:{browser:{graphicsHost:'remote'}}}};
  const registry={listModules:()=>[manifest],getModule:()=>({id:manifest.id,manifest}),getModuleInfo:()=>manifest};
  const launcher=createLauncher({userDataDir:path.join(first.root,'profile'),registry,
    rosetta:{requiresForExecutable:()=>false},logger:{warn(){},info(){}},
    spawn:(command,args,options)=>{calls.push(options.env);const child=new EventEmitter();child.unref=child.ref=()=>{};
      // Default network isolation waits for the sandbox bootstrap acknowledgement.
      child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdio=[null,child.stdout,child.stderr,new PassThrough()];
      process.nextTick(()=>{child.emit('spawn');child.stdio[3].write('isolated\n');});
      if(options.cwd)setImmediate(()=>child.stdout.write(`${PROTOCOL_PREFIX}${options.env[TOKEN_ENV]} ${JSON.stringify({protocol:1,status:'ready',host:'nwjs',nativeWindowLoaded:true,url:require('node:url').pathToFileURL(path.join(options.cwd,'index.html')).href})}\n`));
      return child;}});
  const context=id=>launcher.getLaunchContext({moduleId:manifest.id,gameId:id,gamePath:first.root,reshade:{enabled:true,preset:'grayscale'}},launcher.loadSettings(),
    {runtimeId:'browser',gameEffects:true,processAdapter:async(cmd,args,options,translation,launch)=>
      launch(cmd,args,{...options,env:{...options.env,RESHADE_STALE:'must be removed'}},translation)});
  const a=context('first'), base={KEEP:'yes',RESHADE_BROWSER_FRAME_STATE:'/another/game',RESHADE_BROWSER_FRAME_TOKEN:'0'.repeat(32)};
  const prepared=await prepareBrowserGraphicsEnvironment(a,base);
  assert.ok(prepared[ENV]);assert.notEqual(prepared[ENV],base[ENV]);
  const again=await prepareBrowserGraphicsEnvironment(a,base);
  assert.equal(again[ENV],prepared[ENV]);assert.equal(again[TOKEN],prepared[TOKEN]);
  await a.spawnDetachedChecked('/owned/browser',[],{env:prepared,networkIsolationApplied:true});
  assert.equal(calls[0][ENV],prepared[ENV]);assert.equal(calls[0][TOKEN],prepared[TOKEN]);
  assert.equal(calls[0].RESHADE_STALE,undefined);assert.equal(calls[0].KEEP,'yes');
  const b=context('second'), next=await prepareBrowserGraphicsEnvironment(b,prepared);
  const wrapper=path.join(second.root,'wrapper');fs.mkdirSync(wrapper);
  fs.writeFileSync(path.join(wrapper,'package.json'),JSON.stringify({main:'index.html'}));fs.writeFileSync(path.join(wrapper,'index.html'),'<title>NW source</title>');
  await require('../src/modules/shared/web/runtime/nwjs-process').launchNwjsProcess({executable:'/owned/nwjs',args:[wrapper],wrapperDir:wrapper,
    context:b,spawn:b.spawnDetachedChecked,env:next,timeoutMs:1000});
  assert.equal(calls[1][ENV],next[ENV]);assert.notEqual(next[ENV],prepared[ENV]);assert.notEqual(next[TOKEN],prepared[TOKEN]);
  assert.equal(first.env[ENV],undefined);assert.equal(second.env[ENV],undefined);assert.equal(base[ENV],'/another/game');
});
