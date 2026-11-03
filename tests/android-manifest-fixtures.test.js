const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {binaryXml}=require('./helpers/android-packages');
const {parseBinaryManifest}=require('../src/modules/android/binary-manifest');
test('logical XML fixtures retain typed permissions, components and framework resource IDs',()=>{
 const root=path.join(__dirname,'fixtures/android-framework-services/manifests');
 const permissions=require('./fixtures/android-framework-services/manifests/permissions.xml.tree.json');
 const bytes=binaryXml(permissions.tree,true,permissions.resourceIds),metadata=parseBinaryManifest(bytes);
 assert.equal(metadata.packageName,'org.example.permissions');
 assert.deepEqual(metadata.permissions,['android.permission.INTERNET','android.permission.POST_NOTIFICATIONS','android.permission.ACCESS_FINE_LOCATION','android.permission.CAMERA']);
 assert.equal(permissions.resourceIds.name,0x01010003);
 for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.xml.tree.json'))){
  const definition=JSON.parse(fs.readFileSync(path.join(root,name)));
  const parsed=parseBinaryManifest(binaryXml(definition.tree,true,definition.resourceIds));
  assert.ok(parsed.packageName,name);
 }
});
