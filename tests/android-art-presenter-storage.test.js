const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');

test('ART presenter retains selected graphics with or without its storage adapter',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'presenter-selection-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {nativePresenterEntry}=await import('../src/modules/android/art/composition.mjs');
  const application={executablePath:'/owned/presenter'},args=['--app'];
  const selected='/selected/core.dylib:/selected/audio.dylib';
  assert.deepEqual(nativePresenterEntry({root},application,args,{}),{command:application.executablePath,args});
  assert.deepEqual(nativePresenterEntry({root},application,args,{DYLD_INSERT_LIBRARIES:selected}),
    {command:'/usr/bin/env',args:['DYLD_INSERT_LIBRARIES='+selected,application.executablePath,...args]});
  const storage=path.join(root,'native/libandroid-storage.dylib');fs.mkdirSync(path.dirname(storage));fs.writeFileSync(storage,'storage');
  const entry=nativePresenterEntry({root},application,args,{DYLD_INSERT_LIBRARIES:storage+':'+selected});
  assert.equal(entry.args[0],'DYLD_INSERT_LIBRARIES='+storage+':'+selected);
});

test('ART presenter compiles original WebKit isolation rules within private scratch storage',{
  skip:process.platform!=='darwin',
},async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-presenter-storage-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const native=path.join(root,'native'),temporary=path.join(root,'tmp'),store=path.join(root,'rules'),home=path.join(root,'home');
  for(const directory of [native,temporary,store,home])fs.mkdirSync(directory);
  const library=path.join(native,'libandroid-storage.dylib'),probe=path.join(root,'probe');
  const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,...options});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
  run('clang',['-dynamiclib','-O2','-mmacosx-version-min=13.0',path.join(__dirname,'../src/modules/android/native/native-storage.c'),'-o',library]);
  run('clang++',['-fobjc-arc','-framework','AppKit','-framework','WebKit',path.join(__dirname,'fixtures/android-sandbox/ContentRuleListProbe.mm'),'-o',probe]);
  const {nativePresenterEntry}=await import('../src/modules/android/art/composition.mjs');
  const env={PATH:'/usr/bin:/bin',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:temporary};
  const entry=nativePresenterEntry({root},{executablePath:probe},[store],env);
  assert.equal(entry.command,'/usr/bin/env');assert.equal(entry.args[0],'DYLD_INSERT_LIBRARIES='+library);
  const chained=nativePresenterEntry({root},{executablePath:probe},[store],{...env,DYLD_INSERT_LIBRARIES:'/existing.dylib'});
  assert.equal(chained.args[0],'DYLD_INSERT_LIBRARIES='+library+':/existing.dylib');
  const policy=path.join(root,'sandbox.sb');
  fs.writeFileSync(policy,require('../src/modules/shared/runtime/macos-sandbox').profile({
    readDirectories:[root],readFiles:[],writeDirectories:[temporary,store,home],executables:[entry.command,probe],blockNetwork:true,
  }));
  const r=run('/usr/bin/sandbox-exec',['-f',policy,entry.command,...entry.args],{env});
  assert.match(r.stdout,/PASS private WebKit compiler scratch and offline rules/);
  assert.ok(fs.readdirSync(store).some(name=>name.startsWith('ContentRuleList')));
});

