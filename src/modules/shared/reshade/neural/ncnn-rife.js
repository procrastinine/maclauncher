// Copyright (c) MacLauncher contributors. MIT license.
// ncnn floating-point model storage: Tencent, BSD-3-Clause. This importer only
// transforms model parameters; video/image pixels never pass through this code.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const R=require('./restoration-models'),architecture='rife.v4.6.ncnn.v1';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const source=require('./native/restoration-sources.json');
function parameterHash(){const record=source.graphs.find(row=>row.id==='rife');if(!/^[a-f0-9]{64}$/.test(record?.parameterSha256||''))throw Error('The RIFE graph source is unavailable.');return record.parameterSha256;}
function inspect(directory){
 if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw Error('Choose a local RIFE v4.6 model directory.');
 const files=['flownet.param','flownet.bin'].map(name=>{const file=path.join(directory,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>128*1024*1024)throw Error('The RIFE source requires regular parameter and weights files.');return {name,file,stat};});
 if(sha(fs.readFileSync(files[0].file))!==parameterHash())throw Error('Choose the exact supported RIFE v4.6 model graph.');return {architecture,files};
}
function convert(inspected,destination,{signal}={}){
 signal?.throwIfAborted();const data=fs.readFileSync(inspected.files[1].file),expected=R.shapes(architecture),header={},tensors=[],parts=[];let at=0,offset=0;
 function read(count,typed){
  let bytes=4,dtype='F32';if(typed){if(at+4>data.length)throw Error('The RIFE weights are incomplete.');const flag=data.readUInt32LE(at);at+=4;if(flag===0x01306b47){bytes=2;dtype='F16';}else if(flag!==0&&flag!==0x0002c056)throw Error('This RIFE model requires floating-point ncnn weights.');}
  const size=count*bytes;if(at+size>data.length)throw Error('The RIFE tensor storage is incomplete.');const content=data.subarray(at,at+size);at+=typed?Math.ceil(size/4)*4:size;return {content,bytes,dtype};
 }
 for(const [key,shape] of Object.entries(expected)){
  if(!key.endsWith('.weight'))continue;const name=key.slice(0,-7);
  const [out,kH,kW,input]=shape,n=out*kH*kW*input,value=read(n,true),converted=Buffer.alloc(n*value.bytes);
  // ncnn stores O,I,H,W for convolution and deconvolution. MLX consumes
  // O,H,W,I; transposed-convolution geometry remains in the actual graph.
  for(let o=0;o<out;o++)for(let i=0;i<input;i++)for(let y=0;y<kH;y++)for(let x=0;x<kW;x++){
   const from=((o*input+i)*kH*kW+y*kW+x)*value.bytes,to=((o*kH*kW+y*kW+x)*input+i)*value.bytes;value.content.copy(converted,to,from,from+value.bytes);
  }
  for(const [key,content,dtype,tensorShape]of [[name+'.weight',converted,value.dtype,shape],[name+'.bias',read(out,false).content,'F32',[out]]]){
   header[key]={dtype,shape:tensorShape,data_offsets:[offset,offset+content.length]};parts.push(content);offset+=content.length;tensors.push({name:key,shape:tensorShape,dataType:dtype==='F16'?'float16':'float32'});
  }
 }
 if(at!==data.length||!R.matches(architecture,tensors))throw Error('The RIFE weights have unexpected trailing data or a different tensor graph.');
 for(const row of inspected.files){const stat=fs.lstatSync(row.file);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>stat[k]!==row.stat[k]))throw Error('The RIFE source changed during import.');}
 signal?.throwIfAborted();const json=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(json.length));fs.writeFileSync(destination,Buffer.concat([length,json,...parts]),{flag:'wx'});
 return {tensors,sha256:sha(fs.readFileSync(destination)),sourceFiles:inspected.files.map(row=>({file:row.name,sha256:sha(fs.readFileSync(row.file))}))};
}
module.exports={architecture,inspect,convert};
