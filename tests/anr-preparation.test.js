const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {decode}=require('../src/modules/shared/reshade/generation/anr/nrx');
const {uniformBytes}=require('../src/modules/shared/reshade/generation/anr/prepare');
function pack(name,content=Buffer.from('abc')){
 const header=Buffer.alloc(4+4+Buffer.byteLength(name)+16);header.writeUInt32LE(1);header.writeUInt32LE(Buffer.byteLength(name),4);header.write(name,8);header.writeBigUInt64LE(BigInt(content.length),header.length-8);
 const plain=zlib.zstdCompressSync(Buffer.concat([header,content])),data=Buffer.alloc(16);data.write('NRX1');data.writeUInt32LE(2,4);data.writeBigUInt64LE(123n,8);
 let state=123n^0x6e725f6e72785f31n,M=(1n<<64n)-1n;for(let offset=0;offset<plain.length;offset+=8){state=(state+0x9e3779b97f4a7c15n)&M;let v=((state^(state>>30n))*0xbf58476d1ce4e5b9n)&M;v=((v^(v>>27n))*0x94d049bb133111ebn)&M;v^=v>>31n;for(let i=0;i<8&&offset+i<plain.length;i++)plain[offset+i]^=Number((v>>BigInt(i*8))&255n);}return Buffer.concat([data,plain]);
}
test('NRX reads bounded relative members and rejects unsafe paths and truncated envelopes',()=>{
 assert.equal(decode(pack('nested/program.json')).get('nested/program.json').toString(),'abc');
 for(const name of ['/escape','../escape','a/../b','a//b','C:file','a\\b','a\0b'])assert.throws(()=>decode(pack(name)),/Unsafe/);
 assert.throws(()=>decode(Buffer.from('NRX1')),/Invalid/);
});
test('ANR uniforms use reflected offsets and reject invalid scalar ranges',()=>{
 const reflection={parameters:[{name:'count',binding:{kind:'uniform',offset:4,size:4},type:{scalarType:'uint32'}},{name:'phase',binding:{kind:'uniform',offset:0,size:4},type:{scalarType:'float32'}}]};
 const bytes=uniformBytes(reflection,{count:123,phase:.75,unused:9});assert.equal(bytes.readUInt32LE(4),123);assert.equal(bytes.readFloatLE(0),.75);
 for(const count of [-1,1.5,2**32,Infinity])assert.throws(()=>uniformBytes(reflection,{count}),/Invalid/);
 assert.throws(()=>uniformBytes({parameters:[{...reflection.parameters[0],binding:{kind:'uniform',offset:4096,size:4}}]},{}),/Invalid/);
});
test('ANR capabilities expose only exact graph sizes and the shared timeline multipliers',()=>{
 const {descriptor,resolve}=require('../src/modules/shared/reshade/generation/anr');assert.deepEqual(descriptor().multipliers,[2,3,4,5]);assert.match(descriptor({width:3440,height:1440}).reason,/exact/);assert.equal(descriptor({width:2560,height:1440}).reason,undefined);assert.equal(resolve('/unused',{platform:'linux'}),null);
});
test('ANR scene catalog keeps explicit 5X phases while existing scene methods keep midpoint contracts',()=>{
 const Plan=require('../src/modules/shared/effects/plan');const rows=Plan.catalog({graphicsCapabilities:{frameGeneration:true,frameGenerationMethods:['anr','metalfx','fsr3'],providerGenerationMethods:['anr','metalfx','fsr3']},graphicsInputs:{depth:true,motionVectors:true,cameraProjection:true}});
 const row=id=>rows.find(r=>r.id==='frame-generation:'+id);assert.equal(row('anr').label,'Apex Neural Rendering');assert.equal(row('anr').outputContract.phases,'explicit');assert.equal(row('anr').outputContract.maximumMultiplier,5);assert.equal(row('anr').inputContract.acceptsSynthetic,false);assert.equal(row('anr').runtimeManagerId,'anr');
 for(const id of ['metalfx','fsr3']){assert.equal(row(id).outputContract.phases,'midpoint');assert.equal(row(id).template.settings.frameMultiplier,2);}
 assert.equal(Plan.validate({schema:2,mode:'advanced',video:[{id:'fg',kind:'frame-generation',enabled:true,method:'anr',settings:{frameGeneration:'anr',frameMultiplier:5}}]}).video[0].settings.frameMultiplier,5);
});
test('usable ANR runtime bypasses consent and preparation',async t=>{
 const Library=require('../src/modules/shared/reshade/generation/anr/library');
 // Exercise install's existing-record short circuit without a provider, network,
 // GPU, source kit or consent callback.
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');const root=fs.mkdtempSync(path.join(os.tmpdir(),'anr-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=Library.directory(root);fs.mkdirSync(directory,{recursive:true});const sizes={};for(const spec of Library.Source.sizes){const target=path.join(directory,spec.id);fs.mkdirSync(target);fs.writeFileSync(path.join(target,'weights.bin'),'fixture');const data=Buffer.from(JSON.stringify({schema:'fsr4_anr_runtime_v1',checkpoint_id:Library.Source.checkpoint,source_kernel_pack_sha256:Library.Source.kernelPack,width:spec.width,height:spec.height,files:{'weights.bin':{bytes:7}}}));fs.writeFileSync(path.join(target,'manifest.json'),data);sizes[spec.id]={width:spec.width,height:spec.height,parity:[{verified:true,psnr:90,bar:80},{verified:true,psnr:91,bar:81}],manifestSha256:crypto.createHash('sha256').update(data).digest('hex')};}
 fs.writeFileSync(path.join(directory,'runtime.json'),JSON.stringify({schema:1,version:Library.Source.version,checkpoint:Library.Source.checkpoint,verified:true,sizes}));let leased=0;
 const installed=await Library.install({userDataDir:root,root:'/missing-provider',useRuntime:async()=>leased++,confirmRuntimeInstall:()=>{throw Error('consent must not run');}});assert.equal(installed.ready,true);assert.equal(leased,1);
 fs.writeFileSync(path.join(directory,'1080p/manifest.json'),'changed');assert.equal(Library.read(root),null);
});
test('graphics off performs no ANR discovery, installation or preparation',()=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path');
 const script=`const Module=require('node:module'),load=Module._load;Module._load=function(id,...rest){if(/generation[\\\\/]anr/.test(id))throw Error('Unexpected ANR load: '+id);return load.call(this,id,...rest)};const G=require('./src/modules/shared/reshade/graphics-settings');G.prepare({},{}).then(()=>process.stdout.write('off'),e=>{console.error(e);process.exitCode=1});`;
 const child=spawnSync(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'off');
});
