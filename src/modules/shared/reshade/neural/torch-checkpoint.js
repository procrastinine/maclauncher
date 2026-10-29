// Copyright (c) MacLauncher contributors. MIT license.
// Reads tensor storage as data. Pickle globals are inert tokens; no Python,
// constructors, checkpoint code or vendor libraries are executed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Zip=require('../../runtime/zip'),R=require('./restoration-models');
const metadataLimit=4<<20,maximumBytes=1<<30,marker=Symbol('mark');
const unchanged=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
const fail=()=>{throw Error('Choose a complete supported floating-point Torch checkpoint.');};
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const elements=shape=>shape.reduce((a,b)=>{if(!integer(b,1)||a>maximumBytes/b)fail();return a*b;},1);
class MetadataReader{
 constructor(bytes){this.bytes=bytes;this.at=0;this.storages=new Map();}
 take(n){if(!integer(n)||this.at>this.bytes.length-n)fail();const r=this.bytes.subarray(this.at,this.at+n);this.at+=n;return r;}
 line(){const end=this.bytes.indexOf(10,this.at);if(end<0||end-this.at>4096)fail();const out=this.bytes.toString('utf8',this.at,end);this.at=end+1;return out;}
 string(n){if(n>65536)fail();return this.take(n).toString('utf8');}
 storage(args){
  if(!Array.isArray(args)||args[0]!=='storage'||args[1]?.global!=='torch\nFloatStorage'&&args[1]?.global!=='torch\nHalfStorage'||typeof args[2]!=='string'||!/^\w{1,128}$/.test(args[2])||typeof args[3]!=='string'||!/^(cpu|cuda(?::\d+)?)$/.test(args[3])||!integer(args[4],1)||args[4]>maximumBytes/2||args[5]!=null)fail();
  const dtype=args[1].global.endsWith('HalfStorage')?'F16':'F32',key=args[2],count=args[4],prior=this.storages.get(key);
  if(prior&&(prior.dtype!==dtype||prior.count!==count))fail();const storage=prior||{key,dtype,count,bytes:count*(dtype==='F16'?2:4)};this.storages.set(key,storage);return {storage};
 }
 reduce(call,args){
  if(!Array.isArray(args))fail();
  if(call?.global==='collections\nOrderedDict'){if(args.length)fail();return new Map();}
  if(['torch._utils\n_rebuild_tensor_v2','torch._utils\n_rebuild_tensor'].includes(call?.global)){
   const [reference,offset,shape,stride]=args;if(!reference?.storage||!integer(offset)||!Array.isArray(shape)||!Array.isArray(stride)||shape.length!==stride.length||shape.length<1||shape.length>4)fail();
   const count=elements(shape);let expected=1;for(let n=shape.length-1;n>=0;n--){if(stride[n]!==expected)fail();expected*=shape[n];}
   if(offset>reference.storage.count-count||args[4]!==undefined&&typeof args[4]!=='boolean'||args[5]!==undefined&&!(args[5] instanceof Map)||args[6]!=null)fail();return {tensor:true,storage:reference.storage,offset,shape};
  }
  fail();
 }
 load(){
  const stack=[],memo=new Map();let operations=0;
  const pop=()=>{if(!stack.length)fail();return stack.pop();},top=()=>{if(!stack.length)fail();return stack[stack.length-1];};
  const marked=()=>{const at=stack.lastIndexOf(marker);if(at<0)fail();return stack.splice(at).slice(1);};
  const set=(target,key,value)=>{if(!(target instanceof Map)||typeof key!=='string'||target.size>32768)fail();target.set(key,value);};
  const remember=key=>{if(!integer(key)||key>100000||memo.has(key))fail();memo.set(key,top());};
  while(this.at<this.bytes.length&&++operations<=1000000){
   const code=this.take(1)[0];switch(code){
    case 0x80:if(![2,3,4,5].includes(this.take(1)[0]))fail();break;
    case 0x95:{const n=this.take(8).readBigUInt64LE();if(n>BigInt(metadataLimit))fail();break;}
    case 0x2e:if(stack.length!==1)fail();return pop();
    case 0x28:stack.push(marker);break;
    case 0x4e:stack.push(null);break;
    case 0x88:stack.push(true);break;case 0x89:stack.push(false);break;
    case 0x4b:stack.push(this.take(1)[0]);break;case 0x4d:stack.push(this.take(2).readUInt16LE());break;case 0x4a:stack.push(this.take(4).readInt32LE());break;
    case 0x8a:case 0x8b:{const n=code===0x8a?this.take(1)[0]:this.take(4).readUInt32LE();if(n<1||n>16)fail();const b=this.take(n);let value=0n;for(let i=n-1;i>=0;i--)value=(value<<8n)|BigInt(b[i]);if(b[n-1]&128)value-=1n<<BigInt(n*8);stack.push(value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):value);break;}
    case 0x58:stack.push(this.string(this.take(4).readUInt32LE()));break;
    case 0x8c:case 0x55:stack.push(this.string(this.take(1)[0]));break;
    case 0x63:{const global=this.line()+'\n'+this.line();if(!['collections\nOrderedDict','torch\nFloatStorage','torch\nHalfStorage','torch._utils\n_rebuild_tensor_v2','torch._utils\n_rebuild_tensor'].includes(global))fail();stack.push({global});break;}
    case 0x93:{const name=pop(),module=pop(),global=module+'\n'+name;if(typeof name!=='string'||typeof module!=='string'||!['collections\nOrderedDict','torch\nFloatStorage','torch\nHalfStorage','torch._utils\n_rebuild_tensor_v2','torch._utils\n_rebuild_tensor'].includes(global))fail();stack.push({global});break;}
    case 0x29:case 0x5d:stack.push([]);break;case 0x7d:stack.push(new Map());break;
    case 0x74:case 0x6c:stack.push(marked());break;
    case 0x85:stack.push([pop()]);break;case 0x86:{const b=pop(),a=pop();stack.push([a,b]);break;}case 0x87:{const c=pop(),b=pop(),a=pop();stack.push([a,b,c]);break;}
    case 0x64:{const args=marked(),out=new Map();if(args.length%2)fail();for(let i=0;i<args.length;i+=2)set(out,args[i],args[i+1]);stack.push(out);break;}
    case 0x73:{const value=pop(),key=pop();set(top(),key,value);break;}
    case 0x75:{const args=marked(),target=top();if(args.length%2)fail();for(let i=0;i<args.length;i+=2)set(target,args[i],args[i+1]);break;}
    case 0x61:{const value=pop(),target=top();if(!Array.isArray(target))fail();target.push(value);break;}
    case 0x65:{const args=marked(),target=top();if(!Array.isArray(target))fail();target.push(...args);break;}
    case 0x71:remember(this.take(1)[0]);break;case 0x72:remember(this.take(4).readUInt32LE());break;case 0x94:remember(memo.size);break;
    case 0x68:case 0x6a:{const key=code===0x68?this.take(1)[0]:this.take(4).readUInt32LE();if(!memo.has(key))fail();stack.push(memo.get(key));break;}
    case 0x51:stack.push(this.storage(pop()));break;
    case 0x52:{const args=pop(),call=pop();stack.push(this.reduce(call,args));break;}
    case 0x62:{const state=pop(),target=top();if(!(target instanceof Map)||!(state instanceof Map)||[...state.keys()].some(k=>k!=='_metadata'))fail();break;}
    default:fail();
   }
   if(stack.length>100000||memo.size>100000)fail();
  }fail();
 }
}
function entries(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const info=Zip.findZipEocd(fd);if(!info)return null;if(info.cdSize>metadataLimit||info.entries>32768)fail();return Zip.readCentralDirectory(fd,info,{metadata:true});}finally{fs.closeSync(fd);}
}
function inspect(file){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<64||stat.size>maximumBytes)fail();
 const zipped=entries(file),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let reader,checkpoint,records;
 try{
  if(zipped){
   const names=new Map();for(const row of zipped){if(typeof row.name!=='string'||row.name.startsWith('/')||row.name.split('/').some(p=>p==='..')||names.has(row.name)||row.flags&1||![0,8].includes(row.compressionMethod))fail();names.set(row.name,row);}
   const candidates=zipped.filter(row=>/(^|\/)data\.pkl$/.test(row.name));if(candidates.length!==1)fail();const prefix=candidates[0].name.slice(0,-8),byteorder=names.get(prefix+'byteorder');if(byteorder&&Zip.readZipEntry(file,byteorder,{maxOutputBytes:16}).toString()!=='little')fail();
   reader=new MetadataReader(Zip.readZipEntry(file,candidates[0],{maxOutputBytes:metadataLimit}));checkpoint=reader.load();if(reader.at!==reader.bytes.length)fail();
   for(const storage of reader.storages.values()){const entry=names.get(prefix+'data/'+storage.key);if(!entry||entry.uncompressedSize!==storage.bytes)fail();storage.entry=entry;}
  }else{
   const bytes=Buffer.alloc(Math.min(stat.size,metadataLimit));if(fs.readSync(fd,bytes,0,bytes.length,0)!==bytes.length)fail();reader=new MetadataReader(bytes);
   if(reader.load()!==119547037146038801333356n||reader.load()!==1001)fail();const system=reader.load();if(!(system instanceof Map)||system.get('little_endian')!==true)fail();
   checkpoint=reader.load();const order=reader.load();if(!Array.isArray(order)||new Set(order).size!==order.length||order.length!==reader.storages.size)fail();let offset=reader.at;
   for(const key of order){const storage=reader.storages.get(key);if(!storage||offset>stat.size-8)fail();const size=Buffer.alloc(8);if(fs.readSync(fd,size,0,8,offset)!==8||size.readBigUInt64LE()!==BigInt(storage.count))fail();storage.fileOffset=offset+8;offset+=8+storage.bytes;if(offset>stat.size)fail();}if(offset!==stat.size)fail();
  }
  if(!(checkpoint instanceof Map))fail();const root=checkpoint.has('params_ema')?checkpoint.get('params_ema'):checkpoint.has('params')?checkpoint.get('params'):checkpoint;if(!(root instanceof Map))fail();
  records=[...root].map(([name,row])=>{if(typeof name!=='string'||!row?.tensor)fail();return {name,...row};});if(!records.length||records.length>10000)fail();
  if(!unchanged(stat,fs.fstatSync(fd)))fail();
 }finally{fs.closeSync(fd);}
 const mapping=record=>{
  const name=record.name.replace(/\.sca\.1\./g,'.sca.').replace(/^(ups\.\d+)\.0\./,'$1.'),shape=record.shape;
  const transpose=shape.length===4&&name.endsWith('.weight'),deconvolution=/^(unet1\.conv2_up|unet1\.conv_bottom|unet2\.conv[34]_up)\.weight$/.test(name);
  return {...record,name,layout:transpose?(deconvolution?'IOHW':'OIHW'):'flat',shape:transpose?(deconvolution?[shape[1],shape[2],shape[3],shape[0]]:[shape[0],shape[2],shape[3],shape[1]]):/\.(beta|gamma)$/.test(name)&&shape.length===4?[1,1,1,elements(shape)]:shape};
 };
 const tensors=records.map(mapping),architecture=Object.keys(R.ARCHITECTURES).filter(id=>['realcugan','nafnet'].includes(R.ARCHITECTURES[id].method)).find(id=>R.matches(id,tensors.map(row=>({name:row.name,shape:row.shape,dataType:row.storage.dtype==='F16'?'float16':'float32'}))));
 if(!architecture)throw Error('Choose Real-CUGAN UpCunet2x/3x/4x, NAFNet SIDD width64 or NAFNet GoPro width64 weights.');
 return {file:fs.realpathSync(file),stat,architecture,operation:R.ARCHITECTURES[architecture].method,tensors,adapter:'torch-storage-v1'};
}
async function convert(source,destination,{signal,onProgress}={}){
 signal?.throwIfAborted();if(!unchanged(source.stat,await fs.promises.lstat(source.file)))throw Error('The checkpoint changed before conversion.');
 const input=await fs.promises.open(source.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),parts=[],header={},tensors=[];let offset=0,index=0;
 try{for(const row of source.tensors){
  signal?.throwIfAborted();const size=row.storage.dtype==='F16'?2:4,count=elements(row.shape),length=count*size;let storage;
  if(row.storage.entry)storage=Zip.readZipEntry(source.file,row.storage.entry,{maxOutputBytes:row.storage.bytes});else{storage=Buffer.alloc(length);if((await input.read(storage,0,length,row.storage.fileOffset+row.offset*size)).bytesRead!==length)fail();}
  const raw=row.storage.entry?storage.subarray(row.offset*size,row.offset*size+length):storage,output=row.layout==='flat'?raw:Buffer.alloc(length);
  if(row.layout!=='flat'){
   const [O,H,W,I]=row.shape;
   for(let o=0;o<O;o++)for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let i=0;i<I;i++){
    const from=(row.layout==='OIHW'?((o*I+i)*H+y)*W+x:((i*O+o)*H+y)*W+x)*size,to=(((o*H+y)*W+x)*I+i)*size;
    raw.copy(output,to,from,from+size);
   }
  }
  for(let n=0;n<output.length;n+=size)if(size===4?!Number.isFinite(output.readFloatLE(n)):(output.readUInt16LE(n)&0x7c00)===0x7c00)throw Error('The checkpoint contains nonfinite weights.');
  if(Object.hasOwn(header,row.name))fail();header[row.name]={dtype:row.storage.dtype,shape:row.shape,data_offsets:[offset,offset+length]};parts.push(output);offset+=length;tensors.push({name:row.name,shape:row.shape,dataType:size===2?'float16':'float32'});
  onProgress?.({phase:'import',completed:++index,total:source.tensors.length,label:'Converting model storage…'});await new Promise(resolve=>setImmediate(resolve));
 }
 if(!unchanged(source.stat,await input.stat()))throw Error('The checkpoint changed during conversion.');
 }finally{await input.close();}
 signal?.throwIfAborted();const original=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(source.file,{signal}))original.update(chunk);if(!unchanged(source.stat,await fs.promises.lstat(source.file)))throw Error('The checkpoint changed during conversion.');
 const json=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(json.length));const result=Buffer.concat([length,json,...parts]);await fs.promises.writeFile(destination,result,{flag:'wx'});
 return {architecture:source.architecture,operation:source.operation,tensors,sha256:crypto.createHash('sha256').update(result).digest('hex'),sourceFiles:[{file:path.basename(source.file),sha256:original.digest('hex'),adapter:source.adapter}]};
}
module.exports={inspect,convert};
