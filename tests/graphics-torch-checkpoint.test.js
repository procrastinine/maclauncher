const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const Checkpoint=require('../src/modules/shared/reshade/neural/torch-checkpoint'),R=require('../src/modules/shared/reshade/neural/restoration-models'),Source=require('../src/modules/shared/reshade/neural/checkpoint-source');
const {writeZipArchive}=require('./helpers/zip-fixture');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),cat=parts=>Buffer.concat(parts.map(p=>Buffer.isBuffer(p)?p:Buffer.from(p,'binary')));
function value(v){
 if(v===null)return Buffer.from('N');if(typeof v==='boolean')return Buffer.from([v?0x88:0x89]);
 if(typeof v==='string'){const b=Buffer.from(v),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return cat(['X',n,b]);}
 if(typeof v==='number'){const b=Buffer.alloc(4);b.writeInt32LE(v);return cat(['J',b]);}
 if(typeof v==='bigint'){const parts=[];let n=v;while(n){parts.push(Number(n&255n));n>>=8n;}if(parts.at(-1)&128)parts.push(0);return Buffer.from([0x8a,parts.length,...parts]);}
 if(Array.isArray(v))return cat(['(',...v.map(value),'t']);
 if(v instanceof Map)return cat(['}(',...[...v].flatMap(([k,x])=>[value(k),value(x)]),'u']);
 if(v?.tensor){const global=s=>Buffer.from('c'+s.replace('.','\n')+'\n'),storage=cat([value(['storage',{global:'torch\nFloatStorage'},v.key,'cpu',v.data.length/4,null]),'Q']);let stride=1;const strides=v.shape.map(()=>0);for(let i=v.shape.length-1;i>=0;i--){strides[i]=stride;stride*=v.shape[i];}
  const dict=cat(['ccollections\nOrderedDict\n)R']);return cat(['ctorch._utils\n_rebuild_tensor_v2\n(',storage,value(0),value(v.shape),value(strides),value(false),dict,'tR']);}
 if(v?.global)return Buffer.from('c'+v.global+'\n');throw Error('unsupported fixture value');
}
const pickle=v=>cat([Buffer.from([0x80,2]),value(v),'.']);
function fixture(t,zipped=false){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'torch-checkpoint-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const rows=Object.entries(R.shapes('realcugan.upcunet2x.v1')).map(([name,shape],index)=>{
  const transpose=/^(unet1\.conv2_up|unet1\.conv_bottom|unet2\.conv[34]_up)\.weight$/.test(name),sourceShape=shape.length===4?(transpose?[shape[3],shape[0],shape[1],shape[2]]:[shape[0],shape[3],shape[1],shape[2]]):shape;
  const data=Buffer.alloc(shape.reduce((a,b)=>a*b,4));for(let i=0;i<data.length/4;i++)data.writeFloatLE((i%251+index)/32,i*4);return {name,tensor:true,key:'s'+index,shape:sourceShape,data};
 }),state=new Map(rows.map(r=>[r.name,r])),file=path.join(root,'model.pth');
 if(zipped)writeZipArchive(file,[{name:'archive/data.pkl',data:pickle(state),deflate:true},{name:'archive/byteorder',data:'little'},...rows.map(r=>({name:'archive/data/'+r.key,data:r.data,deflate:true}))]);
 else fs.writeFileSync(file,cat([pickle(119547037146038801333356n),pickle(1001),pickle(new Map([['little_endian',true]])),pickle(state),pickle(rows.map(r=>r.key)),...rows.flatMap(r=>{const n=Buffer.alloc(8);n.writeBigUInt64LE(BigInt(r.data.length/4));return [n,r.data];})]));
 return {root,file,rows};
}
test('legacy and ZIP Torch storage convert every convolution and transposed convolution without executing checkpoint code',async t=>{
 for(const zipped of [false,true]){const f=fixture(t,zipped),source=Checkpoint.inspect(f.file),target=path.join(f.root,'weights.safetensors'),converted=await Checkpoint.convert(source,target);assert.equal(source.architecture,'realcugan.upcunet2x.v1');assert.equal(converted.tensors.length,60);const bytes=fs.readFileSync(target),at=8+Number(bytes.readBigUInt64LE()),header=JSON.parse(bytes.subarray(8,at));
  for(const row of source.tensors){const original=f.rows.find(r=>r.name===row.name),out=bytes.subarray(at+header[row.name].data_offsets[0],at+header[row.name].data_offsets[1]);
   if(row.layout==='flat')assert.deepEqual(out,original.data);else{const [O,H,W,I]=row.shape;for(let o=0;o<O;o++)for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let i=0;i<I;i++){const from=(row.layout==='OIHW'?((o*I+i)*H+y)*W+x:((i*O+o)*H+y)*W+x)*4,to=(((o*H+y)*W+x)*I+i)*4;assert.equal(out.readUInt32LE(to),original.data.readUInt32LE(from));}}
  }
  assert.equal(converted.sourceFiles[0].sha256,sha(fs.readFileSync(f.file)));assert.equal(Checkpoint.inspect(f.file).stat.size,source.stat.size);
  const controller=new AbortController();controller.abort();await assert.rejects(Checkpoint.convert(source,path.join(f.root,'cancelled'),{signal:controller.signal}),{name:'AbortError'});assert.equal(fs.existsSync(path.join(f.root,'cancelled')),false);
 }
 const f=fixture(t),malicious=path.join(f.root,'unsafe.pth');fs.writeFileSync(malicious,cat([pickle(119547037146038801333356n),pickle(1001),pickle(new Map([['little_endian',true]])),Buffer.from('\x80\x02cos\nsystem\n)R.','binary')]));assert.throws(()=>Checkpoint.inspect(malicious),/supported/);
});
test('pinned checkpoint archive acquisition extracts only the exact bounded model entry',async t=>{
 const f=fixture(t),archive=path.join(f.root,'source.zip');writeZipArchive(archive,[{name:'weights/model.pth',data:fs.readFileSync(f.file),deflate:true},{name:'unrelated.exe',data:'never copied or executed'}]);const original=fs.readFileSync(archive),row={transport:'zip-entry',url:'https://models.invalid/source.zip',file:'model.pth',bytes:fs.statSync(f.file).size,archive:{entry:'weights/model.pth',bytes:original.length,sha256:sha(original)}},target=path.join(f.root,'selected.pth');let requests=0;
 await Source.downloadEntry(row,target,{}, {downloadToFile:async(_url,dest,{onProgress})=>{requests++;fs.writeFileSync(dest,original,{flag:'wx'});onProgress({downloaded:original.length,total:original.length});}});assert.equal(requests,1);assert.deepEqual(fs.readFileSync(target),fs.readFileSync(f.file));assert.equal(fs.readdirSync(f.root).some(n=>n.startsWith('selected.pth.archive-')),false);assert.equal(fs.existsSync(path.join(f.root,'unrelated.exe')),false);
 await assert.rejects(Source.downloadEntry({...row,archive:{...row.archive,sha256:'0'.repeat(64)}},path.join(f.root,'bad.pth'),{}, {downloadToFile:async(_url,dest)=>fs.writeFileSync(dest,original)}),/checksum/);assert.equal(fs.existsSync(path.join(f.root,'bad.pth')),false);
});
test('bounded source ranges retry only interrupted chunks and verify the complete model before publication',async t=>{
 const f=fixture(t),bytes=Buffer.alloc((8<<20)+31);for(let n=0;n<bytes.length;n++)bytes[n]=n%251;const row={transport:'bounded-ranges',url:'https://models.invalid/model.pth',bytes:bytes.length,sha256:sha(bytes)},target=path.join(f.root,'range-model.pth');let first=true;const ranges=[];
 const fetchUrlBuffer=async(_url,{headers,maxBytes})=>{const range=/^bytes=(\d+)-(\d+)$/.exec(headers.Range),begin=Number(range[1]),end=Number(range[2]);ranges.push([begin,end]);assert.ok(maxBytes<=4<<20);if(begin===0&&first){first=false;throw Error('interrupted response');}return {status:206,headers:{'content-range':`bytes ${begin}-${end}/${bytes.length}`},body:bytes.subarray(begin,end+1)};};
 await Source.downloadFile(row,target,{}, {fetchUrlBuffer});assert.deepEqual(fs.readFileSync(target),bytes);assert.equal(ranges.length,4);assert.equal(ranges.filter(r=>r[0]===0).length,2);
 const previous=Buffer.from('existing model');fs.writeFileSync(target,previous);await assert.rejects(Source.downloadFile(row,target,{}, {fetchUrlBuffer}),{code:'EEXIST'});assert.deepEqual(fs.readFileSync(target),previous);
 await assert.rejects(Source.downloadFile(row,path.join(f.root,'invalid.pth'),{}, {fetchUrlBuffer:async()=>({status:200,headers:{},body:bytes})}),/byte range/);assert.equal(fs.existsSync(path.join(f.root,'invalid.pth')),false);assert.equal(fs.readdirSync(f.root).some(n=>n.includes('.ranges-')),false);
});
