const fs=require('node:fs');
module.exports=function(file){
 const b=Buffer.alloc(32768),u16=(p,v)=>b.writeUInt16LE(v,p),u32=(p,v)=>b.writeUInt32LE(v>>>0,p),u64=(p,v)=>b.writeBigUInt64LE(BigInt(v),p);
 b.set([127,69,76,70,2,1,1]);u16(16,3);u16(18,183);u32(20,1);u64(32,64);u16(52,64);u16(54,56);u16(56,3);u16(58,64);
 const text=(at,s)=>Buffer.from(s+'\0').copy(b,at);
 const strings=0x5000;
 for(const [off,s] of [[0,'xxxx_owned_live_Probe_value'],[80,'xxxx_owned_live_Probe_overloaded__I'],[160,'Java_owned_live_Probe_manual'],[240,'xxxx_owned_live_Probe_late'],[320,'JNI_OnLoad'],[400,'fixture_live_construct'],[480,'fixture_live_onload'],[560,'Java_owned_live_Parent_inherited'],[640,'xxxx_owned_live_Delayed_value'],[720,'xxxx_owned_live_Parent_lifetime']])text(strings+off,s);
 const symbols=[[0,0,0],[0,0x780,1],[80,0x790,1],[160,0x7a0,1],[240,0x7b0,1],[320,0x760,1],[400,0,0],[480,0,0],[560,0x7c0,1],[640,0x7d0,1],[720,0x7e0,1]];
 symbols.forEach(([off,value,defined],i)=>{if(!i)return;const p=0x4600+i*24;u32(p,off);b[p+4]=0x12;u16(p+6,defined);u64(p+8,value);u64(p+16,8);});
 // st_name zero is reserved; place first mutable name one byte into dynstr.
 b.copy(b,strings+1,strings,strings+802);b[strings]=0;symbols.forEach(([off],i)=>{if(i)u32(0x4600+i*24,off+1);});
 u32(0x4a00,1);u32(0x4a04,symbols.length);u32(0x4a08,1);
 for(const [i,sym]of[[0,6],[1,7]]){u64(0x4700+i*24,0x4800+i*8);u64(0x4708+i*24,(BigInt(sym)<<32n)|1025n);}
 const dynamic=[[4,0x4a00],[5,strings],[6,0x4600],[10,803],[11,24],[7,0x4700],[8,48],[9,24],[12,0x700],[0,0]];
 dynamic.forEach(([tag,value],i)=>{u64(0x4000+i*16,tag);u64(0x4008+i*16,value);});
 // Constructor: retain LR, pass the actual writable dynstr name to the real host callback.
 const adr=(rd,pc,target)=>{const d=target-pc;return 0x10000000|((d&3)<<29)|(((d>>2)&0x7ffff)<<5)|rd;};
 u32(0x700,0xa9bf7bfd);u32(0x704,adr(0,0x704,strings+1));
 u32(0x708,0x58000000|(((0x4800-0x708)/4)<<5)|16);u32(0x70c,0xd63f0200);u32(0x710,0xa8c17bfd);u32(0x714,0xd65f03c0);
 u32(0x760,0x58000000|(((0x4808-0x760)/4)<<5)|16);u32(0x764,0xd61f0200);
 for(const [at,result]of[[0x780,73],[0x790,74],[0x7a0,82],[0x7b0,75],[0x7c0,81],[0x7d0,76],[0x7e0,83]]){u32(at,0x52800000|(result<<5));u32(at+4,0xd65f03c0);}
 u64(40,0x900);u16(60,5);
 function section(i,type,offset,size,link=0,entry=0){const p=0x900+i*64;u32(p+4,type);u64(p+8,2);u64(p+16,offset);u64(p+24,offset);u64(p+32,size);u32(p+40,link);u64(p+48,8);u64(p+56,entry);}
 section(1,1,0x700,0xf0);section(2,3,strings,803);section(3,11,0x4600,symbols.length*24,2,24);section(4,6,0x4000,dynamic.length*16,2,16);
 for(const [p,type,offset,size,flags]of[[64,1,0,16384,5],[120,1,16384,16384,6],[176,2,0x4000,dynamic.length*16,4]]){u32(p,type);u32(p+4,flags);u64(p+8,offset);u64(p+16,offset);u64(p+24,offset);u64(p+32,size);u64(p+40,size);u64(p+48,16384);}
 fs.writeFileSync(file,b);
};
