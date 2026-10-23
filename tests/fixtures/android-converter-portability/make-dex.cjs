// Original DEX callers exercise Android NIO and generic Class reflection.
const crypto=require('node:crypto');
module.exports=function(){
 const types=['I','Lfixture/PortableValue;','Ljava/lang/Class;','Ljava/lang/Object;','Ljava/lang/String;','Ljava/lang/reflect/Field;','Ljava/nio/ByteBuffer;','Ljava/nio/NioUtils;'];
 const strings=[...new Set([...types,'IL','LL','LLL','field','getDeclaredField','offset','unsafeArrayOffset'])].sort();
 const str=s=>strings.indexOf(s),type=s=>types.indexOf(s);
 const protos=[{key:'offset',shorty:'IL',result:'I',params:['Ljava/nio/ByteBuffer;']},{key:'field',shorty:'LLL',result:'Ljava/lang/reflect/Field;',params:['Ljava/lang/Class;','Ljava/lang/String;']},{key:'reflect',shorty:'LL',result:'Ljava/lang/reflect/Field;',params:['Ljava/lang/String;']}];
 const methods=[{owner:1,name:'field',proto:1},{owner:1,name:'offset',proto:0},{owner:2,name:'getDeclaredField',proto:2},{owner:7,name:'unsafeArrayOffset',proto:0}];
 const stringOff=112,typeOff=stringOff+strings.length*4,protoOff=typeOff+types.length*4,methodOff=protoOff+protos.length*12,classOff=methodOff+methods.length*8,dataOff=classOff+32,data=[];
 const offset=()=>dataOff+data.length,uleb=n=>{const b=[];do{const value=n&127;n>>>=7;b.push(value|(n?128:0));}while(n);return b;},append=bytes=>{const at=offset();data.push(...bytes);return at;},align=()=>{while(offset()%4)data.push(0);};
 const stringData=strings.map(s=>append([...uleb(s.length),...Buffer.from(s),0]));
 const params=protos.map(p=>{align();const bytes=Buffer.alloc(4+p.params.length*2);bytes.writeUInt32LE(p.params.length);p.params.forEach((name,i)=>bytes.writeUInt16LE(type(name),4+i*2));return append(bytes);});
 const code=(registers,ins,outs,instructions)=>{align();const bytes=Buffer.alloc(16+instructions.length*2);bytes.writeUInt16LE(registers,0);bytes.writeUInt16LE(ins,2);bytes.writeUInt16LE(outs,4);bytes.writeUInt32LE(instructions.length,12);instructions.forEach((v,i)=>bytes.writeUInt16LE(v,16+i*2));return append(bytes);};
 const firstCode=offset()+(4-offset()%4)%4;
 const fieldCode=code(2,2,2,[0x206e,2,0x0010,0x000c,0x0011]);
 const offsetCode=code(1,1,1,[0x1071,3,0,0x000a,0x000f,0x0000]);
 const classData=append([0,0,2,0,0,9,...uleb(fieldCode),1,9,...uleb(offsetCode)]);align();const mapOff=offset();
 const map=[[0,1,0],[1,strings.length,stringOff],[2,types.length,typeOff],[3,protos.length,protoOff],[5,methods.length,methodOff],[6,1,classOff],[0x2002,strings.length,stringData[0]],[0x1001,protos.length,params[0]],[0x2001,2,firstCode],[0x2000,1,classData],[0x1000,1,mapOff]].sort((a,b)=>a[2]-b[2]);
 const mb=Buffer.alloc(4+map.length*12);mb.writeUInt32LE(map.length);map.forEach(([kind,count,at],i)=>{mb.writeUInt16LE(kind,4+i*12);mb.writeUInt32LE(count,8+i*12);mb.writeUInt32LE(at,12+i*12);});append(mb);
 const result=Buffer.alloc(offset());Buffer.from('dex\n035\0').copy(result);result.writeUInt32LE(result.length,32);result.writeUInt32LE(112,36);result.writeUInt32LE(0x12345678,40);result.writeUInt32LE(mapOff,52);
 [[strings.length,stringOff],[types.length,typeOff],[protos.length,protoOff],[0,0],[methods.length,methodOff],[1,classOff],[result.length-dataOff,dataOff]].forEach(([size,at],i)=>{result.writeUInt32LE(size,56+i*8);result.writeUInt32LE(at,60+i*8);});
 stringData.forEach((at,i)=>result.writeUInt32LE(at,stringOff+i*4));types.forEach((name,i)=>result.writeUInt32LE(str(name),typeOff+i*4));
 protos.forEach((p,i)=>{result.writeUInt32LE(str(p.shorty),protoOff+i*12);result.writeUInt32LE(type(p.result),protoOff+i*12+4);result.writeUInt32LE(params[i],protoOff+i*12+8);});
 methods.forEach((m,i)=>{result.writeUInt16LE(m.owner,methodOff+i*8);result.writeUInt16LE(m.proto,methodOff+i*8+2);result.writeUInt32LE(str(m.name),methodOff+i*8+4);});
 result.writeUInt32LE(1,classOff);result.writeUInt32LE(1,classOff+4);result.writeUInt32LE(3,classOff+8);result.writeUInt32LE(0xffffffff,classOff+16);result.writeUInt32LE(classData,classOff+24);Buffer.from(data).copy(result,dataOff);
 crypto.createHash('sha1').update(result.subarray(32)).digest().copy(result,12);let a=1,b=0;for(const x of result.subarray(12)){a=(a+x)%65521;b=(b+a)%65521;}result.writeUInt32LE(((b<<16)|a)>>>0,8);return result;
};
