const fs=require('node:fs');
// Tiny ARM64 ELF, loaded and relocated by the real Klepton linker.
module.exports=function(file){
 const b=Buffer.alloc(32768),u16=(p,v)=>b.writeUInt16LE(v,p),u32=(p,v)=>b.writeUInt32LE(v,p),u64=(p,v)=>b.writeBigUInt64LE(BigInt(v),p);
 b.set([127,69,76,70,2,1,1]);u16(16,3);u16(18,183);u32(20,1);u64(32,64);u16(52,64);u16(54,56);u16(56,3);u16(58,64);
 const symbols=['','JNI_OnLoad','fixture_dynamic_onload','Java_owned_dynamic_NativeChild_value','Java_owned_dynamic_Late_value'];let cursor=0;
 symbols.forEach((name,index)=>{const str=Buffer.from(name+'\0');str.copy(b,0x300+cursor);if(index){const p=0x400+index*24;u32(p,cursor);b[p+4]=0x12;u16(p+6,index===2?0:1);u64(p+8,index===1?0x700:index===3?0x720:index===4?0x730:0);u64(p+16,8);}cursor+=str.length;});
 u32(0x500,1);u32(0x504,symbols.length);u32(0x508,1);
 // NONE records skip target and symbol access, including RX offset zero and an invalid address.
 u64(0x600,0);u64(0x608,0xffffffff00000000n);u64(0x610,0xffffffffffffffffn);
 u64(0x618,0xffffffffffffffffn);u64(0x620,0xffffffff00000000n);u64(0x628,0xffffffffffffffffn);
 u64(0x630,0x4000);u64(0x638,(2n<<32n)|1025n);
 const dynamic=[[4,0x500],[5,0x300],[6,0x400],[10,cursor],[11,24],[7,0x600],[8,72],[9,24],[0,0]];
 dynamic.forEach(([tag,v],i)=>{u64(0x200+i*16,tag);u64(0x208+i*16,v);});
 u32(0x700,0x5801c810);u32(0x704,0xd61f0200);
 for(const [at,result]of[[0x720,73],[0x730,74]]){u32(at,0x52800000|(result<<5));u32(at+4,0xd65f03c0);}
 u64(40,0x900);u16(60,5);
 function section(i,type,offset,size,link=0,entry=0){const p=0x900+i*64;u32(p+4,type);u64(p+8,2);u64(p+16,offset);u64(p+24,offset);u64(p+32,size);u32(p+40,link);u64(p+48,8);u64(p+56,entry);}
 section(1,1,0x700,0x40);section(2,3,0x300,cursor);section(3,11,0x400,symbols.length*24,2,24);section(4,6,0x200,dynamic.length*16,2,16);
 for(const [p,type,offset,size,flags]of[[64,1,0,16384,5],[120,1,16384,16384,6],[176,2,0x200,dynamic.length*16,4]]){u32(p,type);u32(p+4,flags);u64(p+8,offset);u64(p+16,offset);u64(p+24,offset);u64(p+32,size);u64(p+40,size);u64(p+48,16384);}
 fs.writeFileSync(file,b);
};
