import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Payload from "../src/modules/shared/runtime/payload-files.js";
export const ALIAS_INDEX=Payload.INDEX;
// A provider declares, as resolvedPaths in its provider.json, the
// payload-relative path prefixes its native code opens through the shared
// payload resolver. Each result names the package-relative payload directory
// and prefix.
export function resolvedPrefixes(inputs){
  const prefixes=[];
  for(const [relative,file]of inputs){
    if(path.posix.basename(relative)!=="provider.json")continue;
    const declared=JSON.parse(fs.readFileSync(file,"utf8")).resolvedPaths;
    if(declared===undefined)continue;
    if(!Array.isArray(declared)||declared.some(prefix=>typeof prefix!=="string"||!Payload.safe(prefix.replace(/\/$/,""))))throw Error("Invalid resolved payload paths: "+relative);
    const directory=path.posix.dirname(relative);
    prefixes.push(...declared.map(prefix=>({directory,prefix:(directory==="."?"":directory+"/")+prefix})));
  }
  return prefixes;
}
// Stores each identical file under one payload's resolved prefixes once: the
// first path in sorted order keeps the content and every later path becomes its
// alias in that payload directory's index. Paths in keep, such as executables,
// always stay. Aliases never leave their payload directory, which is the unit a
// sandboxed process may read.
export function deduplicate(inputs,{prefixes,keep=new Set()}){
  const stored=new Map(),indexes=new Map();
  for(const relative of [...inputs.keys()].sort((a,b)=>a<b?-1:a>b?1:0)){
    const declared=prefixes.find(({prefix})=>relative.startsWith(prefix));
    if(keep.has(relative)||!declared)continue;
    const content=declared.directory+"\0"+crypto.createHash("sha256").update(fs.readFileSync(inputs.get(relative))).digest("hex");
    if(!stored.has(content)){stored.set(content,relative);continue;}
    const local=file=>declared.directory==="."?file:file.slice(declared.directory.length+1);
    if(!indexes.has(declared.directory))indexes.set(declared.directory,{});
    indexes.get(declared.directory)[local(relative)]=local(stored.get(content));
  }
  const removed=new Set([...indexes].flatMap(([directory,aliases])=>Object.keys(aliases).map(file=>directory==="."?file:directory+"/"+file)));
  return {inputs:new Map([...inputs].filter(([relative])=>!removed.has(relative))),indexes};
}
export function aliasIndex(aliases){return JSON.stringify({schema:1,files:aliases})+"\n";}
