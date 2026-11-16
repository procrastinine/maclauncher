// SPDX-License-Identifier: MIT
// Adapted from fsr4-native-macos tools/diagnostics/anr_nrx.py; see NOTICE.md.
const {zstdDecompressSync}=require('node:zlib');
const LIMIT=512*1024*1024,MASK=(1n<<64n)-1n;
function decode(data){
 if(!Buffer.isBuffer(data)||data.length<16||data.length>LIMIT||data.toString('ascii',0,4)!=='NRX1'||data.readUInt32LE(4)!==2)throw Error('Invalid ANR directory pack.');
 let state=data.readBigUInt64LE(8)^0x6e725f6e72785f31n;
 const payload=Buffer.from(data.subarray(16));
 for(let offset=0;offset<payload.length;offset+=8){state=(state+0x9e3779b97f4a7c15n)&MASK;let word=((state^(state>>30n))*0xbf58476d1ce4e5b9n)&MASK;word=((word^(word>>27n))*0x94d049bb133111ebn)&MASK;word^=word>>31n;for(let i=0;i<8&&offset+i<payload.length;i++)payload[offset+i]^=Number((word>>BigInt(i*8))&255n);}
 const plain=zstdDecompressSync(payload,{maxOutputLength:LIMIT});
 if(plain.length<4)throw Error('Truncated ANR directory.');
 const count=plain.readUInt32LE(0);if(count>10000)throw Error('Oversized ANR directory.');
 let offset=4;const entries=[],names=new Set();
 for(let i=0;i<count;i++){
  if(offset+4>plain.length)throw Error('Truncated ANR member.');const length=plain.readUInt32LE(offset);offset+=4;
  if(!length||length>4096||offset+length+16>plain.length)throw Error('Invalid ANR member.');
  const bytes=plain.subarray(offset,offset+length),name=new TextDecoder('utf-8',{fatal:true}).decode(bytes);offset+=length;
  if(/[\\\x00:]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||names.has(name.toLowerCase()))throw Error('Unsafe ANR member path.');names.add(name.toLowerCase());
  const start=plain.readBigUInt64LE(offset),size=plain.readBigUInt64LE(offset+8);offset+=16;
  if(start>BigInt(LIMIT)||size>BigInt(LIMIT))throw Error('Oversized ANR member.');entries.push([name,Number(start),Number(size)]);
 }
 const files=new Map();for(const [name,start,size]of entries){if(start+size>plain.length-offset)throw Error('ANR member escapes payload.');files.set(name,plain.subarray(offset+start,offset+start+size));}return files;
}
module.exports={decode,LIMIT};
