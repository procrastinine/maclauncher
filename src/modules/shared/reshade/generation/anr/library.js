// Copyright (c) MacLauncher contributors. MIT license.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
const Source=require('./source.json'),Provider=require('./index'),Releases=require('./catalog'),Writable=require('../../../writable-input');
const {withRuntimeMutation}=require('../../../../../core/coordinated-runtime-managers');
const {downloadApproved}=require('../../../runtime/tool-install'),Upstream=require('../../../runtime/upstream');
const {runDownloadTask}=require('../../../runtime/download-manager');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const file=(...args)=>require('./prepare').file(...args);
const label=version=>'Apex Neural Rendering '+version;
const megabytes=bytes=>(bytes/1024/1024).toFixed(1)+' MB';
async function archiveHash(file,bytes){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||bytes&&stat.size!==bytes)throw Error('The ANR kit has an unsupported size.');const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function directory(userDataDir,version=Source.version){if(!path.isAbsolute(userDataDir||''))throw Error('Launcher data directory unavailable.');if(!Releases.validVersion(version))throw Error('Choose a valid Apex Neural Rendering version.');return path.join(userDataDir,'runtimes',Source.managerId,version);}
// A prepared model directory: its receipt names the release and checkpoint,
// every graph size passed reference parity, and each size's manifest and
// listed files are present with their recorded sizes. The declared release
// keeps its declared checkpoint and kernel pack.
function readDirectory(root,version){try{
 const stat=fs.lstatSync(path.join(root,'runtime.json'));if(!fs.lstatSync(root).isDirectory()||!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)return null;
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'runtime.json'),'utf8'));
 if(receipt.schema!==1||receipt.verified!==true||!Releases.validVersion(receipt.version)||version&&receipt.version!==version)return null;
 const declared=receipt.version===Source.version,checkpoint=declared?Source.checkpoint:receipt.checkpoint,kernelPack=declared?Source.kernelPack:receipt.kernelPack;
 if(receipt.checkpoint!==checkpoint||typeof checkpoint!=='string'||!checkpoint||!/^[a-f0-9]{64}$/.test(kernelPack||''))return null;
 for(const spec of Source.sizes){const r=receipt.sizes?.[spec.id];if(!r||r.width!==spec.width||r.height!==spec.height||!Array.isArray(r.parity)||r.parity.length!==2||r.parity.some(p=>p.verified!==true||!Number.isFinite(p.psnr)||!Number.isFinite(p.bar)||p.psnr<p.bar))return null;const manifest=JSON.parse(file(root,spec.id+'/manifest.json',r.manifestSha256));
  if(manifest.schema!=='fsr4_anr_runtime_v1'||manifest.checkpoint_id!==checkpoint||manifest.width!==spec.width||manifest.height!==spec.height||manifest.source_kernel_pack_sha256!==kernelPack||!manifest.files||!Object.keys(manifest.files).length||Object.keys(manifest.files).length>1000)return null;
  for(const [name,record]of Object.entries(manifest.files)){if(name.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||path.isAbsolute(name))return null;const stat=fs.lstatSync(path.join(root,spec.id,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.bytes)return null;}}
 return {version:receipt.version,versionLabel:label(receipt.version),runtimePath:root,sourcePath:root,installDir:root,directory:root,ready:true,removalLabel:'Remove',
  sourceUrl:Releases.source(null,receipt.version)?.sourceUrl||Releases.sourceUrl,checkpoint,capabilities:['interpolate'],sizes:Source.sizes.map(({id,width,height})=>({id,width,height}))};
}catch{return null;}}
function read(userDataDir,version=Source.version){try{const root=directory(userDataDir,version);Writable.assertOwnDirectory(userDataDir,root,{create:false});return readDirectory(root,version);}catch{return null;}}
function listInstalled(userDataDir){try{return fs.readdirSync(path.dirname(directory(userDataDir))).filter(Releases.validVersion).map(version=>read(userDataDir,version)).filter(Boolean).sort(Releases.newest);}catch{return [];}}
// Registered in place from Runtimes: a prepared model directory, checked like a download.
function inspectCustom(runtimePath){const current=readDirectory(runtimePath);if(!current)throw Error('Choose a prepared Apex Neural Rendering model directory whose sizes passed their reference checks.');return current;}
async function use(current,context={}){context.signal?.throwIfAborted();await context.useRuntime?.({managerId:Source.managerId,sectionId:'default',version:current.custom?current.runtimePath:current.version,sourcePath:current.sourcePath||current.runtimePath});return current;}
async function verify({kit,output,size,verifyTool,signal,spec:kitSpec=require('./prepare').declaredKit()}){
 // The parity floor of a prepared graph against the kit's own reference frames.
 const bars={ '1080p':[79.3012,80.9135], '1440p':[79.2153,80.7649], '2160p':[79.9559,81.3325] },results=[];
 for(const [index,phase]of [.5,.75].entries()){
  const input=path.join(kit,'inputs/timing-'+size),reference=path.join(kit,'references/timing-'+size+'-t'+phase+'.bin');
  // Local imports of the declared kit carry exactly its declared reference inputs.
  for(const name of ['color0.bin','color1.bin','depth0.bin','depth1.bin','motion0.bin','motion10.bin','frame0.bin','frame.bin']){const relative='inputs/timing-'+size+'/'+name;file(kit,relative,kitSpec.verificationFiles?.[relative]);}
  const relative='references/timing-'+size+'-t'+phase+'.bin';file(kit,relative,kitSpec.verificationFiles?.[relative]);
  const {stdout}=await execFile(verifyTool,[output,input,reference,String(phase),String(bars[size][index])],{signal,timeout:30000,maxBuffer:65536});const result=JSON.parse(stdout);
  const spec=Source.sizes.find(s=>s.id===size);if(result.verified!==true||result.width!==spec.width||result.height!==spec.height||result.phase!==phase||result.bar!==bars[size][index]||!Number.isFinite(result.psnr)||result.psnr<result.bar)throw Error('ANR '+kitSpec.version+' failed its reference verification at '+size+'.');results.push(result);
 }return results;
}
async function prepareKit(context,kit,root,provider,kitSpec,archiveSha256){
 const receipt={schema:1,version:kitSpec.version,checkpoint:kitSpec.checkpoint,kernelPack:kitSpec.kernelPack,converter:kitSpec.converter,...(archiveSha256?{archiveSha256}:{}),verified:true,sizes:{}};
 for(const spec of Source.sizes){context.signal?.throwIfAborted();const output=path.join(root,spec.id);await require("./prepare").prepare({kit,output,size:spec.id,converterTool:provider.converterTool,signal:context.signal,spec:kitSpec});
  const parity=await verify({kit,output,size:spec.id,verifyTool:provider.verifyTool,signal:context.signal,spec:kitSpec});receipt.sizes[spec.id]={width:spec.width,height:spec.height,parity,manifestSha256:digest(fs.readFileSync(path.join(output,'manifest.json')))};
 }
 fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify(receipt,null,2)+'\n');
}
// The kit folder of an extracted archive or a selected directory.
function kitRoot(directory,depth=0){
 const usable=root=>fs.existsSync(path.join(root,'programs'))&&fs.existsSync(path.join(root,'kernels-metal'));
 if(usable(directory))return directory;if(depth>=2)return null;
 const found=fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name!=='__MACOSX').map(entry=>kitRoot(path.join(directory,entry.name),depth+1)).filter(Boolean);
 return found.length===1?found[0]:null;
}
// A selected kit directory's release: the declared kit's identity, or the
// version in the folder name the release archive extracts to.
function kitVersion(kit){
 try{if(digest(file(kit,'kernels-metal/pack.nrx'))===Source.kernelPack)return Source.version;}catch{}
 const version=/^anr-fg-(.+)-kit-macos$/i.exec(path.basename(kit))?.[1];
 if(!version)throw Error('Choose the ANR macOS kit folder as extracted from its release archive.');
 return /^FG-/i.test(version)?version:'FG-'+version;
}
async function acquire(context,local,source){
 const provider=Provider.resolve(context.root||require('../..').runtimeRoot(context.app),context);if(!provider)throw Error('A compatible ANR graphics provider is required.');
 let version=source?.version;
 if(version&&read(context.userDataDir,version))return use(read(context.userDataDir,version),context);
 if(!local&&!await downloadApproved(context,{managerId:Source.managerId,version,label:'Apex Neural Rendering',message:'Download Apex Neural Rendering frame generation?',detail:'Downloads the macOS kit '+version+' from Apex ('+megabytes(source.archiveBytes)+'), prepares the models in the launcher profile and checks them against the kit\'s reference frames. The kit is removed afterwards; the prepared models use about 8 MB.',requiresDownload:true,downloadBytes:source.archiveBytes,kind:'tool',sourceUrl:source.sourceUrl,confirmLabel:'Download and Continue'}))return null;
 const parent=path.dirname(directory(context.userDataDir));Writable.assertOwnDirectory(context.userDataDir,parent);
 const temporary=fs.mkdtempSync(path.join(parent,'.anr-install-')),output=path.join(temporary,'prepared');fs.mkdirSync(output);
 try{
  let kit=local,archiveSha256=null;
  if(!local||!fs.statSync(local).isDirectory()){
   const archive=path.join(temporary,'kit.tar.gz');
   if(local){
    // A local archive is the kit of the listed release with the same SHA-256.
    archiveSha256=await archiveHash(local);source=Releases.sources(context.userDataDir).find(row=>row.archiveSha256===archiveSha256)||(archiveSha256===Source.sha256?Releases.declared:null);
    if(!source||version&&source.version!==version)throw Error('Unsupported ANR kit identity. Choose a macOS kit archive of a release listed in Runtimes.');
    version=source.version;fs.copyFileSync(local,archive);
   }else{
    const limit=new AbortController(),signal=context.signal?AbortSignal.any([context.signal,limit.signal]):limit.signal;
    await Upstream.download(Upstream.listedFile({filename:source.filename,url:source.url,bytes:source.archiveBytes,sha256:source.archiveSha256}),archive,{signal,onProgress:p=>{if(p.downloaded>source.archiveBytes||p.total>source.archiveBytes)limit.abort();context.onProgress?.(p);}});
    archiveSha256=await archiveHash(archive,source.archiveBytes);
   }
   if(archiveSha256!==source.archiveSha256)throw Error('The ANR kit does not match the selected Apex release.');
   const extracted=path.join(temporary,'kit');await require('../../../runtime/release-files').extractArchive(archive,extracted,context.signal);
   kit=kitRoot(extracted);if(!kit)throw Error('The ANR '+version+' archive contains no complete macOS kit.');
  }else{kit=kitRoot(local);if(!kit)throw Error('Choose an ANR macOS kit folder.');const found=kitVersion(kit);if(version&&found!==version)throw Error('The selected kit is ANR '+found+', not '+version+'.');version=found;}
  const kitSpec=require('./prepare').describeKit(kit,version);
  return await withRuntimeMutation({managerId:Source.managerId,version},async()=>{
   if(read(context.userDataDir,version))return use(read(context.userDataDir,version),context);
   const root=directory(context.userDataDir,version);
   await prepareKit(context,kit,output,provider,kitSpec,archiveSha256);
   // The incomplete managed directory contains no usable receipt. Preserve it
   // until a complete replacement is ready, then retire it after the rename.
   const old=path.join(temporary,'old');if(fs.existsSync(root))fs.renameSync(root,old);try{fs.renameSync(output,root);}catch(error){if(fs.existsSync(old))fs.renameSync(old,root);throw error;}
   const current=read(context.userDataDir,version);if(!current)throw Error('The prepared ANR '+version+' models failed their check.');
   return use(current,context);
  },{userDataDir:context.userDataDir});
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
// Installs the selected listed release (the declared kit without a source).
async function install(context={}){
 const source=context.sourceSpec||Releases.declared;if(!Releases.validEntry(source))throw Error('Refresh Apex Neural Rendering releases or choose an installed version.');
 const current=read(context.userDataDir,source.version);if(current)return use(current,context);
 return runDownloadTask(context.downloads,{managerId:Source.managerId,sectionId:'default',version:source.version,label:'Apex Neural Rendering',kind:'download',dedupeKey:'anr:'+context.userDataDir+':'+source.version},async task=>acquire({...context,signal:context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal,onProgress:task.onProgress},null,source));
}
// A local kit archive or extracted kit folder, prepared into its release's folder.
async function importRuntime(context={}){if(!path.isAbsolute(context.runtimePath||''))throw Error('Choose an ANR macOS kit archive or directory.');const version=context.version&&context.version!=='auto'?context.version:null;return acquire(context,context.runtimePath,version?{version}:null);}
async function remove(context={}){const version=context.version||Source.version,root=directory(context.userDataDir,version);Writable.assertOwnDirectory(context.userDataDir,root,{create:false});return withRuntimeMutation({managerId:Source.managerId,version,sourcePath:root},()=>fs.promises.rm(root,{recursive:true,force:true}),{userDataDir:context.userDataDir});}
module.exports={Source,Releases,directory,read,readDirectory,listInstalled,inspectCustom,use,install,importRuntime,remove,verify,kitRoot,kitVersion};
