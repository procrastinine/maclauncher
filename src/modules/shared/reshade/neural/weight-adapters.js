// Copyright (c) MacLauncher contributors. MIT license.
// Checkpoint metadata conversion only; image processing remains on the GPU.
const fs=require('node:fs'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const Restoration=require('./restoration-models');
function inspect(file){
  const Models=require('./models'),original=Models.inspectWeights(file,{identify:false});
  if(original.architecture)return {...original,adapter:null};
  for(const depth of [16,32]){
    const architecture=`realesrgan.srvgg-${depth}.x4.v1`,rename=name=>{
      if(name.startsWith('first_conv.'))return 'body.0.'+name.slice(11);
      if(name==='first_act.weight')return 'body.1.weight';
      if(name.startsWith('last_conv.'))return `body.${depth*2+2}.`+name.slice(10);
      const pair=/^body_pairs\.(\d+)\.(conv|act)\.(weight|bias)$/.exec(name);
      return pair?`body.${2*(Number(pair[1])+1)+(pair[2]==='act'?1:0)}.${pair[3]}`:name;
    },tensors=original.tensors.map(row=>({...row,name:rename(row.name)}));
    if(Restoration.matches(architecture,tensors))return {...original,architecture,operation:'realesrgan',tensors,adapter:'srvgg-swift-names-v1',rename};
  }
  throw new Error('Choose compatible neural model weights or a complete model package.');
}
async function convert(source,destination,{signal}={}){
  signal||=undefined;
  if(!source.adapter)throw new Error('Choose a supported checkpoint conversion.');
  signal?.throwIfAborted();const handle=await fs.promises.open(source.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let header,dataStart;
  try{const length=Buffer.alloc(8);if((await handle.read(length,0,8,0)).bytesRead!==8)throw new Error('The checkpoint header is incomplete.');const size=Number(length.readBigUInt64LE());if(!Number.isSafeInteger(size)||size<2||size>require('./models').MAX_MANIFEST||size+8>source.stat.size)throw new Error('The checkpoint header is invalid.');dataStart=8+size;const bytes=Buffer.alloc(size);if((await handle.read(bytes,0,size,8)).bytesRead!==size)throw new Error('The checkpoint header is incomplete.');header=JSON.parse(bytes);}finally{await handle.close();}
  const converted={},ranges=[];
  for(const [name,row]of Object.entries(header)){
    if(name==='__metadata__')continue;
    const target=source.rename(name);if(Object.hasOwn(converted,target))throw new Error('The checkpoint has duplicate converted tensors.');
    converted[target]=row;ranges.push(row.data_offsets);
  }
  ranges.sort((a,b)=>a[0]-b[0]);let end=0;for(const range of ranges){if(range[0]!==end)throw new Error('The checkpoint tensor storage must be contiguous and unique.');end=range[1];}
  if(end!==source.stat.size-dataStart)throw new Error('The checkpoint contains undeclared tensor data.');
  const json=Buffer.from(JSON.stringify(converted)),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(json.length));
  await fs.promises.writeFile(destination,Buffer.concat([length,json]),{flag:'wx'});
  await pipeline(fs.createReadStream(source.file,{start:dataStart,flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,signal}),fs.createWriteStream(destination,{flags:'a'}),{signal});
  const after=await fs.promises.lstat(source.file);if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>source.stat[key]!==after[key]))throw new Error('The selected checkpoint changed during conversion.');
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(source.file,{signal}))hash.update(chunk);
  return {file:require('node:path').basename(source.file),sha256:hash.digest('hex'),adapter:source.adapter};
}
module.exports={inspect,convert};
