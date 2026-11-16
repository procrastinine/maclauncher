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
 for(const row of spec.files){const stat=fs.lstatSync(path.join(root,'build/fsr412_model',row.path));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.bytes)return null;}
 return {...descriptor,directory:root,build:path.join(root,'build'),profiles:record.profiles,ready:true};
}catch{return null;}}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function verify(input){for(const row of spec.files){const file=path.join(input,row.path),stat=await fs.promises.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.bytes||sha(await fs.promises.readFile(file))!==row.sha256)throw Error('FSR 4.1.2 model identity differs: '+row.path);}return input;}
async function execute(executable,args,signal){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{...(signal?{signal}:{}),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'},stdio:['ignore','pipe','pipe']});let error='';child.stdout.resume();child.stderr.on('data',b=>{error=(error+b).slice(-8192)});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('FSR 4.1.2 preparation failed: '+error)));});}
async function prepareData(context,input){
 const installed=require('./index').inspect(context.root);if(!installed||!installed.profiles.includes('int8-lite'))throw Error('Install the FSR 4 v3.2 provider first.');
 await verify(input);
 const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,root);
 // The runtime stays in this final directory: prepared provenance paths remain
 // valid after publication. A receipt is written only once all variants exist.
 // Keep a previously usable receipt while preparing additional profiles.
 const model=path.join(root,'build/fsr412_model');await fs.promises.mkdir(model,{recursive:true});
 for(const row of spec.files){const to=path.join(model,row.path);await fs.promises.mkdir(path.dirname(to),{recursive:true});if(path.resolve(input,row.path)!==to)await fs.promises.copyFile(path.join(input,row.path),to);}
 await fs.promises.cp(path.join(installed.directory,'preparation'),path.join(root,'tools'),{recursive:true});
 await fs.promises.copyFile(path.join(installed.directory,'fsr411_msl.py'),path.join(root,'tools/fsr411_msl.py'));
 await fs.promises.cp(path.join(installed.directory,'src'),path.join(root,'src'),{recursive:true});
 const profiles=['int8-lite'];
 const kitTools=path.resolve(input,'../../tools');
 for(const row of spec.helperFiles){
   const source=path.join(kitTools,row.path);
   try{const stat=fs.lstatSync(source);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===row.bytes&&sha(await fs.promises.readFile(source))===row.sha256){
     const destination=path.join(root,'tools',row.path);await fs.promises.mkdir(path.dirname(destination),{recursive:true});await fs.promises.copyFile(source,destination);await fs.promises.chmod(destination,0o755);
   }}catch(error){context.signal?.throwIfAborted();}
 }
 // A local upstream preparation may also carry the separately verified GPL
 // initializer and its conditional/subpixel bias receipt.
 const lossy=path.resolve(input,'../fsr412_lossy');
 try{if(sha(await fs.promises.readFile(path.join(lossy,'initializers-lite-lossy.bin')))==='c77c2d1a4d119ed76d94b8c23335490cc38280db3346c72396a1e1acb0523cfc'){
   await fs.promises.mkdir(path.join(root,'build/fsr412_lossy'),{recursive:true});
   for(const file of ['initializers-lite-lossy.bin','import.json'])await fs.promises.copyFile(path.join(lossy,file),path.join(root,'build/fsr412_lossy',file));profiles.push('int8-lite-lossy');
 }}catch(error){context.signal?.throwIfAborted();}
 const Python=require('../../../runtime/python'),python=Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());if(!python)throw Error('The included Python interpreter is unavailable.');
 if(context.lossyArchive){
   for(const row of spec.helperFiles){const file=path.join(root,'tools',row.path);if(sha(await fs.promises.readFile(file))!==row.sha256)throw Error('Import the original v3.2 release zip to supply the verified model decoder.');}
   if(sha(await fs.promises.readFile(context.lossyArchive))!==spec.lossy.sha256)throw Error('Lite Lossy source archive identity differs.');
   await execute(python,['-B',path.join(root,'tools/fsr412/fetch_lossy_weights.py'),'--root',root,'--archive',context.lossyArchive],context.signal);
   if(!profiles.includes('int8-lite-lossy'))profiles.push('int8-lite-lossy');
 }
 await execute(python,['-B',path.join(root,'tools/prepare-model.py'),root,installed.directory,...profiles],context.signal);
 Writable.atomicWrite(path.join(root,'runtime.json'),JSON.stringify({version:spec.version,archiveSha256:spec.archiveSha256,preparation:1,profiles}),{root:context.userDataDir});return read(context.userDataDir);
}
async function importRuntime(context={}){const input=fs.realpathSync(context.runtimePath),root=directory(context.userDataDir);if(input===root||input.startsWith(root+path.sep))throw Error('Choose model data outside its managed storage.');
 return withRuntimeMutation({...descriptor,sourcePath:input},async()=>{
  if(fs.statSync(input).isDirectory()){const candidates=[input,path.join(input,'build/fsr412_model')];for(const candidate of candidates)if(fs.existsSync(path.join(candidate,'initializers-lite.bin')))return prepareData(context,candidate);throw Error('Choose the upstream fsr412_model directory or release zip.');}
  if(fs.statSync(input).size!==spec.archiveBytes||sha(await fs.promises.readFile(input))!==spec.archiveSha256)throw Error('Choose the original FSR 4 v3.2 release zip.');
  const scratch=path.join(root,'.import-'+crypto.randomUUID());Writable.assertOwnDirectory(context.userDataDir,scratch);
  try{await require('../../../runtime/safe-archive').extractArchive(input,scratch,context.signal);return await prepareData(context,path.join(scratch,'fsr4-mac-v3.2-crossover/build/fsr412_model'));}
  finally{await fs.promises.rm(scratch,{recursive:true,force:true});}
 },{userDataDir:context.userDataDir});}
