import fs from 'node:fs';
import path from 'node:path';

/** Preserve compiler inputs when their final bytes and executable mode agree. */
export function writeChanged(file,bytes,mode){
  const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),before=fs.lstatSync(file,{throwIfNoEntry:false});
  if(before?.isFile()&&before.size===data.length&&fs.readFileSync(file).equals(data)){
    if(mode!==undefined&&(before.mode&0o777)!==mode){fs.chmodSync(file,mode);fs.utimesSync(file,before.atime,new Date());return true;}
    return false;
  }
  if(before&&!before.isFile())fs.rmSync(file,{recursive:true,force:true});
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);
  if(mode!==undefined)fs.chmodSync(file,mode);return true;
}
export function copyChanged(source,destination){
  const stat=fs.lstatSync(source);
  if(stat.isSymbolicLink()){
    const target=fs.readlinkSync(source),old=fs.lstatSync(destination,{throwIfNoEntry:false});
    if(old?.isSymbolicLink()&&fs.readlinkSync(destination)===target)return false;
    if(old)fs.rmSync(destination,{recursive:true,force:true});
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.symlinkSync(target,destination);return true;
  }
  if(!stat.isFile())throw Error('Expected a source file: '+source);
  return writeChanged(destination,fs.readFileSync(source),stat.mode&0o777);
}
export function synchronizeSourceTree(source,destination){
  source=path.resolve(source);destination=path.resolve(destination);
  if(source===destination)return;
  if(source.startsWith(destination+path.sep)||destination.startsWith(source+path.sep))throw Error('Source and build projection trees must be disjoint');
  const old=fs.lstatSync(destination,{throwIfNoEntry:false});
  if(old&&!old.isDirectory())fs.rmSync(destination,{recursive:true,force:true});
  fs.mkdirSync(destination,{recursive:true});
  const entries=fs.readdirSync(source,{withFileTypes:true}),names=new Set(entries.map(entry=>entry.name));
  for(const name of fs.readdirSync(destination))if(!names.has(name))fs.rmSync(path.join(destination,name),{recursive:true,force:true});
  for(const entry of entries){
    const from=path.join(source,entry.name),to=path.join(destination,entry.name);
    if(entry.isDirectory())synchronizeSourceTree(from,to);else copyChanged(from,to);
  }
}
/** The destination is an exclusively owned source tree, with compiler products
 * outside it. Strict adapters always receive pristine sources; only changed
 * final files are published, and removed upstream/adapter files disappear. */
export function prepareSourceTree(destination,prepare){
  destination=path.resolve(destination);fs.mkdirSync(path.dirname(destination),{recursive:true});
  const temporary=fs.mkdtempSync(path.join(path.dirname(destination),'.'+path.basename(destination)+'-source-'));
  try{const result=prepare(temporary);synchronizeSourceTree(temporary,destination);return result;}
  finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
