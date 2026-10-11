const fs=require("node:fs"),path=require("node:path");
function integer(value){const out=[];do{const low=value&127;value>>>=7;out.push(low|(value?128:0));}while(value);return Buffer.from(out);}
function cbg({width=256,height=9,bpp=8,alias=0,nonAlphaWord=0xffffffff,alphaValues}={}){
 const paddedWidth=(width+7)&~7,paddedHeight=(height+7)&~7,rows=paddedHeight/8,channels=bpp===8?1:3;
 const prefix=((paddedWidth>>>3)+7)>>>3;
 if(alias<0||alias>prefix)throw Error("Alias exceeds skipped prefix");
 const header=Buffer.alloc(48);header.write("CompressedBG___");header.writeUInt16LE(width,16);header.writeUInt16LE(height,18);header.writeUInt32LE(bpp,20);header.writeUInt32LE(128,40);header.writeUInt16LE(2,46);
 let key=0x10203040;header.writeUInt32LE(key,36);const encrypted=Buffer.alloc(128),quant=Buffer.alloc(128,1);let sum=0,xor=0;
 for(let i=0;i<quant.length;i++){const low=Math.imul(20021,key&65535)>>>0,high=(Math.imul(key>>>16,20021)+Math.imul(key,346)+(low>>>16))&65535;key=((high<<16)+(low&65535)+1)>>>0;encrypted[i]=(quant[i]+high)&255;sum=(sum+quant[i])&255;xor^=quant[i];}
 header[44]=sum;header[45]=xor;
 const tokens=paddedWidth/8*channels,weights=[];
 for(const length of [16,176])for(let i=0;i<length;i++)weights.push(integer(i?0:tokens*rows));
 const frequencies=Buffer.concat(weights),offsetTable=Buffer.alloc((rows+1)*4),base=48+encrypted.length;
 const endTable=base+frequencies.length+offsetTable.length;
 const dc=Buffer.alloc(Math.ceil(tokens/8)),ac=Buffer.alloc(Math.ceil(tokens/8));
 const entropy=Buffer.concat([integer(paddedWidth*8*channels),dc,ac]);
 const parts=[];let cursor=endTable;
 for(let row=0;row<rows;row++){
  const overlap=row===0?alias:0;offsetTable.writeUInt32LE(cursor-overlap-base,row*4);
  const strip=Buffer.concat([Buffer.alloc(prefix-overlap,0xff),entropy]);parts.push(strip);cursor+=strip.length;
 }
 let alpha=Buffer.alloc(0);if(bpp===32){offsetTable.writeUInt32LE(cursor-base,rows*4);const values=alphaValues||Array.from({length:paddedWidth*paddedHeight},(_,i)=>(i*17+(i>>>3))&255);const pieces=[Buffer.from([1,0,0,0])];for(let i=0;i<values.length;i+=8)pieces.push(Buffer.concat([Buffer.from([0]),Buffer.from(values.slice(i,i+8))]));alpha=Buffer.concat(pieces);}
 else offsetTable.writeUInt32LE(nonAlphaWord>>>0,rows*4);
 return {bytes:Buffer.concat([header,encrypted,frequencies,offsetTable,...parts,alpha]),width,height,bpp,paddedWidth,paddedHeight,prefix,endTable,offsetTableAt:base+frequencies.length,rows,expectedPixel:[128,128,128,255]};
}
module.exports={cbg,integer};
if(require.main===module){const dir=process.argv[2];fs.mkdirSync(dir,{recursive:true});for(const [name,options]of Object.entries({gray:{},grayAlias:{alias:4},rgbAlias:{bpp:24,alias:4},alphaAlias:{bpp:32,alias:4},grayCrop:{width:9,height:9,alias:1},unusedFinal:{nonAlphaWord:0}})){const value=cbg(options);fs.writeFileSync(path.join(dir,name+".bin"),value.bytes,{flag:"wx",mode:0o600});}console.log("Synthetic CBG2 vectors written");}
