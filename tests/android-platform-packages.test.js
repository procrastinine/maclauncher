const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {writeZipArchive} = require('./helpers/zip-fixture');

test('Platform provider catalog retains original authorities and defers resource resolution', async t => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-platform-index-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const image=path.join(temporary,'image'),output=path.join(temporary,'catalog.json');
  const manifest=name=>fs.readFileSync(path.join(__dirname,'fixtures/android-framework-services/manifests',name+'.xml.bin'));
  writeZipArchive(path.join(image,'system/priv-app/Providers/Providers.apk'),[{name:'AndroidManifest.xml',data:manifest('providers')}]);
  writeZipArchive(path.join(image,'product/app/Window/Window.apk'),[{name:'AndroidManifest.xml',data:manifest('window')}]);
  const {buildPlatformPackageCatalog}=await import('../src/modules/android/native/platform-packages.mjs');
  const catalog=buildPlatformPackageCatalog({image,output});
  assert.deepEqual(catalog,{schemaVersion:1,packages:[{
    source:'system/priv-app/Providers/Providers.apk',packageName:'owned.providers',sharedUserId:null,
    authorities:['same','same','first','same','second','same'],resolvedAuthorities:false
  }]});
  assert.deepEqual(JSON.parse(fs.readFileSync(output)),catalog);
  assert.deepEqual(fs.readdirSync(temporary).sort(),['catalog.json','image']);
});
