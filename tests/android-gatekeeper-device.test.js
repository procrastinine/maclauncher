const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');

test('original software GateKeeper negotiates with KeyMint and verifies retained enrollment handles',{timeout:60000},t=>{
  const build=process.env.ANDROID_GATEKEEPER_DEVICE_BUILD,keyStore=process.env.ANDROID_KEYSTORE_LIBRARY;
  if(process.platform!=='darwin'||!build||!keyStore)return t.skip('Requires built original GateKeeper and KeyStore native products');
  const owner=JSON.parse(fs.readFileSync(path.join(build,'native/closure.json')));
  const generated=JSON.parse(fs.readFileSync(path.join(build,'generated.json')));
  const declaration=generated.records.find(record=>record.name==='android.hardware.gatekeeper');
  assert.ok(declaration);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-gatekeeper-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const executable=path.join(temp,'gatekeeper');
  const flags=owner.units.find(unit=>unit.owner==='android.hardware.gatekeeper-service.nonsecure').flags;
  const generatedCpp=declaration.backends.ndk.files.filter(file=>file.file.endsWith('.cpp')).map(file=>file.file);
  const native=path.dirname(keyStore);
  execFileSync('clang++',[...flags,'tests/fixtures/android-platform-service/GateKeeperDeviceProbe.cpp',
    ...generatedCpp,owner.archive,keyStore,path.join(native,'libandroid-binder-rpc.dylib'),
    path.join(native,'libcrypto.dylib'),'-o',executable],{stdio:'pipe'});
  const output=execFileSync(executable,[],{encoding:'utf8',timeout:20000,
    env:{...process.env,DYLD_LIBRARY_PATH:native}});
  assert.match(output,/PASS original GateKeeper enrollment, token negotiation and retained handle/);
});