async function downloadPinned(source,file,signal,onProgress){
 const limit=new AbortController(),bounded=signal?AbortSignal.any([signal,limit.signal]):limit.signal;let oversized=false;
 await Upstream.download(Upstream.listedFile({filename:source.filename,url:source.url}),file,{signal:bounded,onProgress:progress=>{if(progress.downloaded>source.bytes||progress.total>source.bytes){oversized=true;limit.abort();}onProgress?.(progress);}}).catch(error=>{if(oversized&&!signal?.aborted)throw Error('The FSR model download exceeds its declared size.');throw error;});
 const stat=await fs.promises.stat(file);if(stat.size!==source.bytes||sha(await fs.promises.readFile(file))!==source.sha256)throw Error('The FSR model download differs from its pinned release.');
}
async function install(context={}){
 const current=read(context.userDataDir),needsLossy=context.fsr4Profile==='int8-lite-lossy';if(current&&(!needsLossy||current.profiles.includes('int8-lite-lossy')))return current;
 if(!await downloadApproved(context,{...descriptor,downloadBytes:spec.archiveBytes+(needsLossy?spec.lossy.archiveBytes:0),message:'Download FSR 4.1.2 model data?',detail:needsLossy?'Downloads the fsr4-native-macos release and the Lite Lossy weights (37.1 MB) and prepares the FSR 4.1.2 Lite and Lite Lossy models in the launcher profile.':'Downloads the fsr4-native-macos release (27.6 MB) and prepares the FSR 4.1.2 Lite model in the launcher profile.',requiresDownload:true,kind:'tool',confirmLabel:'Download and Continue'}))return null;
 return runDownloadTask(context.downloads,{...descriptor,kind:'download',dedupeKey:'fsr4-models:'+context.userDataDir},async task=>{
  const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,root);const file=path.join(root,'.release-'+crypto.randomUUID()+'.zip');
  const signal=context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal;
  let lossyArchive;
  try{
    if(needsLossy){lossyArchive=path.join(root,'.lite-lossy-'+crypto.randomUUID()+'.7z');await downloadPinned({filename:'fsr4-lite-lossy.7z',url:spec.lossy.url,bytes:spec.lossy.archiveBytes,sha256:spec.lossy.sha256},lossyArchive,signal);}
    await downloadPinned({filename:'fsr4-mac-v3.2-crossover.zip',url:spec.url,bytes:spec.archiveBytes,sha256:spec.archiveSha256},file,signal,task.onProgress);
    // Import uses the same bounded verification as a local release archive.
    const temporary=path.join(path.dirname(root),'.release-'+crypto.randomUUID()+'.zip');await fs.promises.rename(file,temporary);
    try{return await importRuntime({...context,signal,lossyArchive,runtimePath:temporary});}finally{await fs.promises.rm(temporary,{force:true});}
  }finally{await fs.promises.rm(file,{force:true});if(lossyArchive)await fs.promises.rm(lossyArchive,{force:true});}
 },{onProgress:context.onProgress});
}
function environment(userDataDir,profile){const current=read(userDataDir);if(!current?.profiles.includes(profile))throw Error('Download or import the selected FSR 4.1.2 model data.');return {FSR4_MODEL_ROOT:current.directory,FSR4_MODEL_BUILD_DIR:current.build};}
module.exports={descriptor,directory,read,verify,importRuntime,install,environment};
