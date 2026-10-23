const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('supervisor identity handshake precedes Android native initialization',t=>{
  if(process.platform!=='darwin'||!process.env.JAVA_HOME)return t.skip('Requires macOS and the configured build JDK');
  const jdk=process.env.JAVA_HOME,temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-bootstrap-channel-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixtures=path.join(__dirname,'fixtures/android-process-authority'),library=path.join(temporary,'channel.dylib');
  execFileSync('clang',['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),
    path.resolve(__dirname,'../src/modules/android/native/supervisor-channel.c'),path.join(fixtures,'bootstrap-channel.c'),'-o',library],{stdio:'pipe'});
  execFileSync(path.join(jdk,'bin/javac'),['--release','21','-d',temporary,path.join(fixtures,'BootstrapChannel.java')],{stdio:'pipe'});
  const output=execFileSync(path.join(jdk,'bin/java'),['-Djava.awt.headless=true','-Xcheck:jni','-cp',temporary,'maclauncher.android.ProcessAuthority',library],{encoding:'utf8',timeout:10000});
  assert.match(output,/PASS supervisor bootstrap without Android initialization/);
  assert.doesNotMatch(output,/WARNING in native method/);
});
