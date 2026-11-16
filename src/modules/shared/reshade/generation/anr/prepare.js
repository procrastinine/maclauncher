// SPDX-License-Identifier: MIT
// Adapted from fsr4-native-macos tools/anr/prepare.py; see NOTICE.md.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
const Source=require('./source.json'),{decode,LIMIT}=require('./nrx');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function file(root,name,expected){
 const target=path.join(root,name),stat=fs.lstatSync(target);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)throw Error('Invalid ANR input: '+name);
 const data=fs.readFileSync(target);if(expected&&digest(data)!==expected)throw Error('Unsupported ANR input identity: '+name);return data;
}
function uniformBytes(reflection,values){
 const fields=reflection.parameters.filter(p=>p.binding.kind==='uniform');let size=0;
 for(const {binding:b}of fields){if(!Number.isSafeInteger(b.offset)||b.offset<0||b.size!==4||b.offset>4092)throw Error('Invalid ANR uniform range.');size=Math.max(size,b.offset+4);}
 const bytes=Buffer.alloc(size);
 for(const f of fields){const b=f.binding,type=f.type.scalarType;if(!['uint32','int32','float32'].includes(type))throw Error('Unsupported ANR uniform type.');if(!Object.hasOwn(values,f.name))continue;const v=values[f.name];if(typeof v!=='number'||!Number.isFinite(v)||type!=='float32'&&(!Number.isInteger(v)||v<(type==='uint32'?0:-2147483648)||v>(type==='uint32'?4294967295:2147483647)))throw Error('Invalid ANR uniform value.');bytes[type==='float32'?'writeFloatLE':type==='uint32'?'writeUInt32LE':'writeInt32LE'](v,b.offset);}
 return bytes;
}
async function prepare({kit,output,size='1080p',converterTool,signal}){
 const spec=Source.sizes.find(s=>s.id===size);if(!spec||!path.isAbsolute(kit)||!path.isAbsolute(output)||!path.isAbsolute(converterTool))throw Error('ANR preparation requires explicit absolute inputs.');
 if(fs.existsSync(output))throw Error('ANR preparation output already exists.');
 const programs=decode(file(kit,'programs/metal-'+size+'/pack.nrx',spec.sha256)),kernels=decode(file(kit,'kernels-metal/pack.nrx',Source.kernelPack));
 const program=JSON.parse(programs.get('program.json'));
 if(program.version!==2||program.checkpoint_id!==Source.checkpoint||program.path!=='metal'||program.width!==spec.width||program.height!==spec.height)throw Error('Unsupported ANR graph geometry or checkpoint.');
 file(kit,'bin/libmetalirconverter.dylib',Source.converter);
 fs.mkdirSync(path.dirname(output),{recursive:true});const temporary=fs.mkdtempSync(path.join(path.dirname(output),'.anr-prepare-'));
 const build=path.join(temporary,'runtime');fs.mkdirSync(build);
 const write=(name,data)=>{const target=path.join(build,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);};
 try{
  write('weights.bin',programs.get('weights.bin'));const compiled={};let index=0;
  for(const key of [...new Set(Object.values(program.stages).flat().map(s=>s.kernel))].sort()){
   signal?.throwIfAborted();const [module,entry]=key.split(':'),prefix=module.replace(/\.slang$/,'')+'/'+module+'.'+entry;
   const reflection=JSON.parse(kernels.get(prefix+'.json')),directory='kernels/k'+index++,target=path.join(build,directory);let bindings,entryName,route;
   if(reflection.nativeMetal){write(directory+'/kernel.metallib',kernels.get(prefix+'.metallib'));bindings=reflection.nativeMetal.bindings;entryName=reflection.nativeMetal.entryPoint;route='native';}
   else{
    const source=path.join(temporary,'kernel-'+index);fs.mkdirSync(source);fs.writeFileSync(path.join(source,'shader.dxil'),kernels.get(prefix+'.dxil'));fs.writeFileSync(path.join(source,'reflection.json'),JSON.stringify(reflection));
    await execFile(converterTool,[path.join(source,'shader.dxil'),path.join(source,'reflection.json'),path.join(kit,'bin/libmetalirconverter.dylib'),target],{signal,timeout:60000,maxBuffer:1024*1024});
    const metadata=JSON.parse(fs.readFileSync(path.join(target,'bindings.json'),'utf8'));bindings=metadata.bindings;entryName=metadata.entry;route='converted';
    for(const name of fs.readdirSync(target))if(name!=='kernel.metallib')fs.unlinkSync(path.join(target,name));
   }
   compiled[key]={path:directory+'/kernel.metallib',entry:entryName,route,bindings,metal_binding_model:'root-buffer-2-to-24-byte-resource-table',resource_count:bindings.filter(x=>!x.sampler).length,sampler_count:bindings.filter(x=>x.sampler).length};
  }
  const stages={};for(const [name,records]of Object.entries(program.stages)){stages[name]=records.map((s,i)=>{
   if(s.op!=='dispatch')throw Error('Unsupported ANR graph operation.');const [module,entry]=s.kernel.split(':'),prefix=module.replace(/\.slang$/,'')+'/'+module+'.'+entry;
   const uniform='uniforms/'+Object.keys(stages).length+'-'+i+'.bin';write(uniform,uniformBytes(JSON.parse(kernels.get(prefix+'.json')),s.uniforms));
   return {kernel:s.kernel,groups:s.groups,threads:s.threads,buffers:s.buffers,images:s.images||{},optional:s.optional||[],label:s.label,uniforms:uniform};
  });}
  const manifest={schema:'fsr4_anr_runtime_v1',release:Source.version,checkpoint_id:Source.checkpoint,backend:'native',width:spec.width,height:spec.height,family:program.family,source_program_sha256:digest(programs.get('program.json')),weights_sha256:digest(programs.get('weights.bin')),source_kernel_pack_sha256:Source.kernelPack,converter_sha256:Source.converter,kernels:compiled,stages,files:{}};
  for(const key of ['buffers','inputs','output','formats','images','swaps'])manifest[key]=program[key];
  for(const name of fs.readdirSync(build,{recursive:true})){const target=path.join(build,name);if(fs.statSync(target).isFile()){const data=fs.readFileSync(target);manifest.files[name]={bytes:data.length,sha256:digest(data)};}}
  write('manifest.json',JSON.stringify(manifest,null,2)+'\n');fs.renameSync(build,output);return manifest;
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={prepare,uniformBytes,file,digest};
