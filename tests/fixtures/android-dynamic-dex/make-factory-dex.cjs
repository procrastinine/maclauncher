// Owned DEX: a real AppComponentFactory subclass with its public constructor.
const crypto=require('node:crypto');
module.exports=function(){
 const types=['Landroid/app/AppComponentFactory;','Lfixture/packagecontext/Factory;','V'];
 const strings=[...types,'<init>'].sort(),si=s=>strings.indexOf(s);
 const stringOff=112,typeOff=stringOff+strings.length*4,protoOff=typeOff+types.length*4,methodOff=protoOff+12,classOff=methodOff+16,dataOff=classOff+32,data=[];
 const offset=()=>dataOff+data.length,uleb=n=>{const out=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;},append=bytes=>{const at=offset();data.push(...bytes);return at;},align=()=>{while(offset()%4)data.push(0);};
 const stringData=strings.map(s=>append([...uleb(s.length),...Buffer.from(s),0]));align();
 const code=Buffer.alloc(24);code.writeUInt16LE(1);code.writeUInt16LE(1,2);code.writeUInt16LE(1,4);code.writeUInt32LE(4,12);
 [0x1070,0,0,0x000e].forEach((w,i)=>code.writeUInt16LE(w,16+i*2));const codeOff=append(code);
 const classData=append([0,0,1,0,1,...uleb(0x10001),...uleb(codeOff)]);align();const mapOff=offset();
 const map=[[0,1,0],[1,strings.length,stringOff],[2,types.length,typeOff],[3,1,protoOff],[5,2,methodOff],[6,1,classOff],[0x2002,strings.length,stringData[0]],[0x2001,1,codeOff],[0x2000,1,classData],[0x1000,1,mapOff]].sort((a,b)=>a[2]-b[2]);
 const mb=Buffer.alloc(4+map.length*12);mb.writeUInt32LE(map.length);map.forEach(([type,count,at],i)=>{mb.writeUInt16LE(type,4+i*12);mb.writeUInt32LE(count,8+i*12);mb.writeUInt32LE(at,12+i*12);});append(mb);
 const result=Buffer.alloc(offset());Buffer.from('dex\n035\0').copy(result);result.writeUInt32LE(result.length,32);result.writeUInt32LE(112,36);result.writeUInt32LE(0x12345678,40);result.writeUInt32LE(mapOff,52);
 [[strings.length,stringOff],[types.length,typeOff],[1,protoOff],[0,0],[2,methodOff],[1,classOff],[result.length-dataOff,dataOff]].forEach(([size,at],i)=>{result.writeUInt32LE(size,56+i*8);result.writeUInt32LE(at,60+i*8);});
 stringData.forEach((at,i)=>result.writeUInt32LE(at,stringOff+i*4));types.forEach((s,i)=>result.writeUInt32LE(si(s),typeOff+i*4));
 result.writeUInt32LE(si('V'),protoOff);result.writeUInt32LE(2,protoOff+4);
 for(let i=0;i<2;i++){result.writeUInt16LE(i,methodOff+i*8);result.writeUInt32LE(si('<init>'),methodOff+i*8+4);}
 result.writeUInt32LE(1,classOff);result.writeUInt32LE(1,classOff+4);result.writeUInt32LE(0xffffffff,classOff+16);result.writeUInt32LE(classData,classOff+24);Buffer.from(data).copy(result,dataOff);
 crypto.createHash('sha1').update(result.subarray(32)).digest().copy(result,12);let a=1,b=0;for(const byte of result.subarray(12)){a=(a+byte)%65521;b=(b+a)%65521;}result.writeUInt32LE(((b<<16)|a)>>>0,8);return result;
};
