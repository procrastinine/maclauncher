const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Canvas composition preserves both native source origins and horizontal placement on Metal',{
  skip:process.platform!=='darwin'||process.env.KLEPTON_GRAPHICS_RUN!=='1',timeout:45000
},t=>{
  const jdk=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout?.trim();
  if(!jdk||!fs.existsSync(path.join(jdk,'bin/javac')))return t.skip('Requires Java21 and clang');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-overlay-origin-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const native=path.resolve(__dirname,'../src/modules/android/native');
  const fixture=path.join(__dirname,'fixtures/android-overlay-origin');
  const run=(file,args)=>{const result=spawnSync(file,args,{encoding:'utf8',timeout:25000});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);return result.stdout;};
  const library=path.join(temporary,'origin.dylib');
  run('clang++',['-std=c++20','-O1','-fobjc-arc','-dynamiclib','-I'+native,'-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),path.join(native,'overlay.mm'),path.join(fixture,'origin.mm'),...['Foundation','Metal','IOSurface'].flatMap(f=>['-framework',f]),'-o',library]);
  run(path.join(jdk,'bin/javac'),['-d',temporary,path.join(fixture,'OverlayOrigin.java')]);
  assert.match(run(path.join(jdk,'bin/java'),['-Xcheck:jni','-cp',temporary,'OverlayOrigin',library]),/PASS native source origins/);
});
