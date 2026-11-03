const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Runtime=require('../src/modules/android/runtime'),Host=require('../src/modules/shared/runtime/host-capabilities'),Architecture=require('../src/modules/shared/runtime/architecture');
const getHostCapabilities=Host.getHostCapabilities;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-hardware-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const profile={id:'arm-runtime',javaMajor:21,nativeLoadTarget:'maclauncher.android.bridge.GuestNativeLoader'},bytes=Buffer.from(JSON.stringify({schemaVersion:1,version:'fixture',architectures:['arm64'],profile}));
 fs.writeFileSync(path.join(root,'runtime.json'),bytes);
 return{root,profile,declaration:{version:'fixture',arch:'arm64',minimumMacOS:'13.0',manifestSha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
}
function host(launcherArch,hardwareArch,platform='darwin'){
 return getHostCapabilities({platform,launcherArch,hardwareArch,macOSVersion:'27.0',rosettaAvailable:launcherArch==='x64'&&hardwareArch==='arm64'});
}
test('Android hardware gate admits a Rosetta launcher on ARM without changing the runtime or selected child CPU',t=>{
 const f=fixture(t),translated=host('x64','arm64'),descriptor=Object.getOwnPropertyDescriptor(process,'arch');
 Object.defineProperty(process,'arch',{...descriptor,value:'x64'});t.after(()=>Object.defineProperty(process,'arch',descriptor));
 const read=t.mock.method(Host,'getHostCapabilities',()=>translated);
 Architecture.withArchitecture('x64',()=>{
  const selected=Runtime.resolve({root:f.root,platform:'darwin',macOSVersion:'27.0'},f.declaration);
  assert.equal(selected.version,'fixture');assert.deepEqual(selected.profile,f.profile);assert.equal(selected.runtimeDeclaration,f.declaration);assert.equal(selected.runtimeDeclaration.arch,'arm64');
  assert.equal(Architecture.selectedArchitecture(),'x64','The host check must not rewrite an explicit child/build selection');
 });
 assert.equal(read.mock.callCount(),1);assert.equal(process.arch,'x64');
 assert.throws(()=>Runtime.resolve({root:f.root,platform:'darwin',arch:'x64',macOSVersion:'27.0'},f.declaration),/Apple Silicon/,'An explicitly requested unsupported runtime CPU stays rejected');
 assert.equal(Runtime.resolve({root:f.root,platform:'darwin',arch:'arm64',macOSVersion:'27.0'},f.declaration).runtimeDeclaration,f.declaration);
});
test('Android hardware gate rejects Intel even with an explicit ARM runtime request',t=>{
 const f=fixture(t);t.mock.method(Host,'getHostCapabilities',()=>host('x64','x64'));
 for(const arch of [undefined,'arm64','x64'])assert.throws(()=>Runtime.resolve({root:f.root,platform:'darwin',arch,macOSVersion:'27.0'},f.declaration),/Apple Silicon/);
});
test('Android hardware gate admits native ARM and rejects non-macOS hardware',t=>{
 const f=fixture(t),native=host('arm64','arm64');const mock=t.mock.method(Host,'getHostCapabilities',()=>native);
 assert.equal(Runtime.resolve({root:f.root,platform:'darwin',macOSVersion:'27.0'},f.declaration).version,'fixture');
 assert.throws(()=>Runtime.resolve({root:f.root,platform:'linux',arch:'arm64'},f.declaration),/Apple Silicon/);
 mock.mock.mockImplementation(()=>host('arm64','arm64','linux'));
 assert.throws(()=>Runtime.resolve({root:f.root,platform:'darwin',arch:'arm64'},f.declaration),/Apple Silicon/,'A platform override cannot make a non-Mac host eligible');
});
