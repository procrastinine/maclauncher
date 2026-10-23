// Original Dalvik array producers, with and without a move-result consumer.
const crypto=require('node:crypto');
module.exports=function(){
 const strings=['I','II','L','Lfixture/FilledArrays;','Ljava/lang/Object;','[Ljava/lang/Object;','discard','discardRange','retained','retainedRange'];
 const stringOff=112,typeOff=stringOff+strings.length*4,protoOff=typeOff+4*4,methodOff=protoOff+2*12,classOff=methodOff+4*8,dataOff=classOff+32,data=[];
 const offset=()=>dataOff+data.length,uleb=n=>{const out=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;};
 const append=bytes=>{const at=offset();data.push(...bytes);return at;},align=()=>{while(offset()%4)data.push(0);};
 const stringData=strings.map(s=>append([...uleb(s.length),...Buffer.from(s),0]));align();const params=append([1,0,0,0,0,0,0,0]);
 const methods=[
  // Both paths join at return: one has allocated an ignored Object[], one has not.
  [1,[0x7012,0x0138,6,0x0112,0x1024,3,1,0x000f]],
  [1,[0x7012,0x0138,6,0x0112,0x0125,3,1,0x000f]],
  [0,[0x0012,0x1024,3,0,0x010c,0x0111]],
  [0,[0x0012,0x0125,3,0,0x010c,0x0111]],
 ];
 const codeOffsets=methods.map(([ins,units])=>{
  align();const code=Buffer.alloc(16+units.length*2);code.writeUInt16LE(2,0);code.writeUInt16LE(ins,2);code.writeUInt16LE(1,4);code.writeUInt32LE(units.length,12);
  units.forEach((unit,i)=>code.writeUInt16LE(unit,16+i*2));return append(code);
 });
 const classData=append([0,0,4,0,...codeOffsets.flatMap((at,i)=>[i?1:0,9,...uleb(at)])]);align();const mapOff=offset();
 const map=[[0,1,0],[1,strings.length,stringOff],[2,4,typeOff],[3,2,protoOff],[5,4,methodOff],[6,1,classOff],[0x2002,strings.length,stringData[0]],[0x1001,1,params],[0x2001,4,codeOffsets[0]],[0x2000,1,classData],[0x1000,1,mapOff]].sort((a,b)=>a[2]-b[2]);
 const mb=Buffer.alloc(4+map.length*12);mb.writeUInt32LE(map.length);map.forEach(([type,count,at],i)=>{mb.writeUInt16LE(type,4+i*12);mb.writeUInt32LE(count,8+i*12);mb.writeUInt32LE(at,12+i*12);});append(mb);
 const result=Buffer.alloc(offset());Buffer.from('dex\n035\0').copy(result);result.writeUInt32LE(result.length,32);result.writeUInt32LE(112,36);result.writeUInt32LE(0x12345678,40);result.writeUInt32LE(mapOff,52);
 [[strings.length,stringOff],[4,typeOff],[2,protoOff],[0,0],[4,methodOff],[1,classOff],[result.length-dataOff,dataOff]].forEach(([size,at],i)=>{result.writeUInt32LE(size,56+i*8);result.writeUInt32LE(at,60+i*8);});
 stringData.forEach((at,i)=>result.writeUInt32LE(at,stringOff+i*4));[0,3,4,5].forEach((s,i)=>result.writeUInt32LE(s,typeOff+i*4));
 [[1,0,params],[2,3,0]].forEach(([shorty,ret,args],i)=>{result.writeUInt32LE(shorty,protoOff+i*12);result.writeUInt32LE(ret,protoOff+i*12+4);result.writeUInt32LE(args,protoOff+i*12+8);});
 for(let i=0;i<4;i++){result.writeUInt16LE(1,methodOff+i*8);result.writeUInt16LE(i<2?0:1,methodOff+i*8+2);result.writeUInt32LE(6+i,methodOff+i*8+4);}
 result.writeUInt32LE(1,classOff);result.writeUInt32LE(1,classOff+4);result.writeUInt32LE(2,classOff+8);result.writeUInt32LE(0xffffffff,classOff+16);result.writeUInt32LE(classData,classOff+24);Buffer.from(data).copy(result,dataOff);
 crypto.createHash('sha1').update(result.subarray(32)).digest().copy(result,12);let a=1,b=0;for(const x of result.subarray(12)){a=(a+x)%65521;b=(b+a)%65521;}result.writeUInt32LE(((b<<16)|a)>>>0,8);return result;
};
