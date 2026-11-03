const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Fixtures=require('./helpers/manifest-fixtures'),{parseBinaryManifest}=require('../src/modules/android/binary-manifest');
test('manifest fixtures belong to the test temp tree and leave source inputs unchanged',()=>{
 const callbacks=[],first={after:fn=>callbacks.push(fn)},second={after:fn=>callbacks.push(fn)};
 const source=path.join(__dirname,'fixtures/android-framework-services/manifests/window.xml.tree.json'),before=fs.readFileSync(source);
 try{
  const a=Fixtures.file(first,'android-framework-services/manifests/window'),b=Fixtures.file(second,'android-framework-services/manifests/window');
  assert.notEqual(a,b);assert.equal(a.startsWith(__dirname+path.sep),false);assert.deepEqual(fs.readFileSync(a),fs.readFileSync(b));
  assert.equal(parseBinaryManifest(fs.readFileSync(a)).packageName,'org.example.window');
  assert.equal(Fixtures.file(first,'android-framework-services/manifests/window'),a);
  assert.equal(parseBinaryManifest(fs.readFileSync(Fixtures.file(first,'android-framework-services/manifests/providers'))).packageName,'owned.providers');
  assert.throws(()=>Fixtures.file(first,'../escape'),/Invalid/);assert.deepEqual(fs.readFileSync(source),before);
  for(const cleanup of callbacks)cleanup();assert.equal(fs.existsSync(a),false);assert.equal(fs.existsSync(b),false);
 }finally{for(const cleanup of callbacks)cleanup();}
});
