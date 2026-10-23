// Original DEX references Leaf.<init>() although only Object declares it.
// Leaf's real (I)V constructor must survive while Base and Leaf gain forwarding
// ()V constructors to express ART resolution on a JVM.
const crypto=require('node:crypto');
module.exports=function(){
 const types=['I','Lfixture/constructors/Base;','Lfixture/constructors/Leaf;','Ljava/lang/Object;','V'];
 const strings=[...types,'<init>','L','VI','make'].sort(),si=s=>strings.indexOf(s);
 const methods=[[2,0,'<init>'],[2,1,'<init>'],[2,2,'make'],[3,0,'<init>']];
 const stringOff=112,typeOff=stringOff+strings.length*4,protoOff=typeOff+types.length*4,methodOff=protoOff+36,classOff=methodOff+methods.length*8,dataOff=classOff+64,data=[];
 const offset=()=>dataOff+data.length,uleb=n=>{const out=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;},append=bytes=>{const at=offset();data.push(...bytes);return at;},align=()=>{while(offset()%4)data.push(0);};
 const stringData=strings.map(s=>append([...uleb(s.length),...Buffer.from(s),0]));align();
 const params=Buffer.alloc(6);params.writeUInt32LE(1);const paramOff=append(params);
 function code(registers,ins,outs,words){align();const b=Buffer.alloc(16+2*words.length);b.writeUInt16LE(registers);b.writeUInt16LE(ins,2);b.writeUInt16LE(outs,4);b.writeUInt32LE(words.length,12);words.forEach((w,i)=>b.writeUInt16LE(w,16+i*2));return append(b);}
 const init=code(2,2,1,[0x1070,3,0,0x000e]);
 const make=code(1,0,1,[0x0022,2,0x1070,0,0,0x0011]);
 const base=append([0,0,0,0]);
 const leaf=append([0,0,2,0,1,...uleb(0x10001),...uleb(init),1,9,...uleb(make)]);align();const mapOff=offset();
 const map=[[0,1,0],[1,strings.length,stringOff],[2,types.length,typeOff],[3,3,protoOff],[5,methods.length,methodOff],[6,2,classOff],[0x2002,strings.length,stringData[0]],[0x1001,1,paramOff],[0x2001,2,init],[0x2000,2,base],[0x1000,1,mapOff]].sort((a,b)=>a[2]-b[2]);
 const mb=Buffer.alloc(4+map.length*12);mb.writeUInt32LE(map.length);map.forEach(([type,count,at],i)=>{mb.writeUInt16LE(type,4+i*12);mb.writeUInt32LE(count,8+i*12);mb.writeUInt32LE(at,12+i*12);});append(mb);
 const result=Buffer.alloc(offset());Buffer.from('dex\n035\0').copy(result);result.writeUInt32LE(result.length,32);result.writeUInt32LE(112,36);result.writeUInt32LE(0x12345678,40);result.writeUInt32LE(mapOff,52);
 [[strings.length,stringOff],[types.length,typeOff],[3,protoOff],[0,0],[methods.length,methodOff],[2,classOff],[result.length-dataOff,dataOff]].forEach(([size,at],i)=>{result.writeUInt32LE(size,56+i*8);result.writeUInt32LE(at,60+i*8);});
 stringData.forEach((at,i)=>result.writeUInt32LE(at,stringOff+i*4));types.forEach((s,i)=>result.writeUInt32LE(si(s),typeOff+i*4));
 [[si('V'),4,0],[si('VI'),4,paramOff],[si('L'),2,0]].forEach((p,i)=>p.forEach((v,j)=>result.writeUInt32LE(v,protoOff+i*12+j*4)));
 methods.forEach(([owner,proto,name],i)=>{result.writeUInt16LE(owner,methodOff+i*8);result.writeUInt16LE(proto,methodOff+i*8+2);result.writeUInt32LE(si(name),methodOff+i*8+4);});
 [[1,3,base],[2,1,leaf]].forEach(([type,parent,cd],i)=>{let o=classOff+i*32;result.writeUInt32LE(type,o);result.writeUInt32LE(1,o+4);result.writeUInt32LE(parent,o+8);result.writeUInt32LE(0xffffffff,o+16);result.writeUInt32LE(cd,o+24);});Buffer.from(data).copy(result,dataOff);
 crypto.createHash('sha1').update(result.subarray(32)).digest().copy(result,12);let a=1,b=0;for(const byte of result.subarray(12)){a=(a+byte)%65521;b=(b+a)%65521;}result.writeUInt32LE(((b<<16)|a)>>>0,8);return result;
};
