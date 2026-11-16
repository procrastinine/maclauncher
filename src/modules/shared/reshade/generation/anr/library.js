// Copyright (c) MacLauncher contributors. MIT license.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
const Source=require('./source.json'),Provider=require('./index'),Writable=require('../../../writable-input');
const {withRuntimeMutation}=require('../../../../../core/coordinated-runtime-managers');
const {downloadApproved}=require('../../../runtime/tool-install'),Upstream=require('../../../runtime/upstream');
const {runDownloadTask}=require('../../../runtime/download-manager');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const file=(...args)=>require('./prepare').file(...args);
async function archiveHash(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==Source.bytes)throw Error('The ANR kit has an unsupported size.');const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
function assertVersion(context){if(context.version&&context.version!=='auto'&&context.version!==Source.version)throw Error('Choose the supported Apex Neural Rendering kit version.');}
function directory(userDataDir){if(!path.isAbsolute(userDataDir||''))throw Error('Launcher data directory unavailable.');return path.join(userDataDir,'runtimes',Source.managerId,Source.version);}
function read(userDataDir){try{
 const root=directory(userDataDir);Writable.assertOwnDirectory(userDataDir,root,{create:false});const stat=fs.lstatSync(path.join(root,'runtime.json'));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)return null;
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'runtime.json'),'utf8'));if(receipt.schema!==1||receipt.version!==Source.version||receipt.checkpoint!==Source.checkpoint||receipt.verified!==true)return null;
 for(const spec of Source.sizes){const r=receipt.sizes?.[spec.id];if(!r||r.width!==spec.width||r.height!==spec.height||!Array.isArray(r.parity)||r.parity.length!==2||r.parity.some(p=>p.verified!==true||!Number.isFinite(p.psnr)||!Number.isFinite(p.bar)||p.psnr<p.bar))return null;const manifest=JSON.parse(file(root,spec.id+'/manifest.json',r.manifestSha256));
  if(manifest.schema!=='fsr4_anr_runtime_v1'||manifest.checkpoint_id!==Source.checkpoint||manifest.width!==spec.width||manifest.height!==spec.height||manifest.source_kernel_pack_sha256!==Source.kernelPack||!manifest.files||!Object.keys(manifest.files).length||Object.keys(manifest.files).length>1000)return null;
  for(const [name,record]of Object.entries(manifest.files)){if(name.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||path.isAbsolute(name))return null;const stat=fs.lstatSync(path.join(root,spec.id,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.bytes)return null;}}
 return {version:Source.version,versionLabel:'Apex Neural Rendering '+Source.version,runtimePath:root,sourcePath:root,installDir:root,ready:true,sourceUrl:Source.sourceUrl,capabilities:['interpolate'],sizes:Source.sizes.map(({id,width,height})=>({id,width,height}))};
}catch{return null;}}
async function resolve(userDataDir,context={}){assertVersion(context);const current=read(userDataDir);if(!current)throw Object.assign(Error('Install or import the Apex Neural Rendering macOS kit in Graphics.'),{code:'GRAPHICS_ANR_RUNTIME_MISSING',managerId:Source.managerId});context.signal?.throwIfAborted();await context.useRuntime?.({managerId:Source.managerId,sectionId:'default',version:Source.version,sourcePath:current.sourcePath});return current;}
async function verify({kit,output,size,verifyTool,signal}){
 const bars={ '1080p':[79.3012,80.9135], '1440p':[79.2153,80.7649], '2160p':[79.9559,81.3325] },results=[];
 for(const [index,phase]of [.5,.75].entries()){
  const input=path.join(kit,'inputs/timing-'+size),reference=path.join(kit,'references/timing-'+size+'-t'+phase+'.bin');
  // Local imports carry exactly the same reference inputs as the pinned kit.
  for(const name of ['color0.bin','color1.bin','depth0.bin','depth1.bin','motion0.bin','motion10.bin','frame0.bin','frame.bin']){const relative='inputs/timing-'+size+'/'+name;file(kit,relative,Source.verificationFiles[relative]);}
  const relative='references/timing-'+size+'-t'+phase+'.bin';file(kit,relative,Source.verificationFiles[relative]);
  const {stdout}=await execFile(verifyTool,[output,input,reference,String(phase),String(bars[size][index])],{signal,timeout:30000,maxBuffer:65536});const result=JSON.parse(stdout);
  const spec=Source.sizes.find(s=>s.id===size);if(result.verified!==true||result.width!==spec.width||result.height!==spec.height||result.phase!==phase||result.bar!==bars[size][index]||!Number.isFinite(result.psnr)||result.psnr<result.bar)throw Error('ANR reference verification failed.');results.push(result);
 }return results;
}
async function prepareKit(context,kit,root,provider){
 const receipt={schema:1,version:Source.version,checkpoint:Source.checkpoint,verified:true,sizes:{}};
 for(const spec of Source.sizes){context.signal?.throwIfAborted();const output=path.join(root,spec.id);await require("./prepare").prepare({kit,output,size:spec.id,converterTool:provider.converterTool,signal:context.signal});
  const parity=await verify({kit,output,size:spec.id,verifyTool:provider.verifyTool,signal:context.signal});receipt.sizes[spec.id]={width:spec.width,height:spec.height,parity,manifestSha256:digest(fs.readFileSync(path.join(output,'manifest.json')))};
 }
 fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify(receipt,null,2)+'\n');
}
async function acquire(context,local){
 const current=read(context.userDataDir);if(current)return resolve(context.userDataDir,context);
 const provider=Provider.resolve(context.root||require('../..').runtimeRoot(context.app),context);if(!provider)throw Error('A compatible ANR graphics provider is required.');
 if(!local&&!await downloadApproved(context,{managerId:Source.managerId,version:Source.version,label:'Apex Neural Rendering',message:'Download Apex Neural Rendering frame generation?',detail:'Downloads the macOS kit from Apex (445.2 MB), prepares the models in the launcher profile and checks them against the kit\'s reference frames. The kit is removed afterwards; the prepared models use about 8 MB.',requiresDownload:true,downloadBytes:Source.bytes,kind:'tool',sourceUrl:Source.sourceUrl,confirmLabel:'Download and Continue'}))return null;
 return withRuntimeMutation({managerId:Source.managerId,version:Source.version},async()=>{
  if(read(context.userDataDir))return resolve(context.userDataDir,context);
  const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,path.dirname(root));
  const temporary=fs.mkdtempSync(path.join(path.dirname(root),'.anr-install-')),output=path.join(temporary,'prepared');fs.mkdirSync(output);
  try{
   let kit=local;
   if(!local||!fs.statSync(local).isDirectory()){
    const archive=path.join(temporary,Source.asset);
    if(local){if(await archiveHash(local)!==Source.sha256)throw Error('Unsupported ANR kit identity.');fs.copyFileSync(local,archive);}else{
     const limit=new AbortController(),signal=context.signal?AbortSignal.any([context.signal,limit.signal]):limit.signal;
     await Upstream.download(Upstream.listedFile({filename:Source.asset,url:Source.url}),archive,{signal,onProgress:p=>{if(p.downloaded>Source.bytes||p.total>Source.bytes)limit.abort();context.onProgress?.(p);}});
    }
    if(await archiveHash(archive)!==Source.sha256)throw Error('The ANR kit does not match the supported Apex release.');
    const extracted=path.join(temporary,'kit');await require('../../../runtime/release-files').extractArchive(archive,extracted,context.signal);
    kit=path.join(extracted,'anr-fg-V.B15-kit-macos');
   }
   await prepareKit(context,kit,output,provider);
   // The incomplete managed directory contains no usable receipt. Preserve it
   // until a complete replacement is ready, then retire it after the rename.
   const old=path.join(temporary,'old');if(fs.existsSync(root))fs.renameSync(root,old);try{fs.renameSync(output,root);}catch(error){if(fs.existsSync(old))fs.renameSync(old,root);throw error;}
   return resolve(context.userDataDir,context);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 },{userDataDir:context.userDataDir});
}
async function install(context={}){assertVersion(context);if(read(context.userDataDir))return resolve(context.userDataDir,context);return runDownloadTask(context.downloads,{managerId:Source.managerId,sectionId:'default',version:Source.version,label:'Apex Neural Rendering',kind:'download',dedupeKey:'anr:'+context.userDataDir},async task=>acquire({...context,signal:context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal,onProgress:task.onProgress},null));}
async function importRuntime(context={}){assertVersion(context);if(!path.isAbsolute(context.runtimePath||''))throw Error('Choose an ANR macOS kit archive or directory.');return acquire(context,context.runtimePath);}
async function remove(context={}){assertVersion(context);const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,root,{create:false});return withRuntimeMutation({managerId:Source.managerId,version:Source.version},()=>fs.promises.rm(root,{recursive:true,force:true}),{userDataDir:context.userDataDir});}
module.exports={Source,directory,read,resolve,install,importRuntime,remove,verify,listInstalled:userDataDir=>{const value=read(userDataDir);return value?[value]:[];}};
