const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('Selected original Binder producer does not need unrelated resolver tools',async t=>{
 const input=process.env.ANDROID_ART_GUEST_INPUTS;
 if(!input)return t.skip('Requires original Android guest compiler inputs');
 const options=JSON.parse(fs.readFileSync(input));
 const {buildArtGuest}=await import('../src/modules/android/art/build-guest.mjs');
 const result=buildArtGuest({...options,aidl:'/unavailable-unrelated-resolver-tool',targets:['binderLibrary']});
 assert.deepEqual(Object.keys(result),['binderLibrary']);
 const binary=fs.readFileSync(result.binderLibrary);
 assert.equal(binary.subarray(0,4).toString('hex'),'7f454c46');
 assert.equal(binary.readUInt16LE(18),183,'Original Binder is an AArch64 Android library');
});
