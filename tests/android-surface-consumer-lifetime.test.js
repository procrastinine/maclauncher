const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Android display retirement preserves borrowed buffers without retaining the window',t=>{
  if(process.platform!=='darwin')return t.skip('Requires macOS IOSurface');
  const java=spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'});
  if(java.status!==0)return t.skip('Requires Java21 headers');
  const home=java.stdout.trim(),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-consumer-lifetime-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe'),source=path.resolve(__dirname,'../src/modules/android/native');
  const compiled=spawnSync('clang++',['-std=c++17','-fobjc-arc','-I'+source,'-I'+path.join(home,'include'),
    '-I'+path.join(home,'include/darwin'),path.join(__dirname,'fixtures/android-native/surface-consumer-lifetime.mm'),
    '-framework','Foundation','-framework','IOSurface','-Wl,-dead_strip','-o',binary],{encoding:'utf8',timeout:30000});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,[result.signal,result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));assert.match(result.stdout,/PASS native display detaches/);
});
test('Android Surface planes copy into owned Mac images with format and color metadata',t=>{
  if(process.platform!=='darwin')return t.skip('Requires macOS CoreVideo');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-surface-planes-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe'),source=path.resolve(__dirname,'../src/modules/android/native');
  const compiled=spawnSync('clang++',['-std=c++20','-fobjc-arc','-I'+source,
    path.join(source,'video-pixels.mm'),path.join(__dirname,'fixtures/android-native/surface-planes.mm'),
    '-framework','Foundation','-framework','CoreVideo','-framework','CoreImage','-framework','CoreGraphics','-framework','Metal','-o',binary],{encoding:'utf8',timeout:30000});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,[result.signal,result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stdout,/PASS original surface plane ownership/);
});
