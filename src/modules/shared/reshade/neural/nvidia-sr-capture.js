// Copyright (c) MacLauncher contributors. Apache-2.0.
// Exact local-resource conversion from MLX-DLSS 7870371e8bf6c03967213f1a5d40db6c5a3bee38.
// Captured model parameters remain NVIDIA material. No CUDA code is executed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {setImmediate:yieldTurn}=require('node:timers/promises');
const SOURCE='fc19b68cefb4218e0954fab812c782e0aa4d30526e0151c796e8887e0eca3acb';
const PACKED='ddaa59cd82deed53bad9d65b82b454f1439fc4875e4220b3ffafafb6cd0296a1';
const FILTER='88aa97aa1e2cb9e2e7c932476b24793a4fb998a97c76c3b351212224bc00ab3c';
const PTX='5133a026f4355aacd611ee4886a71848cc3e7c5cad4f283ef40ea27ecce4f1de';
const METAL='1bd949170193f077f75f9c08f8a4a9a6abf21088efbd7795ad8cd463be3517ae';
const MODEL='dlss-sr-310.7.0-k-ldr-2x';
const CHANNELS=[32,64,64,96,128,160,128,96,64,64,32],HEADS=[2,2,2,4,4,8,4,4,2,2,2];
const OFFSETS=[0,67264,215872,380928,759552,1384576,2189952,2782848,3161984,3327360,3476352,3545824];
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
function regular(file,maximum){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximum)throw Error('The SR capture contains an invalid or oversized file.');return stat;}
function inspect(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Choose a local SR capture folder.');
 directory=fs.realpathSync(directory);const file=path.join(directory,'libnvidia-ngx-dlss.so.310.7.0'),stat=regular(file,256<<20);
 for(const [name,size]of [['L0001_params.bin',176],['L0012_params.bin',328]])if(regular(path.join(directory,name),328).size!==size)throw Error('The SR capture parameter layout differs from the supported preset.');
 return {file:directory,library:file,stat,architecture:'mlxdlss.super-resolution.preset-k.ldr2x.v1',operation:'mlx-sr-image'};
}
function lz4(bytes,size){
 if(!Number.isSafeInteger(size)||size<1||size>1<<20)throw Error('The scalar shader block is invalid.');
 const output=Buffer.alloc(size);let cursor=0,written=0;
 const length=value=>{if(value===15){let next;do{if(cursor>=bytes.length)throw Error('The scalar shader compression length is incomplete.');next=bytes[cursor++];value+=next;}while(next===255);}return value;};
 while(cursor<bytes.length){const token=bytes[cursor++],literals=length(token>>4);if(cursor>bytes.length-literals||written>size-literals)throw Error('The scalar shader literal exceeds its buffer.');bytes.copy(output,written,cursor,cursor+literals);cursor+=literals;written+=literals;if(cursor===bytes.length)break;if(cursor>bytes.length-2)throw Error('The scalar shader match is incomplete.');const distance=bytes.readUInt16LE(cursor);cursor+=2;const count=length(token&15)+4;if(!distance||distance>written||written>size-count)throw Error('The scalar shader match exceeds its buffer.');for(let i=0;i<count;++i){output[written]=output[written-distance];written++;}}
 if(written!==size)throw Error('The scalar shader decompressed size differs.');return output;
}
function postprocess(library){
 if(digest(library)!==SOURCE)throw Error('SR conversion requires the supported original Linux310.7.0 library.');
 const entry=25420872;if(library.length<entry+8)throw Error('The SR scalar shader entry is incomplete.');
 const offset=entry+library.readUInt32LE(entry+4);if(offset>library.length-44810)throw Error('The SR scalar shader payload is incomplete.');
 const ptx=lz4(library.subarray(offset,offset+44810),149075).toString('utf8');if(digest(ptx)!==PTX)throw Error('The SR scalar shader source differs from the supported model.');
 const metal=require('./ptx-metal').compileKernel(ptx);if(digest(metal)!==METAL)throw Error('The SR scalar shader translation differs from the supported model.');return metal;
}
function readCapture(directory,launch,parameter,bytes){
 const prefix='L'+String(launch).padStart(4,'0'),paramsFile=path.join(directory,prefix+'_params.bin'),paramsStat=regular(paramsFile,328),params=fs.readFileSync(paramsFile);
 if(params.length!==(launch===1?176:328)||!same(paramsStat,fs.lstatSync(paramsFile)))throw Error('The SR launch parameters changed or have an unsupported layout.');
 const address=params.readBigUInt64LE(parameter),entries=fs.readdirSync(directory);if(entries.length>1024)throw Error('The SR capture folder contains too many files.');
 const matches=[];for(const name of entries){const match=new RegExp('^'+prefix+'_buf([0-9a-f]+)\\.bin$').exec(name);if(!match)continue;const file=path.join(directory,name),stat=regular(file,8*1024**3),base=BigInt('0x'+match[1]);if(base<=address&&address+BigInt(bytes)<=base+BigInt(stat.size))matches.push({file,stat,offset:Number(address-base)});}
 if(matches.length!==1)throw Error('The capture must contain one exact SR parameter buffer for '+prefix+'.');
 const selected=matches[0],fd=fs.openSync(selected.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),data=Buffer.alloc(bytes);try{if(fs.readSync(fd,data,0,bytes,selected.offset)!==bytes||!same(selected.stat,fs.fstatSync(fd)))throw Error('The SR capture changed during conversion.');}finally{fs.closeSync(fd);}
 return {bytes:data,source:{file:path.basename(selected.file),offset:selected.offset,bytes,sha256:digest(data),launch,parameter}};
}
function matrix(blob,offset,k,n,kind='b',chunk=null){
 if(k%16||n%16||offset<0||offset>blob.length-k*n*2)throw Error('The packed SR matrix is invalid.');const result=Buffer.alloc(k*n*2);
 for(let j=0;j<n/16;++j)for(let i=0;i<k/16;++i){const index=chunk==null?j*(k/16)+i:Math.floor(i/chunk)*(n/16)*chunk+j*chunk+i%chunk;
  for(let r=0;r<4;++r)for(let lane=0;lane<32;++lane)for(let half=0;half<2;++half){const g=Math.floor(lane/4),t=lane%4,row=kind==='a'?g+(r%2)*8:t*2+(r%2)*8+half,col=kind==='a'?t*2+Math.floor(r/2)*8+half:g+Math.floor(r/2)*8;const source=offset+index*512+((lane*4+r)*2+half)*2,target=((i*16+row)*n+j*16+col)*2;result.writeUInt16LE(blob.readUInt16LE(source),target);}}
 return result;
}
async function decodeWeights(blob,{signal,onProgress}={}){
 if(blob.length!==OFFSETS.at(-1))throw Error('The captured SR weight storage has an unsupported length.');
 const tensors=[];
 for(let index=0;index<CHANNELS.length;++index){signal?.throwIfAborted();const c=CHANNELS[index],heads=HEADS[index],stage=index+1;let cursor=OFFSETS[index];
  const add=(name,shape,data)=>{tensors.push({name:stage+'.'+name,shape,data});};
  const take=(name,shape,kind='b',chunk=null)=>{const count=shape.reduce((a,b)=>a*b,1),data=shape.length===1?Buffer.from(blob.subarray(cursor,cursor+count*2)):matrix(blob,cursor,...shape,kind,chunk);add(name,shape,data);cursor+=count*2;};
  if(stage===1){take('embeddingBias',[32]);take('embedding',[16,32]);}else if(stage>=7){take('embedding',[CHANNELS[index-1],4*c]);take('embeddingBias',[4*c]);}
  take('norm',[c]);for(let head=0;head<heads;++head){for(const [q,name]of ['q','k','v'].entries()){const parts=[];for(let part=0;part<c/32;++part)parts.push(matrix(blob,cursor+part*6144+q*2048,32,32));add(name+head,[c,32],Buffer.concat(parts));}cursor+=c*32*3*2;}
  for(let head=0;head<heads;++head)take('position'+head,[64,64],'a');take('attentionBias',[c]);for(let head=0;head<heads;++head)take('projection'+head,[32,c]);
  take('ffScale',[c]);take('ffOutputBias',[c]);take('ffUp',[c,4*c]);take('ffBias',[4*c]);take('ffDown',[4*c,c],'b',2);
  if(stage<=5){const padded=Math.ceil(CHANNELS[index+1]/(16*heads))*(16*heads);take('merge',[4*c,padded]);take('mergeBias',[padded]);}else if(stage===11){take('outputBias',[48]);take('output',[32,48]);}
  if(cursor!==OFFSETS[index+1])throw Error('The SR stage'+stage+' packed layout differs.');onProgress?.({phase:'import',completed:stage,total:11,label:'Converting SR model storage…'});await yieldTurn();
 }
 return tensors;
}
function safeTensorBytes(tensors){let offset=0;const header={},parts=[];for(const row of tensors){if(Object.hasOwn(header,row.name))throw Error('Duplicate SR tensor.');for(let p=0;p<row.data.length;p+=2)if((row.data.readUInt16LE(p)&0x7c00)===0x7c00)throw Error('The SR model contains nonfinite parameters.');header[row.name]={dtype:'F16',shape:row.shape,data_offsets:[offset,offset+row.data.length]};offset+=row.data.length;parts.push(row.data);}const metadata=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(metadata.length));return Buffer.concat([length,metadata,...parts]);}
async function convert(source,destination,{signal,onProgress}={}){
 signal?.throwIfAborted();if(!source?.library||!same(source.stat,regular(source.library,256<<20)))throw Error('The selected SR source changed before conversion.');
 const library=await fs.promises.readFile(source.library);if(!same(source.stat,fs.lstatSync(source.library)))throw Error('The selected SR library changed during conversion.');
 const metal=postprocess(library),packed=readCapture(source.file,1,64,OFFSETS.at(-1)),filter=readCapture(source.file,12,280,65536);
 if(digest(packed.bytes)!==PACKED||digest(filter.bytes)!==FILTER)throw Error('The capture does not contain the exact supported trained SR weights and reconstruction filter.');
 const tensors=await decodeWeights(packed.bytes,{signal,onProgress});tensors.push({name:'reconstructionFilter',shape:[32768],data:filter.bytes});
 const bytes=safeTensorBytes(tensors);signal?.throwIfAborted();await fs.promises.mkdir(destination,{recursive:false,mode:0o700});
 const manifest={format:'mlxdlss-sr-v1',model:MODEL,postprocessSHA256:METAL,sourceSHA256:SOURCE,weightsSHA256:digest(bytes),sourceFiles:[{file:path.basename(source.library),sha256:SOURCE,adapter:'nvidia-sr-capture-v1'},packed.source,filter.source]};
 await fs.promises.writeFile(path.join(destination,'weights.safetensors'),bytes,{flag:'wx'});await fs.promises.writeFile(path.join(destination,'postprocess.metal'),metal,{flag:'wx'});await fs.promises.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return {architecture:source.architecture,operation:source.operation,tensors:tensors.map(({name,shape})=>({name,shape,dataType:'float16'})),sha256:manifest.weightsSHA256,sourceFiles:manifest.sourceFiles};
}
module.exports={inspect,convert,decodeWeights,matrix,postprocess,lz4,constants:{SOURCE,PACKED,FILTER,PTX,METAL,MODEL}};
