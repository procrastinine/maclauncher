const test=require('node:test'),assert=require('node:assert/strict');
const Abi=require('../src/modules/android/native-abi');
test('APK ABI selection preserves native ARM64 and uses ARM32 only with its execution component',()=>{
 assert.equal(Abi.select(['arm64-v8a','armeabi-v7a'],{arm32Version:1}),'arm64-v8a');
 assert.equal(Abi.select(['armeabi-v7a','armeabi'],{arm32Version:1}),'armeabi-v7a');
 assert.equal(Abi.select(['armeabi'],{arm32Version:1}),'armeabi');
 assert.equal(Abi.select(['armeabi-v7a']),null);
 assert.equal(Abi.select(['x86'],{arm32Version:1}),null);
 assert.equal(Abi.select([],{arm32Version:1}),'arm64-v8a');
 assert.equal(Abi.fromDirectory('/application/input/lib/armeabi-v7a'),'armeabi-v7a');
 assert.equal(Abi.fromDirectory('/application/native'),'arm64-v8a');
});
