const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const{spawnSync}=require('./helpers/android-java');
function run(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stdout+r.stderr,/FATAL ERROR in native method/);return r.stdout;}
test('Network state publishes matching revisions, coalesces unchanged paths and ends at terminal close',t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS queue and property types');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-network-owner-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const executable=path.join(temp,'snapshot');
 run('/usr/bin/clang',['-std=c11','-fblocks','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native'),path.join(__dirname,'fixtures/android-framework-services/ConnectivitySnapshotOwner.c'),'-framework','Network','-framework','SystemConfiguration','-framework','CoreFoundation','-o',executable]);
 assert.match(run(executable,[]),/PASS offline network state publication, matching revisions, coalescing and terminal close/);
});
test('Passive native connectivity publishes a complete first generation without blocking readers',t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS route APIs');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-first-route-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const executable=path.join(temp,'route');
 run('/usr/bin/clang',['-fblocks','-I'+path.resolve(__dirname,'../src/modules/android/native'),path.join(__dirname,'fixtures/android-framework-services/ConnectivityFirstSnapshot.c'),'-framework','Network','-framework','SystemConfiguration','-framework','CoreFoundation','-o',executable]);
 const baseline=run(executable,[]);assert.match(baseline,/PASS complete passive route snapshot/);
 const policy=path.join(temp,'network.sb');
 fs.writeFileSync(policy,require('../src/modules/shared/runtime/macos-sandbox').profile({readDirectories:[],readFiles:[],writeDirectories:[temp],executables:[executable],blockNetwork:false}));
 const confined=run('/usr/bin/sandbox-exec',['-f',policy,executable]);
 // The real production sandbox must preserve both route and transport metadata:
 // a reachable route alone is insufficient for Android's active NetworkInfo.
 assert.equal(Number(confined.match(/state=(\d+)/)[1]),Number(baseline.match(/state=(\d+)/)[1]),'Sandbox hid passive network interface state');
});
