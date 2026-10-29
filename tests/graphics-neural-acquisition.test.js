const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const Setup=require('../src/modules/shared/reshade/neural/setup'),Models=require('../src/modules/shared/reshade/neural/models'),Restoration=require('../src/modules/shared/reshade/neural/restoration-models');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'neural-acquire-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'original.safetensors'),header={},parts=[];let offset=0,index=0;
 for(const [name,shape]of Object.entries(Restoration.shapes('realesrgan.srvgg-16.x4.v1'))){
  const match=/^body\.(\d+)\.(weight|bias)$/.exec(name),row=Number(match[1]),kind=match[2],target=row===34?'last_conv.'+kind:row===0?'first_conv.'+kind:row===1?'first_act.'+kind:`body_pairs.${Math.floor(row/2)-1}.${row%2?'act':'conv'}.${kind}`;
  const bytes=Buffer.alloc(shape.reduce((a,b)=>a*b,2));for(let n=0;n<bytes.length;n+=2)bytes.writeUInt16LE(0x3000+(index%16),n);index++;
  header[target]={dtype:'F16',shape,data_offsets:[offset,offset+bytes.length]};offset+=bytes.length;parts.push(bytes);
 }
 const json=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(json.length));const bytes=Buffer.concat([length,json,...parts]);fs.writeFileSync(file,bytes);const notice=Buffer.from('Original trained model terms.');
 const files=[{file:'model.safetensors',url:'https://models.invalid/model',bytes:bytes.length,sha256:hash(bytes)},{file:'LICENSE.txt',url:'https://models.invalid/LICENSE',bytes:notice.length,sha256:hash(notice)}],source={version:'trained-anime',method:'realesrgan',label:'Trained Anime',kind:'weights',entry:'model.safetensors',files,bytes:files.reduce((s,r)=>s+r.bytes,0),repository:'https://models.invalid',commit:'a'.repeat(40),releaseUrl:'https://models.invalid/source',sourceLicense:'BSD-3-Clause',weightTerms:'Original terms.',description:'Pinned model.'};let downloads=0;
 return {root,file,bytes,parts,source,userDataDir:path.join(root,'profile'),downloads:()=>downloads,downloadToFile:async(url,target,{signal,onProgress})=>{signal?.throwIfAborted();downloads++;const selected=url.endsWith('/LICENSE')?notice:bytes;fs.writeFileSync(target,selected,{flag:'wx'});onProgress?.({downloaded:selected.length,total:selected.length});}};
}
test('explicit checkpoint acquisition converts only names, retains notices and reuses the installed operation offline',async t=>{
 const f=fixture(t);let consent=0;const installed=await Setup.downloadModel({userDataDir:f.userDataDir,confirmRuntimeInstall:async()=>{consent++;return true;}},f);
 assert.equal(consent,1);assert.equal(f.downloads(),2);assert.equal(installed.operation,'realesrgan');assert.equal(installed.identifier,'Trained Anime');assert.equal(installed.intrinsicScale,4);
 const converted=fs.readFileSync(installed.weightsPath),start=8+Number(converted.readBigUInt64LE());assert.deepEqual(converted.subarray(start),Buffer.concat(f.parts));assert.deepEqual(fs.readFileSync(f.file),f.bytes);
 assert.equal(JSON.parse(fs.readFileSync(path.join(installed.installDir,'download-source.json'))).files.length,2);assert.match(fs.readFileSync(path.join(installed.installDir,'notices/0-LICENSE.txt'),'utf8'),/Original trained/);
 const again=await Setup.downloadModel({userDataDir:f.userDataDir,confirmRuntimeInstall:()=>assert.fail('installed source needs no consent')},{source:f.source,downloadToFile:()=>assert.fail('installed source stays offline')});assert.equal(again.version,installed.version);
 assert.equal(Setup.sourceInstalled(Models.listInstalled(f.userDataDir),f.source).version,installed.version);
 const requests=[];
 assert.equal(await Setup.ensureNeuralModel({userDataDir:f.userDataDir,method:'nafnet',confirmRuntimeInstall:async request=>{requests.push(request.version);return false;}},{downloadToFile:()=>assert.fail('wrong operation cannot be selected')}),null);
 assert.deepEqual(requests,[Setup.sourcesFor('nafnet').find(row=>row.defaultForOperation).version],'an operation with a curated source asks before its own download');
 assert.equal(Setup.sourcesFor('mlx-sr-scene').length,0);
 await assert.rejects(Setup.ensureNeuralModel({userDataDir:f.userDataDir,method:'mlx-sr-scene'},{downloadToFile:()=>assert.fail('wrong operation cannot be selected')}),/Import a compatible model/);
 assert.deepEqual(fs.readdirSync(path.join(f.userDataDir,'runtimes',Models.ID)),[installed.version]);
});
test('declined or corrupt trained sources never publish a package and leave originals intact',async t=>{
 const f=fixture(t);assert.equal(await Setup.downloadModel({userDataDir:f.userDataDir,confirmRuntimeInstall:async()=>false},f),null);assert.equal(await Setup.downloadModel({userDataDir:f.userDataDir},f),null);assert.equal(f.downloads(),0);assert.equal(fs.existsSync(f.userDataDir),false);
 await assert.rejects(Setup.downloadModel({userDataDir:f.userDataDir,confirmRuntimeInstall:async()=>true},{...f,source:{...f.source,files:[{...f.source.files[0],sha256:'0'.repeat(64)}]}}),/checksum/);assert.deepEqual(Models.listInstalled(f.userDataDir),[]);assert.deepEqual(fs.readdirSync(path.join(f.userDataDir,'runtimes',Models.ID)),[]);assert.deepEqual(fs.readFileSync(f.file),f.bytes);
});
