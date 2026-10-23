const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events');
const { webUrl, attachWebLinks, advertisingUrl } = require('../src/modules/android/web-links');
const Host = require('../src/modules/android/host');
const Sandbox = require('../src/modules/android/sandbox');
const { runtimeProfile } = require('../src/modules/android/profile');
const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = value => { const bytes=Buffer.from(value),out=Buffer.alloc(bytes.length+2);out.writeUInt16BE(bytes.length);bytes.copy(out,2);return out; };
function child(){const result=new EventEmitter();result.stdio=[null,null,null,new PassThrough()];return result;}

test('Android browser requests are versioned and cannot override network isolation', async () => {
  const prepared={metadata:{packageName:'owned.app',launchers:[{activity:'owned.app.Main'}]}};
  const config=(profile,settings)=>Host.launchConfig({},prepared,{root:'/runtime',profile},settings);
  assert.equal(config({},{}).webLinksAllowed,undefined);
  assert.equal(config({webLinksVersion:1},{}).webLinksAllowed,0);
  assert.equal(config({webLinksVersion:1},{networkIsolation:true}).webLinksAllowed,0);
  assert.equal(config({webLinksVersion:1},{networkIsolation:false}).webLinksAllowed,1);
  assert.equal(config({},{}).networkAllowed,undefined);
  assert.equal(config({webViewVersion:1},{}).networkAllowed,0);
  assert.equal(config({webViewVersion:1},{networkIsolation:true}).networkAllowed,0);
  assert.equal(config({webViewVersion:1},{networkIsolation:false}).networkAllowed,1);
  assert.equal(config({adPolicyVersion:1},{}).allowAds,0);
  assert.equal(config({adPolicyVersion:1},{allowAds:true}).allowAds,1);
  assert.equal(config({},{}).allowAds,undefined);
  assert.throws(()=>config({adPolicyVersion:2},{}),/advertising policy profile/);
  assert.equal(runtimeProfile({version:'1',javaMajor:21,adPolicyVersion:1}).adPolicyVersion,1);
  const manifest=require('../src/modules/android/manifest.json');
  const settings=manifest.runtime.entries.klepton.settings;
  assert.equal(settings.defaults.allowAds,false);
  assert.notEqual(settings.fields.find(field=>field.key==='allowAds').gameOnly,true);
  const {resolveRuntimeSettingsForEntry}=require('../src/core/runtime-settings');
  const defaults={modules:{android:{runtimeSettings:{klepton:{allowAds:true}}}}};
  assert.equal(config({adPolicyVersion:1},resolveRuntimeSettingsForEntry({},defaults,manifest,'klepton')).allowAds,1);
  assert.equal(config({adPolicyVersion:1},resolveRuntimeSettingsForEntry({runtimeSettings:{klepton:{allowAds:false}}},defaults,manifest,'klepton')).allowAds,0);
  assert.equal(config({adPolicyVersion:1},resolveRuntimeSettingsForEntry({}, {},manifest,'klepton')).allowAds,0);
  assert.throws(()=>config({webViewVersion:2},{}),/web-view profile/);
  assert.throws(()=>config({webLinksVersion:2},{}),/web-link profile/);
  assert.equal(runtimeProfile({version:'1',javaMajor:21,webLinksVersion:1}).webLinksVersion,1);
  assert.equal(runtimeProfile({version:'1',javaMajor:21,frameworkBaseVersion:1,canvasPresentationVersion:1,webViewVersion:1}).webViewVersion,1);
  assert.throws(()=>runtimeProfile({version:'1',javaMajor:21,webViewVersion:1}),/web views profile/);
  await assert.rejects(Sandbox.prepareSandbox({config:{webLinksAllowed:1},blockNetwork:true}),/cannot bypass/);
});

