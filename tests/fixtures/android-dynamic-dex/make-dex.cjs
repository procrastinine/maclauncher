// A complete owned DEX 035: fixture.Value.answer() returns 42 and
// nativeLoad() invokes System.loadLibrary("never"). No external compiler needed.
const crypto = require('node:crypto');
module.exports = function makeDex(nativeCalls=1) {
  const strings = ['I','Lfixture/Value;','Ljava/lang/Object;','Ljava/lang/String;','Ljava/lang/System;','V','VL','answer','loadLibrary','nativeLoad','never'];
  const stringOff=112, typeOff=stringOff+strings.length*4, protoOff=typeOff+6*4, methodOff=protoOff+3*12, classOff=methodOff+3*8, dataOff=classOff+32;
  const data=[];const offset=()=>dataOff+data.length;
  const uleb=n=>{const bytes=[];do{let b=n&127;n>>>=7;bytes.push(b|(n?128:0));}while(n);return bytes;};
  const append=bytes=>{const at=offset();for(const byte of bytes)data.push(byte);return at;};
  const align=()=>{while(offset()%4)data.push(0);};
  const stringData=strings.map(s=>append([...uleb(s.length),...Buffer.from(s),0]));
  align();const parameters=append([1,0,0,0,3,0,0,0]);
  const code=(words,outs)=>{align();const bytes=Buffer.alloc(16+words.length*2);bytes.writeUInt16LE(1,0);bytes.writeUInt16LE(outs,4);bytes.writeUInt32LE(words.length,12);words.forEach((w,i)=>bytes.writeUInt16LE(w,16+i*2));return append(bytes);};
  const nativeWords=[0x001a,10];for(let i=0;i<nativeCalls;i++)nativeWords.push(0x1071,2,0);nativeWords.push(0x000e);
  const answer=code([0x0013,42,0x000f],0), nativeLoad=code(nativeWords,1);
  const classData=append([0,0,2,0,0,9,...uleb(answer),1,9,...uleb(nativeLoad)]);
  align();const mapOff=offset();
  const map=[[0,1,0],[1,strings.length,stringOff],[2,6,typeOff],[3,3,protoOff],[5,3,methodOff],[6,1,classOff],[0x2002,strings.length,stringData[0]],[0x1001,1,parameters],[0x2001,2,answer],[0x2000,1,classData],[0x1000,1,mapOff]].sort((a,b)=>a[2]-b[2]);
  const mapBytes=Buffer.alloc(4+map.length*12);mapBytes.writeUInt32LE(map.length,0);map.forEach(([type,size,at],i)=>{mapBytes.writeUInt16LE(type,4+i*12);mapBytes.writeUInt32LE(size,8+i*12);mapBytes.writeUInt32LE(at,12+i*12);});append(mapBytes);
  const result=Buffer.alloc(offset());Buffer.from('dex\n035\0').copy(result);result.writeUInt32LE(result.length,32);result.writeUInt32LE(112,36);result.writeUInt32LE(0x12345678,40);result.writeUInt32LE(mapOff,52);
  [[strings.length,stringOff],[6,typeOff],[3,protoOff],[0,0],[3,methodOff],[1,classOff],[result.length-dataOff,dataOff]].forEach(([size,at],i)=>{result.writeUInt32LE(size,56+i*8);result.writeUInt32LE(at,60+i*8);});
  stringData.forEach((at,i)=>result.writeUInt32LE(at,stringOff+i*4));for(let i=0;i<6;i++)result.writeUInt32LE(i,typeOff+i*4);
  [[0,0,0],[5,5,0],[6,5,parameters]].forEach(([shorty,returns,parameters],i)=>{result.writeUInt32LE(shorty,protoOff+i*12);result.writeUInt32LE(returns,protoOff+i*12+4);result.writeUInt32LE(parameters,protoOff+i*12+8);});
  [[1,0,7],[1,1,9],[4,2,8]].forEach(([cls,proto,name],i)=>{result.writeUInt16LE(cls,methodOff+i*8);result.writeUInt16LE(proto,methodOff+i*8+2);result.writeUInt32LE(name,methodOff+i*8+4);});
  result.writeUInt32LE(1,classOff);result.writeUInt32LE(1,classOff+4);result.writeUInt32LE(2,classOff+8);result.writeUInt32LE(0xffffffff,classOff+16);result.writeUInt32LE(classData,classOff+24);Buffer.from(data).copy(result,dataOff);
  crypto.createHash('sha1').update(result.subarray(32)).digest().copy(result,12);
  let a=1,b=0;for(const byte of result.subarray(12)){a=(a+byte)%65521;b=(b+a)%65521;}result.writeUInt32LE(((b<<16)|a)>>>0,8);
  return result;
};
