import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {threadId} from 'node:worker_threads';
import {spawn,execFileSync} from 'node:child_process';

// Kernel ownership survives concurrent publishers and releases on parent EOF.
export async function withGenerationCache(root,operation){
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 if(!fs.lstatSync(root).isDirectory())throw Error('Generation cache is not an owned directory');
 const file=path.join(root,'.generation.lock');
 const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
 try{if(!fs.fstatSync(fd).isFile())throw Error('Generation lock is not a regular file');}finally{fs.closeSync(fd);}
 const holder=spawn('/usr/bin/lockf',['-k',file,'/bin/sh','-c','printf "ready\\n"; while IFS= read -r line; do :; done'],{stdio:['pipe','pipe','pipe']});
 holder.stdin.on('error',()=>{});
 const closed=new Promise(resolve=>{holder.once('close',resolve);holder.once('error',resolve);});
 try{
  await new Promise((resolve,reject)=>{
   let output='';holder.stdout.on('data',bytes=>{output+=bytes;if(output.includes('ready\n'))resolve();});
   holder.once('error',reject);holder.once('close',()=>reject(Error('Generation lock holder stopped')));
  });
  return await operation();
 }finally{holder.stdin.end();await closed;}
}
export function processAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return true;
 try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
export function generationProcesses(){
 // Failure disables pruning; a running app is never guessed to be absent.
 try{return execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8',timeout:5000,maxBuffer:16*1024*1024});}catch{return null;}
}
// Darwin's O_EXLOCK is defined by sys/fcntl.h but omitted from Node constants.
// The descriptor is a kernel lifetime owner, independent of PID reuse. Node
// does not inherit it into spawned children unless explicitly passed in stdio.
const EXLOCK=0x20,leases=new Map();
export function retainGeneration(root,paths){
 if(process.platform!=='darwin')throw Error('Generation lifetime leases require macOS');
 root=path.resolve(root);
 const directory=path.join(root,'.generation-leases');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 let lease=leases.get(root);
 if(!lease){
  const file=path.join(directory,process.pid+'-'+crypto.randomBytes(12).toString('hex')+'.json');
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|EXLOCK,0o600);
  lease={file,fd,paths:new Set()};leases.set(root,lease);
 }
 for(const file of paths)lease.paths.add(path.resolve(file));
 const bytes=Buffer.from(JSON.stringify({schemaVersion:2,pid:process.pid,threadId,paths:[...lease.paths]})+'\n');
 fs.writeSync(lease.fd,bytes,0,bytes.length,0);fs.ftruncateSync(lease.fd,bytes.length);
 return ()=>{
  if(leases.get(root)!==lease)return;leases.delete(root);
  fs.closeSync(lease.fd);fs.rmSync(lease.file,{force:true});
 };
}
export function liveGenerationPaths(root,{alive=processAlive}={}){
 const directory=path.join(root,'.generation-leases'),paths=[];
 if(!fs.existsSync(directory))return paths;
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(!entry.isFile()||!/^\d+(?:-[a-f0-9]{24})?\.json$/.test(entry.name))continue;
  const file=path.join(directory,entry.name);
  try{
   if(entry.name.includes('-')){
    // The cache lock serializes publication and path updates. An unlocked
    // file is stale even if its recorded PID has since been reused.
    let fd;
    try{fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|EXLOCK);}
    catch(error){if(error.code!=='EAGAIN'&&error.code!=='EWOULDBLOCK')throw error;}
    if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(file);continue;}
    const lease=JSON.parse(fs.readFileSync(file));paths.push(...lease.paths);
   }else{
    // Earlier writers use PID-only records. Preserve their conservative
    // behavior until those processes end; new leases never use this proof.
    const lease=JSON.parse(fs.readFileSync(file));if(alive(lease.pid))paths.push(...lease.paths);else fs.unlinkSync(file);
   }
  }catch(error){if(error.code!=='ENOENT')throw Error('Generation lease cannot be inspected: '+entry.name);}
 }
 return paths;
}
export function generationReferenced(root,paths,processes){
 return paths.some(file=>file===root||file.startsWith(root+path.sep))||processes.includes(root+path.sep)||processes.split('\n').some(line=>line.endsWith(root));
}
