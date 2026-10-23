const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');

test('A retired descriptor-transfer receipt cannot retire the application authority channel',{
  skip:process.platform!=='darwin',timeout:20000
},t=>{
  const javaHome=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout?.trim();
  if(!javaHome||!fs.existsSync(path.join(javaHome,'bin/javac')))return t.skip('Requires Java21 and clang');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-supervisor-receipt-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=path.join(__dirname,'fixtures/android-supervisor-channel');
  const source=process.env.ANDROID_SUPERVISOR_CHANNEL_SOURCE||path.join(__dirname,'../src/modules/android/native/supervisor-channel.c');
  const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.error?.message||r.stderr||r.stdout);return r;};
  const library=path.join(root,'receiver.dylib');
  run('clang',['-dynamiclib','-I'+path.join(javaHome,'include'),'-I'+path.join(javaHome,'include/darwin'),source,path.join(fixture,'receipt.c'),'-o',library]);
  run(path.join(javaHome,'bin/javac'),['-d',root,path.join(fixture,'ProcessAuthority.java')]);
  const result=run(path.join(javaHome,'bin/java'),['-cp',root,'maclauncher.android.ProcessAuthority',library]);
  assert.match(result.stdout,/Connection receipts preserve their parent authority channel/);
});
