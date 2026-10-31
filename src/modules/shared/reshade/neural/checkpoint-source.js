// Copyright (c) MacLauncher contributors. MIT license.
// Extract one declared checkpoint from an explicitly requested source archive.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const Upstream=require('../../runtime/upstream'),Zip=require('../../runtime/zip');
const {withRuntimeMutation}=require('../../../../core/coordinated-runtime-managers');
async function sha256(file,signal){
 const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file,{flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,signal}))hash.update(bytes);return hash.digest('hex');
}
// A model archive published as a GitHub release asset can be replaced behind
// its URL. The release list supplies the publisher's current size and digest;
// an asset that is no longer listed downloads from its URL with its SHA-256
// recorded. The extracted model keeps its own identity checksum.
async function releaseFile(url,{signal}={}){
 const name=path.posix.basename(new URL(url).pathname),fallback=Upstream.listedFile({filename:decodeURIComponent(name),url});
 const match=/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/.exec(url||'');if(!match)return fallback;
 const [tag,asset]=[decodeURIComponent(match[2]),decodeURIComponent(match[3])];
 const source=Upstream.github({repository:match[1],prerelease:true,allArchitectures:true,
  recognize:release=>release.tag_name===tag?{version:tag,assets:(release.assets||[]).filter(item=>item?.name===asset)}:null});
 try{return (await source.discover({signal})).find(row=>row.files[0])?.files[0]||fallback;}
 catch(error){signal?.throwIfAborted();return fallback;}
}
async function downloadEntry(row,target,{signal,onProgress,archiveCacheDirectory,userDataDir}={}){
 const declared=row?.archive;
 if(row.transport!=='zip-entry'||!declared||typeof declared.entry!=='string'||declared.entry.startsWith('/')||declared.entry.split('/').some(p=>!p||p==='..'||p==='.')||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>1<<30)throw Error('The checkpoint archive declaration is invalid.');
 const listed=await releaseFile(row.url,{signal}),published=listed.digest?.algorithm==='sha256'?listed.digest.value:null;
 // Variants that share an archive reuse one download, named by its SHA-256.
 const cached=async key=>{if(!archiveCacheDirectory||!/^[a-f0-9]{64}$/.test(key||''))return null;const file=path.join(archiveCacheDirectory,key+'.zip');
  const stat=await fs.promises.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('The model source cache is not a regular archive.');
  return (listed.bytes===undefined||stat.size===listed.bytes)&&await sha256(file,signal)===key?file:null;};
 const temporary=(archiveCacheDirectory?path.join(archiveCacheDirectory,'download'):target+'.archive')+'-'+crypto.randomUUID();
 let source;
 try{
  const acquire=async()=>{
   signal?.throwIfAborted();source=await cached(published||declared.sha256);if(source){onProgress?.({downloaded:listed.bytes||row.bytes,total:listed.bytes||row.bytes});return;}
   const fetched=await Upstream.download(listed,temporary,{signal,onProgress});
   if(!archiveCacheDirectory){source=temporary;return;}
   source=path.join(archiveCacheDirectory,fetched.sha256+'.zip');await fs.promises.chmod(temporary,0o444);await fs.promises.rename(temporary,source);
  };
  if(archiveCacheDirectory){await fs.promises.mkdir(archiveCacheDirectory,{recursive:true});await withRuntimeMutation({managerId:'graphics-neural-models',sectionId:'source-archives',version:published||declared.sha256||'archive',sourcePath:archiveCacheDirectory},acquire,{userDataDir,signal});}else await acquire();
  const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let rows;
  try{const info=Zip.findZipEocd(fd);if(!info||info.cdSize>4<<20||info.entries>32768)throw Error('The checkpoint archive directory is invalid.');rows=Zip.readCentralDirectory(fd,info,{metadata:true});}finally{fs.closeSync(fd);}
  const selected=rows.filter(r=>r.name===declared.entry),entry=selected[0],type=entry?.externalAttributes>>>16&0o170000;
  if(selected.length!==1||![0,0o100000].includes(type)||entry.flags&1||![0,8].includes(entry.compressionMethod)||entry.uncompressedSize!==row.bytes)throw Error('The checkpoint archive has no matching regular model entry.');
  await Zip.extractZipEntry(source,entry,target,{maxOutputBytes:row.bytes,signal});return target;
 }finally{await fs.promises.rm(temporary,{force:true});}
}
// A large model file read in parallel ranges of its publisher's file; the
// assembled file must match the model's identity checksum.
async function downloadFile(row,target,{signal,onProgress}={}){
 if(row?.transport!=='bounded-ranges'||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>(1<<30)||!/^[a-f0-9]{64}$/.test(row.sha256||''))throw Error('The checkpoint file declaration is invalid.');
 const listed=Upstream.listedFile({filename:row.file||path.basename(target),url:row.url});
 const temporary=target+'.ranges-'+crypto.randomUUID(),handle=await fs.promises.open(temporary,'wx');
 const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal,block=4<<20;let next=0,completed=0,workers=[];
 try{
  workers=Array.from({length:Math.min(4,Math.ceil(row.bytes/block))},async()=>{while(next<row.bytes){
   const begin=next,length=Math.min(block,row.bytes-begin);next=begin+length;let part;
   for(let attempt=0;attempt<3;attempt++){
    combined.throwIfAborted();try{part=await Upstream.range(listed,begin,length,{signal:combined});break;}catch(error){combined.throwIfAborted();if(attempt===2)throw error;}
   }
   if(part.total!==row.bytes)throw Error('The checkpoint source is not the model file of the declared size.');
   combined.throwIfAborted();const written=await handle.write(part.bytes,0,part.bytes.length,begin);if(written.bytesWritten!==part.bytes.length)throw Error('The checkpoint storage write is incomplete.');completed+=written.bytesWritten;onProgress?.({downloaded:completed,total:row.bytes});
  }});await Promise.all(workers);
  combined.throwIfAborted();
  if(completed!==row.bytes||await sha256(temporary,combined)!==row.sha256)throw Error('The downloaded checkpoint is not the selected model: its checksum differs.');
  await handle.close();await fs.promises.link(temporary,target);return target;
 }catch(error){controller.abort();await Promise.allSettled(workers);throw error;}
 finally{controller.abort();await handle.close().catch(()=>{});await fs.promises.rm(temporary,{force:true});}
}
module.exports={releaseFile,downloadEntry,downloadFile};
