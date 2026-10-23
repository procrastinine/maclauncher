const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const FSR4=require('../src/modules/shared/reshade/temporal/fsr4');
const source=require('../src/modules/shared/reshade/temporal/fsr4/source.json');

test('FSR4 is advertised only for a complete matching native provider on macOS 26+',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fsr4-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const payload=path.join(root,'temporal/fsr4');fs.mkdirSync(path.join(payload,'build'),{recursive:true});
  fs.mkdirSync(path.join(payload,'third_party/fsr411'),{recursive:true});
  fs.writeFileSync(path.join(payload,'libmaclauncher-fsr4.dylib'),'library');
  fs.writeFileSync(path.join(payload,'third_party/fsr411/initializers.bin'),'model');
  const file=path.join(payload,'provider.json');
  const metadata={providerABI:1,complete:false,commit:source.commit,model:source.model,library:'libmaclauncher-fsr4.dylib'};
  const options={platform:'darwin',macOSVersion:'26.0'};
  fs.writeFileSync(file,JSON.stringify(metadata));
  assert.equal(FSR4.resolve(root,options),null);
  fs.writeFileSync(file,JSON.stringify({...metadata,complete:true}));
  const installed=FSR4.resolve(root,options);
  assert.equal(installed.version,'4.1.1.2740');
  assert.equal(FSR4.resolve(root,{...options,macOSVersion:'15.7'}),null);
  assert.equal(FSR4.resolve(root,{...options,platform:'linux'}),null);
  assert.deepEqual(FSR4.prepare(root,options),{RESHADE_FSR4_LIBRARY:installed.library,FSR4_ROOT:installed.directory,FSR4_BUILD_DIR:installed.build});
  fs.writeFileSync(file,JSON.stringify({...metadata,complete:true,commit:'different'}));
  assert.deepEqual(FSR4.prepare(root,options),{});
});