test('Android browser broker accepts only bounded credential-free HTTP(S) URLs', () => {
  assert.equal(webUrl('https://example.invalid/資料'), 'https://example.invalid/%E8%B3%87%E6%96%99');
  assert.equal(webUrl('https://%E4%BE%8B%E3%81%88.%E3%83%86%E3%82%B9%E3%83%88:8443/privacy'), 'https://xn--r8jz45g.xn--zckzah:8443/privacy');
  assert.equal(webUrl('https://b%C3%BCcher.example:443/help'), 'https://xn--bcher-kva.example/help');
  assert.equal(webUrl('https://[::1]:8443/help'), 'https://[::1]:8443/help');
  for(const value of ['file:///tmp/file','javascript:alert(1)','mailto:name@example.invalid','https://name:password@example.invalid','https://example.invalid/\n','https://example.invalid/%0a','https://example.invalid\\bad','http://host:99999','https://','x'.repeat(8193)])assert.equal(webUrl(value),null,value);
});

test('Android launch connects the browser pipe to existing UI services and captures network policy', async t => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-link-launch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'android-host.jar'),'owned');
  const java={line:21,variant:'arm64',version:'21',javaPath:'/jdk/bin/java',installDir:'/jdk'};
  const manager={id:'java',core:{java:{resolveBestInstalled:()=>java}},normalizeSettings:()=>({lines:{21:{defaultVersion:null}}})};
  const prepared={metadata:{packageName:'owned.app',launchers:[{activity:'owned.app.Main'}]},filesRoot:root,cacheRoot:root};
  const opened=[],prompts=[];let running,wire,policy;
  const shell={openExternal:async function(url){assert.equal(this,shell);opened.push(url);}};
  const context={userDataDir:root,settings:{},runtimeSettings:{networkIsolation:false},ui:{shell},getGameEffectsEnvironment:async()=>({}),
    spawnDetachedChecked:async(command,args,options)=>{assert.deepEqual(options.stdio,['ignore','ignore','pipe','pipe']);wire=JSON.parse(fs.readFileSync(args.at(-1)));running=child();return running;}};
  const dependencies={manager,prepare:async()=>prepared,focusOwnedNativeGame:()=>{},confirmGameLink:async(process,options)=>{assert.equal(process,running);prompts.push(options);return true;},prepareSandbox:async value=>{
    policy=value.blockNetwork;return{command:'owned',prefix:[],javaArguments:[],environment:{},graphics:{}};}};
  await Host.launch({gameId:'links'},context,{root,profile:{webLinksVersion:1}},dependencies);
  assert.equal(wire.webLinksAllowed,1);assert.equal(policy,false);
  running.stdio[3].write(frame('https://googleads.g.doubleclick.net/advert'));await tick();assert.equal(prompts.length,0);assert.equal(opened.length,0);
  running.stdio[3].write(frame('https://example.invalid/open'));assert.equal(opened.length,0);await tick();assert.equal(opened.length,1);
  assert.equal(prompts.length,1);assert.equal(prompts[0].executablePath,java.javaPath);assert.equal(prompts[0].url,'https://example.invalid/open');assert.ok(prompts[0].launchedAt>0);running.emit('exit',0,null);
  context.runtimeSettings.networkIsolation=true;
  await Host.launch({gameId:'links'},context,{root,profile:{webLinksVersion:1}},dependencies);
  assert.equal(wire.webLinksAllowed,0);assert.equal(policy,true);running.stdio[3].write(frame('https://example.invalid/blocked'));await tick();assert.equal(opened.length,1);running.emit('exit',0,null);
  context.runtimeSettings.networkIsolation=false;
  context.ui={};
  await Host.launch({gameId:'links'},context,{root,profile:{webLinksVersion:1,webViewVersion:1}},dependencies);
  assert.equal(wire.webLinksAllowed,0);assert.equal(wire.networkAllowed,1);assert.equal(policy,false);running.emit('exit',0,null);
  context.networkAllowed=false;
  await Host.launch({gameId:'links'},context,{root,profile:{webLinksVersion:1,webViewVersion:1}},dependencies);
  assert.equal(wire.webLinksAllowed,0);assert.equal(wire.networkAllowed,0);assert.equal(policy,true);running.emit('exit',0,null);
  delete context.runtimeSettings;context.networkAllowed=true;context.ui={shell};
  await Host.launch({gameId:'links'},context,{root,profile:{webLinksVersion:1,webViewVersion:1}},dependencies);
  assert.equal(wire.webLinksAllowed,0);assert.equal(wire.networkAllowed,0);assert.equal(policy,true);
  running.stdio[3].write(frame('https://example.invalid/no-per-game-consent'));await tick();assert.equal(opened.length,1);running.emit('exit',0,null);
});

