const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const Included=require('../src/modules/shared/runtime/included-helpers');
const Files=require('../src/modules/android/included-files');
test('Android Java files resolve solely from the declared included package',t=>{
  t.mock.method(Included,'resolveIncluded',(_declarations,options)=>{assert.equal(options.id,'android-launcher');return{directory:'/published/android-launcher'};});
  for(const file of ['resources/launch-arguments.jar','resources/text-input.jar','providers/macapk/resources/privacy.jar','store/resources/account-control.jar'])
    assert.equal(Files.file(file),path.join('/published/android-launcher/files',file));
});
test('missing Android included files report the missing package without a source fallback',t=>{
  t.mock.method(Included,'resolveIncluded',()=>null);
  assert.throws(()=>Files.file('resources/text-input.jar'),/included Android integration helpers are unavailable/);
});
test('AIM preparation requests the managed runtime rather than a source controller',t=>{
  const manager=require('../src/modules/android/providers/aim/manager');
  t.mock.method(manager,'resolveSelection',()=>({ready:false,version:'MCLv3-1028-6'}));
  const plan=require('../src/modules/android/providers/aim').ensureRuntime({},{});
  assert.equal(plan.managerId,'android-aim');assert.equal(plan.version,'MCLv3-1028-6');
});

test('foreign metadata APK fixture is generated from text in its temporary tree', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-apk-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = require('./helpers/android-packages').foreignMetadataApk(root);
  const inspected = require('../src/modules/android/apk').inspectApk(file);
  assert.equal(inspected.packageName, 'org.maclauncher.foreign.fixture');
  assert.equal(inspected.split, 'config.foreign');
});
