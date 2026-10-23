// Owned DEX: choose(boolean, HeaderLeft, HeaderRight) merges two parent-only
// sibling types and returns HeaderBase. Correct JVM frames require their headers.
const crypto=require('node:crypto');
module.exports=function(){
 const types=['Lfixture/headers/Choice;','Lfixture/headers/HeaderBase;','Lfixture/headers/HeaderLeft;','Lfixture/headers/HeaderRight;','Ljava/lang/Object;','Z'];
 const strings=[...types,'LZLL','choose'].sort(),si=s=>strings.indexOf(s);
 const stringOff=112,typeOff=stringOff+strings.length*4,protoOff=typeOff+types.length*4,methodOff=protoOff+12,classOff=methodOff+8,dataOff=classOff+32,data=[];
 const offset=()=>dataOff+data.length,uleb=n=>{const out=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;},append=bytes=>{const at=offset();data.push(...bytes);return at;},align=()=>{while(offset()%4)data.push(0);};
 const stringData=strings.map(s=>append([...uleb(s.length),...Buffer.from(s),0]));align();
 const params=Buffer.alloc(12);params.writeUInt32LE(3);[5,2,3].forEach((t,i)=>params.writeUInt16LE(t,4+i*2));const paramOff=append(params);
 align();const code=Buffer.alloc(28);code.writeUInt16LE(4);code.writeUInt16LE(3,2);code.writeUInt32LE(6,12);
 [0x0138,4,0x2007,0x0228,0x3007,0x0011].forEach((w,i)=>code.writeUInt16LE(w,16+i*2));const codeOff=append(code);
 const classData=append([0,0,1,0,0,9,...uleb(codeOff)]);align();const mapOff=offset();
 const map=[[0,1,0],[1,strings.length,stringOff],[2,types.length,typeOff],[3,1,protoOff],[5,1,methodOff],[6,1,classOff],[0x2002,strings.length,stringData[0]],[0x1001,1,paramOff],[0x2001,1,codeOff],[0x2000,1,classData],[0x1000,1,mapOff]].sort((a,b)=>a[2]-b[2]);
 const mb=Buffer.alloc(4+map.length*12);mb.writeUInt32LE(map.length);map.forEach(([type,count,at],i)=>{mb.writeUInt16LE(type,4+i*12);mb.writeUInt32LE(count,8+i*12);mb.writeUInt32LE(at,12+i*12);});append(mb);
 const result=Buffer.alloc(offset());Buffer.from('dex\n035\0').copy(result);result.writeUInt32LE(result.length,32);result.writeUInt32LE(112,36);result.writeUInt32LE(0x12345678,40);result.writeUInt32LE(mapOff,52);
 [[strings.length,stringOff],[types.length,typeOff],[1,protoOff],[0,0],[1,methodOff],[1,classOff],[result.length-dataOff,dataOff]].forEach(([size,at],i)=>{result.writeUInt32LE(size,56+i*8);result.writeUInt32LE(at,60+i*8);});
 stringData.forEach((at,i)=>result.writeUInt32LE(at,stringOff+i*4));types.forEach((s,i)=>result.writeUInt32LE(si(s),typeOff+i*4));
 result.writeUInt32LE(si('LZLL'),protoOff);result.writeUInt32LE(1,protoOff+4);result.writeUInt32LE(paramOff,protoOff+8);result.writeUInt32LE(si('choose'),methodOff+4);
 result.writeUInt32LE(1,classOff+4);result.writeUInt32LE(4,classOff+8);result.writeUInt32LE(0xffffffff,classOff+16);result.writeUInt32LE(classData,classOff+24);Buffer.from(data).copy(result,dataOff);
 crypto.createHash('sha1').update(result.subarray(32)).digest().copy(result,12);let a=1,b=0;for(const byte of result.subarray(12)){a=(a+byte)%65521;b=(b+a)%65521;}result.writeUInt32LE(((b<<16)|a)>>>0,8);return result;
};
