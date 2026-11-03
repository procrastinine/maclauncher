const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const GodotManager = require('../src/modules/godot/runtime/godot-runtime-manager');
const LoveManager = require('../src/modules/love/runtime/love-runtime-manager');
const NwManager = require('../src/modules/shared/web/runtime/nwjs-manager');
const Godot = GodotManager.core, Love = LoveManager.core, Nw = NwManager.core;
const {createRuntimeUseScope,withRuntimeUseScope,withRuntimeCoordinator,withRuntimeMutation} = require('../src/core/coordinated-runtime-managers');

test('runtime listings reuse only their launch scope, return independent rows and refresh across existing mutation/bind/release boundaries', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-listing-scope-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const platform=process.arch==='arm64'?'osx-arm64':'osx-x64';
  function bundle(app,name){
    fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});
    fs.mkdirSync(path.join(app,'Contents/Resources/deep'),{recursive:true});
    const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x0100000c,4);bytes.writeUInt32LE(2,12);
    fs.writeFileSync(path.join(app,'Contents/MacOS',name),bytes,{mode:0o755});
    fs.writeFileSync(path.join(app,'Contents/Info.plist'),`<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleShortVersionString</key><string>11.5</string></dict></plist>`);
    return app;
  }
  const godot=version=>bundle(path.join(Godot.getInstallDir({userDataDir:root,version,variant:'standard'}),'Godot.app'),'godot');
  const love=version=>bundle(path.join(Love.getInstallDir({userDataDir:root,version,channel:'stable'}),'love.app'),'love');
  const nw=version=>bundle(path.join(Nw.installRootDir(root),version,platform,'sdk/nwjs.app'),'nwjs');
  godot('4.4.1');love('11.4');nw('0.91.0');
  const newest=[godot('4.5.0'),love('11.5'),nw('0.92.0')];
  const counters={};let registrationReads=0;
  for(const name of ['statSync','lstatSync','realpathSync','readdirSync','readFileSync']){
    const original=fs[name];counters[name]=0;
    t.mock.method(fs,name,(...args)=>{
      if(name==='statSync'&&path.basename(String(args[0]))==='custom-runtimes.json')registrationReads++;
      else counters[name]++;
      return original(...args);
    });
  }
  const total=()=>Object.values(counters).reduce((sum,value)=>sum+value,0);
  const read=()=>[Godot.listInstalled(root),Love.listInstalledStable(root),Love.listInstalledNightly(root),Nw.listInstalled(root)];
  read();const unscoped=total();read();assert.ok(total()>unscoped,'Outside a launch every listing still observes current files');
  const coordinator={acquireMutation:async()=> 'fixture-mutation',release:async()=>{}};
  const scope=createRuntimeUseScope({coordinator,managers:[],userDataDir:root});
  await withRuntimeCoordinator(coordinator,root,()=>withRuntimeUseScope(scope,async()=>{
    const first=read(),warm={...counters},registrations=registrationReads;
    first[0][0].ready=false;first[1][0].version='poison';first[3].push({version:'poison'});
    const second=read();
    assert.deepEqual(counters,warm,'A repeated listing must perform no directory, plist, executable or identity file checks');
    assert.equal(registrationReads,registrations+4,'Existing outer custom registration checks must remain current');
    assert.equal(second[0][0].ready,true);assert.equal(second[1][0].version,'11.5');assert.equal(second[3].length,2);
    assert.deepEqual(second[2],[],'Stable/nightly methods have separate keys');
    assert.deepEqual(Godot.listInstalled(path.join(root,'another-profile')),[],'Profile paths have separate keys');
    const outside=path.join(root,'outside');fs.writeFileSync(outside,'retained');
    await withRuntimeMutation({managerId:'love',version:'11.5'},async()=>{
      const during=total();read();const once=total();read();assert.ok(total()>once&&once>during,'Mutating preparations bypass per-launch reuse');
      for(const app of newest)fs.symlinkSync(outside,path.join(app,'Contents/Resources/deep/unsafe'));
    });
    const changed=read();
    for(const [rows,version] of [[changed[0],'4.5.0'],[changed[1],'11.5'],[changed[3],'0.92.0']])
      assert.equal(rows.find(row=>row.version===version).ready,false,'Changed newest bundles remain visibly damaged');
    assert.equal(GodotManager.getState({userDataDir:root,settings:{defaultVariant:'standard'}}).catalog.latestInstalledVersion,'4.4.1');
    assert.equal(LoveManager.getState({userDataDir:root,settings:{}}).sections.find(row=>row.id==='stable').catalog.latestInstalledVersion,'11.4');
    assert.equal(NwManager.getState({userDataDir:root,settings:{}}).catalog.latestInstalledVersion,'0.91.0');
    assert.equal(Nw.resolveBestInstalled({userDataDir:root,platform:'darwin',arch:process.arch}).version,'0.91.0');
    const refreshed={...counters};read();assert.deepEqual(counters,refreshed,'Post-mutation rows can be reused in the same remaining scope');
    await scope.bind(12345);const bound=total();read();const afterBound=total();read();assert.ok(total()>afterBound&&afterBound>bound,'Binding clears and disables reuse');
    await scope.release();const released=total();read();assert.ok(total()>released,'Released scopes do not retain a listing');
  }));
});
