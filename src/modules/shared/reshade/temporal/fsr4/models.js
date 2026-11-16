// Copyright (c) MacLauncher contributors. MIT license.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const spec=require('./model.json'),Writable=require('../../../writable-input');
const {withRuntimeMutation}=require('../../../../../core/coordinated-runtime-managers');
const {downloadApproved}=require('../../../runtime/tool-install'),Upstream=require('../../../runtime/upstream');
const {runDownloadTask}=require('../../../runtime/download-manager');
const descriptor={managerId:spec.managerId,version:spec.version,label:spec.label,sourceUrl:spec.sourceUrl,downloadBytes:spec.archiveBytes};
function directory(userDataDir){if(!path.isAbsolute(userDataDir||''))throw Error('Launcher data directory is unavailable.');return path.join(userDataDir,'runtimes',spec.managerId,spec.version);}
function read(userDataDir){try{const root=directory(userDataDir);Writable.assertOwnDirectory(userDataDir,root,{create:false});const record=JSON.parse(fs.readFileSync(path.join(root,'runtime.json'),'utf8'));
 if(record.version!==spec.version||record.archiveSha256!==spec.archiveSha256||record.preparation!==1||!Array.isArray(record.profiles)||!record.profiles.includes('int8-lite')||record.profiles.some(p=>!['int8-lite','int8-lite-lossy'].includes(p)))return null;
 for(const name of ['initializers-lite.bin','initializers-lite-ultraperformance.bin']){const stat=fs.lstatSync(path.join(root,'build/fsr412_model',name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==27392)return null;}
 return {...descriptor,directory:root,build:path.join(root,'build'),profiles:record.profiles,ready:true};
}catch{return null;}}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Read the actual imported tree. These are operational limits and path checks,
// independent of a release's file count, file hashes or enclosing directory name.
async function inventory(input){
 const rows=[];let bytes=0;
 async function walk(directory,prefix='',depth=0){
  if(depth>12)throw Error('FSR model data exceeds the directory depth limit.');
  for(const item of await fs.promises.readdir(directory,{withFileTypes:true})){
   if(item.name==='.'||item.name==='..')throw Error('Invalid model data path.');
   const relative=prefix?prefix+'/'+item.name:item.name,file=path.join(directory,item.name),stat=await fs.promises.lstat(file);
   if(stat.isSymbolicLink())throw Error('Model data cannot contain symbolic links.');
   if(stat.isDirectory())await walk(file,relative,depth+1);
   else if(stat.isFile()){
    bytes+=stat.size;if(bytes>256*1024*1024||rows.length>=4096)throw Error('FSR model data exceeds installation limits.');
    rows.push({path:relative,bytes:stat.size});
   }else throw Error('Model data must contain ordinary files and directories.');
  }
 }
 await walk(input);return rows;
}
async function verify(input){
 const rows=await inventory(input);
 // The model packer's ABI consumes two initializer arenas and Metal sources.
 for(const name of ['initializers-lite.bin','initializers-lite-ultraperformance.bin'])if(!rows.some(row=>row.path===name&&row.bytes===27392))throw Error('Choose model data containing the Lite initializer arenas.');
 if(!rows.some(row=>row.path.startsWith('lite-shaders/')&&row.path.endsWith('.metal')))throw Error('The Lite model has no translated Metal shaders.');
 return rows;
}
async function findModel(directory,depth=0){
 if(depth>6)return null;
 try{await fs.promises.access(path.join(directory,'initializers-lite.bin'));await fs.promises.access(path.join(directory,'lite-shaders'));return directory;}catch{}
 for(const entry of await fs.promises.readdir(directory,{withFileTypes:true})){if(entry.isDirectory()){const found=await findModel(path.join(directory,entry.name),depth+1);if(found)return found;}}
 return null;
}
async function execute(executable,args,signal){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{...(signal?{signal}:{}),env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PYTHON'))),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'},stdio:['ignore','pipe','pipe']});let error='';child.stdout.resume();child.stderr.on('data',b=>{error=(error+b).slice(-8192)});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('FSR 4.1.2 preparation failed: '+error)));});}
async function prepareData(context,input){
 const installed=require('./index').inspect(context.root);if(!installed||!installed.profiles.includes('int8-lite'))throw Error('Install the FSR 4 v3.2 provider first.');
 const files=await verify(input);
 const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,root);
 // The runtime stays in this final directory: prepared provenance paths remain
 // valid after publication. A receipt is written only once all variants exist.
 // Keep a previously usable receipt while preparing additional profiles.
 const model=path.join(root,'build/fsr412_model');await fs.promises.mkdir(model,{recursive:true});
 for(const row of files){const to=path.join(model,row.path);await fs.promises.mkdir(path.dirname(to),{recursive:true});if(path.resolve(input,row.path)!==to)await fs.promises.copyFile(path.join(input,row.path),to);}
 await fs.promises.cp(path.join(installed.directory,'preparation'),path.join(root,'tools'),{recursive:true});
 await fs.promises.copyFile(path.join(installed.directory,'fsr411_msl.py'),path.join(root,'tools/fsr411_msl.py'));
 await fs.promises.cp(path.join(installed.directory,'src'),path.join(root,'src'),{recursive:true});
 const profiles=['int8-lite'];
 const kitTools=path.resolve(input,'../../tools');
 // The kit archive has already passed its catalog digest. Copy only the
 // native decoder and its actual library dependency when that kit supplies them.
 const helpers=[];
 if(context.verifiedArchive)for(const name of ['bin/dxc','lib/libdxcompiler.dylib']){
   const source=path.join(kitTools,name),stat=await fs.promises.lstat(source);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024*1024)throw Error('Invalid native model decoder.');
   const data=await fs.promises.readFile(source),destination=path.join(root,'tools',name);
   await fs.promises.mkdir(path.dirname(destination),{recursive:true});await fs.promises.writeFile(destination,data,{mode:0o755});
   helpers.push({path:name,bytes:data.length,sha256:sha(data)});
 }
 // A local upstream preparation may also carry the separately verified GPL
 // initializer and its conditional/subpixel bias receipt.
 for(const lossy of [path.resolve(input,'../fsr412_lossy'),path.join(root,'build/fsr412_lossy')])try{if(sha(await fs.promises.readFile(path.join(lossy,'initializers-lite-lossy.bin')))==='c77c2d1a4d119ed76d94b8c23335490cc38280db3346c72396a1e1acb0523cfc'){
   await fs.promises.mkdir(path.join(root,'build/fsr412_lossy'),{recursive:true});
   for(const file of ['initializers-lite-lossy.bin','import.json']){const destination=path.join(root,'build/fsr412_lossy',file);if(path.join(lossy,file)!==destination)await fs.promises.copyFile(path.join(lossy,file),destination);}profiles.push('int8-lite-lossy');break;
 }}catch(error){context.signal?.throwIfAborted();}
 const Python=require('../../../runtime/python'),python=Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());if(!python)throw Error('The included Python interpreter is unavailable.');
 if(context.lossyArchive){
   if(!context.verifiedArchive)throw Error('Import the verified upstream release kit to supply the native model decoder.');
   if(sha(await fs.promises.readFile(context.lossyArchive))!==spec.lossy.sha256)throw Error('Lite Lossy source archive identity differs.');
   await execute(python,['-I','-B',path.join(root,'tools/fsr412/fetch_lossy_weights.py'),'--root',root,'--archive',context.lossyArchive],context.signal);
   if(!profiles.includes('int8-lite-lossy'))profiles.push('int8-lite-lossy');
 }
 await execute(python,['-I','-B',path.join(root,'tools/prepare-model.py'),root,installed.directory,...profiles],context.signal);
 Writable.atomicWrite(path.join(root,'runtime.json'),JSON.stringify({version:spec.version,archiveSha256:spec.archiveSha256,preparation:1,profiles,files,helpers}),{root:context.userDataDir});return read(context.userDataDir);
}
async function importRuntime(context={}){const input=fs.realpathSync(context.runtimePath),root=directory(context.userDataDir);if(input===root||input.startsWith(root+path.sep))throw Error('Choose model data outside its managed storage.');
 return withRuntimeMutation({...descriptor,sourcePath:input},async()=>{
  if(fs.statSync(input).isDirectory()){const model=await findModel(input);if(model)return prepareData(context,model);throw Error('Choose the upstream model data directory or release zip.');}
  if(sha(await fs.promises.readFile(input))!==spec.archiveSha256)throw Error('Choose the original FSR 4 v3.2 release zip.');
  const scratch=path.join(root,'.import-'+crypto.randomUUID());Writable.assertOwnDirectory(context.userDataDir,scratch);
  try{await require('../../../runtime/safe-archive').extractArchive(input,scratch,context.signal);const model=await findModel(scratch);if(!model)throw Error('The upstream archive has no usable Lite model data.');return await prepareData({...context,verifiedArchive:true},model);}
  finally{await fs.promises.rm(scratch,{recursive:true,force:true});}
 },{userDataDir:context.userDataDir});}
