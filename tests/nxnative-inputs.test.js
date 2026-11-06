const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {inspectBinary}=require('../src/modules/nxnative/detect');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nx-nup-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'arbitrary-name.bin');}
test('NUP magic recognizes truncated and unavailable metadata without reading payload',t=>{
 const file=fixture(t);for(const length of [4,127,128]){const bytes=Buffer.alloc(length);bytes.set([78,85,80,1]);fs.writeFileSync(file,bytes);const result=inspectBinary(file);assert.equal(result.format,'nup');assert.equal(result.keyRequirement,'none');assert.equal(result.titleId,null);assert.deepEqual(result.versions,[]);assert.equal(result.selectedUpdate,null);}
});
test('NUP metadata tolerates upstream flags, codecs and TOC changes and reads only package identity',t=>{
 const file=fixture(t),bytes=Buffer.alloc(128+48+128);bytes.set([78,85,80,1]);bytes.writeBigUInt64LE(128n,8);bytes.writeUInt32LE(2,72);
 const base=128+48,update=base+64;bytes.writeBigUInt64LE(0x0100000000010000n,base);bytes.writeBigUInt64LE(0x0100000000010800n,update);bytes[update+24]=1;bytes.writeUInt32LE(7,update+20);
 // Everything unrelated to package identity is deliberately invalid for the old app parser.
 bytes.writeUInt32LE(0xffffffff,76);bytes[base+25]=255;bytes[base+26]=255;bytes.write('NEW!',128);
 fs.writeFileSync(file,bytes);const result=inspectBinary(file);assert.equal(result.titleId,'0100000000010000');assert.deepEqual(result.versions,['v0','v7']);assert.equal(result.selectedUpdate,'v7');assert.equal(result.generation,null);
 bytes.writeBigUInt64LE(2n**63n,8);fs.writeFileSync(file,bytes);assert.equal(inspectBinary(file).format,'nup');assert.deepEqual(inspectBinary(file).versions,[]);
 bytes.writeUInt32LE(0xffffffff,72);fs.writeFileSync(file,bytes);assert.equal(inspectBinary(file).titleId,null);
});
