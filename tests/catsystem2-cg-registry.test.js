const test=require('node:test'),assert=require('node:assert/strict');
const {parseCgList,createCgRegistry}=require('../src/modules/catsystem2/runtime/cg-registry');
const {encodeStoredData}=require('../src/modules/catsystem2/runtime/data-records');
function list(){const bytes=Buffer.alloc(12+136*2+12);bytes.writeUInt32LE(2,8);bytes.writeUInt32LE(136,12);bytes.write('first',16);bytes.writeUInt32LE(1,80);bytes.write('frame_01',84);bytes.write('second',152);bytes.writeUInt32LE(1,216);bytes.write('frame_02',220);return bytes;}
test('compiled CG lists retain named blocks, exact link extents and file counts without source changes',()=>{
  const bytes=list(),before=Buffer.from(bytes);assert.deepEqual(parseCgList(bytes),{blocks:[{index:0,name:'first',files:['frame_01']},{index:1,name:'second',files:['frame_02']}],totalFiles:2});assert.deepEqual(bytes,before);
  for(const mutate of [b=>b.writeUInt32LE(137,12),b=>b.writeUInt32LE(1,148),b=>b.writeUInt32LE(0xffffffff,80),b=>b.write('first\0',152),b=>b[295]=1,b=>b[16]=47]){const invalid=list();mutate(invalid);assert.throws(()=>parseCgList(invalid),/CG-list/);}
  assert.throws(()=>parseCgList(bytes.subarray(0,-1)),/marker|extents/);
});
test('CG records distinguish validated fresh state from unsupported existing registration',async()=>{
  let stored=null;const registry=createCgRegistry({assets:{read:async()=>list()},readStoredData:async()=>stored});
  assert.throws(()=>registry.registered(0),/initialized/);await registry.initialize('global.dat',100,'cglist.dat');assert.equal(registry.registered('SECOND'),0);assert.equal(registry.registered(0),0);
  assert.throws(()=>registry.registered(2),/absent/);assert.throws(()=>registry.registered(-1),/absent/);
  stored=await encodeStoredData({version:1,records:new Map([[100,Buffer.from([1])]])});await assert.rejects(()=>registry.initialize('global.dat',100,'cglist.dat'),/unsupported/);
  stored=Buffer.from('invalid');await assert.rejects(()=>registry.initialize('global.dat',100,'cglist.dat'),/header/);
});
test('CGL-prefixed lists retain full 256-byte names and reject an incompatible stride',()=>{
  const bytes=Buffer.alloc(4+12+72+256+12);bytes.write('CGL\0');bytes.writeUInt32LE(1,12);bytes.write('group',20);bytes.writeUInt32LE(1,84);bytes.write('frame_'+"a".repeat(90),88);
  const original=Buffer.from(bytes),parsed=parseCgList(bytes);assert.equal(parsed.blocks[0].files[0].length,96);assert.deepEqual(bytes,original);
  const wrong=Buffer.concat([Buffer.from('CGL\0'),list()]);assert.throws(()=>parseCgList(wrong),/extents/);
});
