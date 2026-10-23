const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Android native DNS and WebKit use the same advertising host boundaries',async t=>{
  if(process.platform!=='darwin')return t.skip('Requires macOS');
  const java=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!java)return t.skip('Requires Java development headers');
  const root=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-ad-policy');
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-ad-policy-')));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareNetworkPolicy}=await import('../src/modules/android/native/network-policy-source.mjs');prepareNetworkPolicy(temporary);
  const run=(command,args,options={})=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,...options});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const includes=['-I'+root,'-I'+temporary,'-I'+path.join(java,'include'),'-I'+path.join(java,'include/darwin')];
  run('clang',['-std=c11',...includes,'-c',path.join(root,'network-policy.c'),'-o',path.join(temporary,'policy.o')]);
  run('clang',['-std=c11',...includes,path.join(fixture,'resolver.c'),path.join(temporary,'policy.o'),'-o',path.join(temporary,'resolver')]);
  for(const mode of ['deny','allow'])assert.match(run(path.join(temporary,'resolver'),[mode]),/PASS shared host policy/);
  run('clang++',['-std=c++20','-fobjc-arc',...includes,path.join(fixture,'web-rules.mm'),path.join(temporary,'policy.o'),'-framework','WebKit','-framework','Foundation','-o',path.join(temporary,'web-rules')]);
  const cache=path.join(temporary,'cache');fs.mkdirSync(cache);
  const storage=path.join(temporary,'libandroid-storage.dylib');
  run('clang',['-std=c11','-dynamiclib','-mmacosx-version-min=13.0',path.join(root,'native-storage.c'),'-o',storage]);
  const {profile}=require('../src/modules/shared/runtime/macos-sandbox');
  // The same dirhelper permission required by Metal makes WebKit prefer confstr
  // over TMPDIR. Its intermediate NFA files must still use private storage.
  const policy=profile({readDirectories:[temporary],readFiles:[],writeDirectories:[cache],executables:['/usr/bin/env',path.join(temporary,'web-rules')],
    blockNetwork:true,machServices:['com.apple.bsd.dirhelper','com.apple.system.opendirectoryd.membership',
      'com.apple.WebKit.WebContent','com.apple.WebKit.Networking','com.apple.WebKit.GPU','com.apple.nsurlsessiond']});
  assert.match(run('/usr/bin/sandbox-exec',['-p',policy,'/usr/bin/env','DYLD_INSERT_LIBRARIES='+storage,path.join(temporary,'web-rules'),cache],
    {cwd:cache,env:{PATH:'/usr/bin:/bin',HOME:cache,CFFIXED_USER_HOME:cache,TMPDIR:cache+'/'}}),/PASS shared WebKit ad rules compile/);
});