async function downloadArchive(source,file,signal,onProgress){
 const limit=new AbortController(),bounded=signal?AbortSignal.any([signal,limit.signal]):limit.signal;let oversized=false;
 await Upstream.download(Upstream.listedFile({filename:source.filename,url:source.url}),file,{signal:bounded,onProgress:progress=>{if(progress.downloaded>256*1024*1024||progress.total>256*1024*1024){oversized=true;limit.abort();}onProgress?.(progress);}}).catch(error=>{if(oversized&&!signal?.aborted)throw Error('The FSR model download exceeds its declared size.');throw error;});
 const stat=await fs.promises.stat(file);if(sha(await fs.promises.readFile(file))!==source.sha256)throw Error('The FSR model download differs from its pinned release.');
}
async function install(context={}){
 const current=read(context.userDataDir),needsLossy=context.fsr4Profile==='int8-lite-lossy';if(current&&(!needsLossy||current.profiles.includes('int8-lite-lossy')))return current;
 if(!await downloadApproved(context,{...descriptor,downloadBytes:spec.archiveBytes+(needsLossy?spec.lossy.archiveBytes:0),message:'Download FSR 4.1.2 model data?',detail:needsLossy?'Downloads the fsr4-native-macos release and the Lite Lossy weights (37.1 MB) and prepares the FSR 4.1.2 Lite and Lite Lossy models in the launcher profile.':'Downloads the fsr4-native-macos release (27.6 MB) and prepares the FSR 4.1.2 Lite model in the launcher profile.',requiresDownload:true,kind:'tool',confirmLabel:'Download and Continue'}))return null;
 return runDownloadTask(context.downloads,{...descriptor,kind:'download',dedupeKey:'fsr4-models:'+context.userDataDir},async task=>{
  const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,root);const file=path.join(root,'.release-'+crypto.randomUUID()+'.zip');
  const signal=context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal;
  let lossyArchive;
  try{
    if(needsLossy){lossyArchive=path.join(root,'.lite-lossy-'+crypto.randomUUID()+'.7z');await downloadArchive({filename:'fsr4-lite-lossy.7z',url:spec.lossy.url,bytes:spec.lossy.archiveBytes,sha256:spec.lossy.sha256},lossyArchive,signal);}
    await downloadArchive({filename:'fsr4-mac-v3.2-crossover.zip',url:spec.url,bytes:spec.archiveBytes,sha256:spec.archiveSha256},file,signal,task.onProgress);
    // Import uses the same bounded verification as a local release archive.
    const temporary=path.join(path.dirname(root),'.release-'+crypto.randomUUID()+'.zip');await fs.promises.rename(file,temporary);
    try{return await importRuntime({...context,signal,lossyArchive,runtimePath:temporary});}finally{await fs.promises.rm(temporary,{force:true});}
  }finally{await fs.promises.rm(file,{force:true});if(lossyArchive)await fs.promises.rm(lossyArchive,{force:true});}
 },{onProgress:context.onProgress});
}
function environment(userDataDir,profile){const current=read(userDataDir);if(!current?.profiles.includes(profile))throw Error('Download or import the selected FSR 4.1.2 model data.');return {FSR4_MODEL_ROOT:current.directory,FSR4_MODEL_BUILD_DIR:current.build};}
module.exports={descriptor,directory,read,verify,importRuntime,install,environment};