test('Android browser broker requires consent, drops concurrent requests and retires pending approval', async () => {
  const process=child(),opened=[],requested=[];let time=1000,approve;
  attachWebLinks(process,{allowed:true,now:()=>time,confirmOpen:value=>{requested.push(value);return new Promise(resolve=>approve=resolve);},openExternal:async value=>opened.push(value)});
  const bytes=frame('https://example.invalid/one');
  for(const part of [bytes.subarray(0,1),bytes.subarray(1,7),bytes.subarray(7)])process.stdio[3].write(part);
  await tick();assert.deepEqual(opened,[]);assert.deepEqual(requested,['https://example.invalid/one']);
  process.stdio[3].write(frame('https://other.invalid/'));await tick();assert.equal(requested.length,1);
  approve(false);await tick();assert.deepEqual(opened,[]);
  process.stdio[3].write(bytes);await tick();assert.equal(requested.length,1);
  time+=60000;process.stdio[3].write(bytes);await tick();approve(true);await tick();assert.deepEqual(opened,['https://example.invalid/one']);
  process.emit('exit',0,null);assert.equal(process.stdio[3].destroyed,true);assert.equal(process.listenerCount('exit'),0);
  for(const options of [{allowed:false,confirmOpen:async()=>true},{allowed:true}]){const denied=child();attachWebLinks(denied,{...options,openExternal:()=>{throw Error('must not open');}});denied.stdio[3].write(bytes);await tick();assert.equal(denied.stdio[3].destroyed,true);}
  const invalid=child();attachWebLinks(invalid,{allowed:true,confirmOpen:async()=>true,openExternal:()=>{throw Error('must not open');}});invalid.stdio[3].write(Buffer.from([0xff,0xff]));assert.equal(invalid.stdio[3].destroyed,true);
  const closing=child();attachWebLinks(closing,{allowed:true,confirmOpen:()=>new Promise(resolve=>approve=resolve),openExternal:()=>{throw Error('retired request');}});
  closing.stdio[3].write(bytes);await tick();closing.emit('exit',0,null);approve(true);await tick();
});

test('Advertising redirects are silent by default and allowing ads never opens a browser automatically', async () => {
  for(const host of ['doubleclick.net','googleads.g.doubleclick.net','DOUBLECLICK.NET.','pagead2.googlesyndication.com','www.googleadservices.com'])assert.equal(advertisingUrl('https://'+host+'/'),true,host);
  for(const host of ['notdoubleclick.net','doubleclick.net.example.invalid','example.invalid'])assert.equal(advertisingUrl('https://'+host+'/'),false,host);
  const process=child(),requested=[],opened=[];
  attachWebLinks(process,{allowed:true,confirmOpen:async value=>{requested.push(value);return true;},openExternal:async value=>opened.push(value)});
  for(let i=0;i<100;i++)process.stdio[3].write(frame('https://googleads.g.doubleclick.net/'+i));
  await tick();assert.deepEqual(requested,[]);assert.deepEqual(opened,[]);assert.equal(process.stdio[3].destroyed,false);
  process.stdio[3].write(frame('https://example.invalid/privacy'));await tick();assert.equal(requested.length,1);assert.equal(opened.length,1);process.emit('exit',0,null);
  const optedIn=child();let approve;
  attachWebLinks(optedIn,{allowed:true,allowAds:true,confirmOpen:()=>new Promise(resolve=>approve=resolve),openExternal:async value=>opened.push(value)});
  optedIn.stdio[3].write(frame('https://doubleclick.net/'));await tick();assert.equal(opened.length,1);approve(true);await tick();assert.equal(opened.length,2);optedIn.emit('exit',0,null);
});

