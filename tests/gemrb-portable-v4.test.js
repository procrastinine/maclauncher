const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Current=require('../src/modules/gemrb/runtime/portable-build-v4'),Old=require('../src/modules/gemrb/runtime/portable-build'),Python=require('../src/modules/shared/runtime/portable-python-v2');
test('GemRB v4 has a distinct metadata profile while preserving the V3 engine source identity and options',()=>{
  assert.equal(Current.VERSION,'0.9.5-cli-v4');assert.equal(Old.VERSION,'0.9.5-cli-v3');
  assert.equal(Current.REVISION,Old.REVISION);assert.equal(Current.SOURCE_SHA256,Old.SOURCE_SHA256);assert.notEqual(Current.overlayIdentity(),Old.overlayIdentity());
  const input={prefix:'/tmp/prefix',sdk:'/SDK',tools:{ninja:'/tools/ninja'},python:{library:'/tmp/python/lib/libpython3.14.dylib',includeDir:'/tmp/python/include/python3.14',prefix:'/tmp/python'}};
  assert.deepEqual(Current.configureOptions(input),Old.configureOptions(input));
  assert.throws(()=>Current.validatePythonStack({version:'python-embedded-macos13-v1'}),/exact embedded Python/);
  assert.equal(Python.PIN.version,'python-embedded-macos13-v2');
});
test('cancelled GemRB v4 cannot create output or change the previous engine recipe',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maclauncher-gemrb-v4-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workRoot=path.join(root,'output'),before=Old.overlayIdentity();await assert.rejects(Current.buildPortableGemRB({workRoot,signal:AbortSignal.abort()}),{name:'AbortError'});
  assert.equal(fs.existsSync(workRoot),false);assert.equal(Old.overlayIdentity(),before);
});
