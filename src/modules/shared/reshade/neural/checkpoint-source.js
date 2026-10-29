// Copyright (c) MacLauncher contributors. MIT license.
// Extract one declared checkpoint from an explicitly requested source archive.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const Downloads=require('../../runtime/download-utils'),Zip=require('../../runtime/zip');
const {withRuntimeMutation}=require('../../../../core/coordinated-runtime-managers');
async function archiveMatches(file,archive,signal){
 const stat=await fs.promises.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return false;
 if(!stat.isFile()||stat.isSymbolicLink())throw Error('The model source cache is not a regular archive.');if(stat.size!==archive.bytes)return false;
 const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file,{flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,signal}))hash.update(bytes);return hash.digest('hex')===archive.sha256;
}
async function downloadEntry(row,target,{signal,onProgress,archiveCacheDirectory,userDataDir}={},dependencies={}){
 const archive=row?.archive;
 if(row.transport!=='zip-entry'||!archive||typeof archive.entry!=='string'||archive.entry.startsWith('/')||archive.entry.split('/').some(p=>!p||p==='..'||p==='.')||!Number.isSafeInteger(archive.bytes)||archive.bytes<1||archive.bytes>1<<30||!/^[a-f0-9]{64}$/.test(archive.sha256||'')||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>1<<30)throw Error('The checkpoint archive declaration is invalid.');
 const cache=archiveCacheDirectory?path.join(archiveCacheDirectory,archive.sha256+'.zip'):null;
 const temporary=(cache||target+'.archive')+'-'+crypto.randomUUID(),controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let oversized=false;
 try{
  const acquire=async()=>{
   combined.throwIfAborted();if(cache&&await archiveMatches(cache,archive,combined)){onProgress?.({downloaded:archive.bytes,total:archive.bytes});return;}
   await(dependencies.downloadToFile||Downloads.downloadToFile)(row.url,temporary,{signal:combined,onProgress:progress=>{if(progress.downloaded>archive.bytes||progress.total>archive.bytes){oversized=true;controller.abort();}onProgress?.(progress);}});
   combined.throwIfAborted();if(!await archiveMatches(temporary,archive,combined))throw Error('The checkpoint archive does not match its declared size and checksum.');
   if(cache){await fs.promises.chmod(temporary,0o444);await fs.promises.rename(temporary,cache);}
  };
  if(cache){await fs.promises.mkdir(archiveCacheDirectory,{recursive:true});await withRuntimeMutation({managerId:'graphics-neural-models',sectionId:'source-archives',version:archive.sha256,sourcePath:cache},acquire,{userDataDir,signal:combined});}else await acquire();
  const source=cache||temporary,fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let rows;
  try{const info=Zip.findZipEocd(fd);if(!info||info.cdSize>4<<20||info.entries>32768)throw Error('The checkpoint archive directory is invalid.');rows=Zip.readCentralDirectory(fd,info,{metadata:true});}finally{fs.closeSync(fd);}
  const selected=rows.filter(r=>r.name===archive.entry),entry=selected[0],type=entry?.externalAttributes>>>16&0o170000;
  if(selected.length!==1||![0,0o100000].includes(type)||entry.flags&1||![0,8].includes(entry.compressionMethod)||entry.uncompressedSize!==row.bytes)throw Error('The checkpoint archive has no matching regular model entry.');
  await Zip.extractZipEntry(source,entry,target,{maxOutputBytes:row.bytes,signal:combined});return target;
 }catch(error){if(oversized&&!signal?.aborted)throw Error('The checkpoint archive exceeds its declared size.');throw error;}
 finally{await fs.promises.rm(temporary,{force:true});}
}
async function downloadFile(row,target,{signal,onProgress}={},dependencies={}){
 if(row?.transport!=='bounded-ranges'||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>(1<<30)||!/^[a-f0-9]{64}$/.test(row.sha256||''))throw Error('The checkpoint file declaration is invalid.');
 const temporary=target+'.ranges-'+crypto.randomUUID(),handle=await fs.promises.open(temporary,'wx'),fetchBuffer=dependencies.fetchUrlBuffer||Downloads.fetchUrlBuffer;
 const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal,block=4<<20;let next=0,completed=0,workers=[];
 try{
  workers=Array.from({length:Math.min(4,Math.ceil(row.bytes/block))},async()=>{while(next<row.bytes){
   const begin=next,end=Math.min(row.bytes-1,begin+block-1);next=end+1;let response;
   for(let attempt=0;attempt<3;attempt++){
    combined.throwIfAborted();try{response=await fetchBuffer(row.url,{headers:{Range:`bytes=${begin}-${end}`,'Accept-Encoding':'identity'},signal:combined,maxBytes:end-begin+1});break;}catch(error){combined.throwIfAborted();if(attempt===2)throw error;}
   }
   if(response?.status!==206||response.headers?.['content-range']!==`bytes ${begin}-${end}/${row.bytes}`||response.body?.length!==end-begin+1)throw Error('The checkpoint source did not supply its declared byte range.');
   combined.throwIfAborted();const written=await handle.write(response.body,0,response.body.length,begin);if(written.bytesWritten!==response.body.length)throw Error('The checkpoint storage write is incomplete.');completed+=written.bytesWritten;onProgress?.({downloaded:completed,total:row.bytes});
  }});await Promise.all(workers);
  combined.throwIfAborted();const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(temporary,{signal:combined}))hash.update(bytes);
  if(completed!==row.bytes||hash.digest('hex')!==row.sha256)throw Error('The checkpoint source does not match its complete checksum.');
  await handle.close();await fs.promises.link(temporary,target);return target;
 }catch(error){controller.abort();await Promise.allSettled(workers);throw error;}
 finally{controller.abort();await handle.close().catch(()=>{});await fs.promises.rm(temporary,{force:true});}
}
module.exports={downloadEntry,downloadFile};
