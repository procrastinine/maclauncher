import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const declaration=JSON.parse(fs.readFileSync(path.join(directory,'timing/source.json')));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const revision=folder=>execFileSync('git',['-C',folder,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const ownedFiles=['prepare-mlx-timing.mjs','timing/source.json','timing/metal-job.h','timing/metal-job.cpp.inc','timing/MLXGPUJob.swift'];
const appliedFiles=['Source/Cmlx/mlx/mlx/backend/metal/device.cpp','Source/Cmlx/include/maclauncher-metal-job.h',
  'Source/Cmlx/include/mlx.h','Source/Cmlx/mlx-c/mlx/c/transforms.cpp','Source/MLX/Transforms+Eval.swift',
  'Source/MLX/MLXArray.swift','Source/MLX/MLXGPUJob.swift'];
const currentOwned=()=>Object.fromEntries(ownedFiles.map(file=>[file,digest(fs.readFileSync(path.join(directory,file)))]));
export function verifyTimingReceipt(receipt){
  const owned=currentOwned();
  if(!receipt||receipt.schema!==1||JSON.stringify(receipt.source)!==JSON.stringify(declaration.source)
    ||JSON.stringify(receipt.nested)!==JSON.stringify(declaration.nested)||JSON.stringify(receipt.files)!==JSON.stringify(declaration.files)
    ||JSON.stringify(receipt.owned)!==JSON.stringify(owned)
    ||receipt.sourceHash!==digest(Buffer.from(JSON.stringify({declaration,owned})))
    ||!receipt.applied||Object.keys(receipt.applied).sort().join('\n')!==[...appliedFiles].sort().join('\n')
    ||Object.values(receipt.applied).some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))
    throw new Error('The MLX GPU timing receipt does not match its declared sources and owned adaptation.');
  return true;
}
function replace(source,anchor,replacement){
  if(source.split(anchor).length!==2)throw new Error('The exact MLX GPU timing adaptation is ambiguous.');
  return source.replace(anchor,replacement);
}
const wrappers=`
extern "C" int maclauncher_mlx_eval_gpu_job(mlx_vector_array outputs,uint64_t token) {
  const auto previous=maclauncher_mlx_gpu_encoding_enter(token);
  const auto result=mlx_eval(outputs);maclauncher_mlx_gpu_encoding_leave(previous);return result;
}
extern "C" int maclauncher_mlx_async_eval_gpu_job(mlx_vector_array outputs,uint64_t token) {
  const auto previous=maclauncher_mlx_gpu_encoding_enter(token);
  const auto result=mlx_async_eval(outputs);maclauncher_mlx_gpu_encoding_leave(previous);return result;
}
extern "C" int maclauncher_mlx_array_eval_gpu_job(mlx_array output,uint64_t token) {
  const auto previous=maclauncher_mlx_gpu_encoding_enter(token);
  const auto result=mlx_array_eval(output);maclauncher_mlx_gpu_encoding_leave(previous);return result;
}
`;

export function prepareMLXTiming(sourceDirectory,buildRoot){
  sourceDirectory=fs.realpathSync(sourceDirectory);
  if(revision(sourceDirectory)!==declaration.source.commit)throw new Error('The MLX Swift timing source does not match its exact revision.');
  for(const row of declaration.nested)if(revision(path.join(sourceDirectory,row.path))!==row.commit)
    throw new Error('A nested MLX timing source does not match its registered revision.');
  for(const [file,sha256]of Object.entries(declaration.files))if(digest(fs.readFileSync(path.join(sourceDirectory,file)))!==sha256)
    throw new Error('An upstream MLX timing input changed.');
  const owned=currentOwned();
  const identity=digest(Buffer.from(JSON.stringify({declaration,owned}))),target=path.join(path.resolve(buildRoot),'owned-source','mlx-swift');
  const metadataPath=path.join(target,'maclauncher-gpu-timing.json');
  if(fs.existsSync(metadataPath)){
    const current=JSON.parse(fs.readFileSync(metadataPath));
    if(current.sourceHash===identity&&Object.entries(current.applied).every(([file,sha])=>digest(fs.readFileSync(path.join(target,file)))===sha))return target;
  }
  const temporary=target+'.preparing-'+crypto.randomUUID();fs.mkdirSync(path.dirname(target),{recursive:true});
  try{
    fs.cpSync(sourceDirectory,temporary,{recursive:true,preserveTimestamps:true,mode:fs.constants.COPYFILE_FICLONE,filter:file=>path.basename(file)!=='.git'});
    const applied={};
    const write=(file,value)=>{const full=path.join(temporary,file),bytes=Buffer.from(value);fs.mkdirSync(path.dirname(full),{recursive:true});if(fs.existsSync(full))fs.chmodSync(full,0o644);fs.writeFileSync(full,bytes);const old=path.join(target,file);if(fs.existsSync(old)&&fs.readFileSync(old).equals(bytes)){const stat=fs.statSync(old);fs.utimesSync(full,stat.atime,stat.mtime);}applied[file]=digest(bytes);};
    const read=file=>fs.readFileSync(path.join(sourceDirectory,file),'utf8');
    let device=read('Source/Cmlx/mlx/mlx/backend/metal/device.cpp');
    device=replace(device,'namespace mlx::core::metal {',fs.readFileSync(path.join(directory,'timing/metal-job.cpp.inc'),'utf8')+'\nnamespace mlx::core::metal {');
    device=replace(device,'MTL::CommandBuffer* Device::get_command_buffer(int index) {\n  auto& stream = get_stream_(index);',`MTL::CommandBuffer* Device::get_command_buffer(int index) {
  auto& stream = get_stream_(index);
  if (stream.buffer != nullptr && maclauncher_mlx_timing::owner(stream.buffer) != maclauncher_mlx_timing::encodingToken) {
    end_encoding(index);commit_command_buffer(index);
  }`);
    device=replace(device,'  return stream.buffer;\n}', '  maclauncher_mlx_timing::bind(stream.buffer);\n  return stream.buffer;\n}');
    device=replace(device,'CommandEncoder& Device::get_command_encoder(int index) {\n  auto& stream = get_stream_(index);',
      'CommandEncoder& Device::get_command_encoder(int index) {\n  auto& stream = get_stream_(index);\n  get_command_buffer(index);');
    device=replace(device,'  stream.buffer->commit();','  maclauncher_mlx_timing::committing(stream.buffer);\n  stream.buffer->commit();');
    if(device.split('  stream_.buffer_ops++;').length!==3)throw new Error('The MLX dispatch accounting changed.');
    device=device.replaceAll('  stream_.buffer_ops++;','  maclauncher_mlx_timing::dispatched(stream_.buffer);\n  stream_.buffer_ops++;');
    write('Source/Cmlx/mlx/mlx/backend/metal/device.cpp',device);
    write('Source/Cmlx/include/maclauncher-metal-job.h',fs.readFileSync(path.join(directory,'timing/metal-job.h')));
    write('Source/Cmlx/include/mlx.h',read('Source/Cmlx/include/mlx.h')+'\n#include "maclauncher-metal-job.h"\n');
    write('Source/Cmlx/mlx-c/mlx/c/transforms.cpp','#include "maclauncher-metal-job.h"\n'+read('Source/Cmlx/mlx-c/mlx/c/transforms.cpp')+wrappers);
    let evalSource=read('Source/MLX/Transforms+Eval.swift');
    if(!evalSource.includes('mlx_eval(vector_array)')||!evalSource.includes('mlx_async_eval(vector_array)'))throw new Error('The MLX evaluation entrypoints changed.');
    evalSource=evalSource.replaceAll('mlx_eval(vector_array)','maclauncher_mlx_eval_gpu_job(vector_array, MLXGPUJob.currentToken)').replaceAll('mlx_async_eval(vector_array)','maclauncher_mlx_async_eval_gpu_job(vector_array, MLXGPUJob.currentToken)');
    write('Source/MLX/Transforms+Eval.swift',evalSource);
    write('Source/MLX/MLXArray.swift',replace(read('Source/MLX/MLXArray.swift'),'mlx_array_eval(ctx)','maclauncher_mlx_array_eval_gpu_job(ctx, MLXGPUJob.currentToken)'));
    write('Source/MLX/MLXGPUJob.swift',fs.readFileSync(path.join(directory,'timing/MLXGPUJob.swift')));
    fs.writeFileSync(path.join(temporary,'maclauncher-gpu-timing.json'),JSON.stringify({schema:1,sourceHash:identity,...declaration,owned,applied},null,2)+'\n');
    fs.rmSync(target,{recursive:true,force:true});fs.renameSync(temporary,target);return target;
  }catch(error){fs.rmSync(temporary,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw new Error('Usage: prepare-mlx-timing.mjs SOURCE BUILD_ROOT');
  console.log(prepareMLXTiming(process.argv[2],process.argv[3]));
}
