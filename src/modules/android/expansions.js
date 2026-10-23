const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {withApk,LIMITS}=require("./apk");
const Writable=require("../shared/writable-input");

function expansionName(name,packageName,{archive=false}={}){
  const filename=path.posix.basename(name),standard=/^(?:main|patch)\.\d+\.(.+)\.obb$/i.exec(filename);
  const parent=/(?:^|\/)Android\/obb\/([^/]+)\//.exec(name);
  if(standard&&standard[1]!==packageName||parent&&parent[1]!==packageName){
    if(archive)throw new Error("An Android expansion file belongs to a different package.");
    return null;
  }
  return filename;
}
async function optionalStat(file){try{return await fs.promises.lstat(file);}catch(error){if(error.code==="ENOENT")return null;throw error;}}
async function copyFile(source,target,signal){
  const input=await fs.promises.open(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const before=await input.stat();if(!before.isFile())throw new Error("Android expansion files must be regular files.");
    let bytes=0;const hash=crypto.createHash("sha256");
    for await(const chunk of input.createReadStream({autoClose:false})){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>before.size||bytes>LIMITS.extractedBytes)throw new Error("An Android expansion file changed during import.");hash.update(chunk);}
    const sha256=hash.digest("hex");
    await fs.promises.copyFile(source,target,fs.constants.COPYFILE_FICLONE|fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(target,0o600);
    const copy=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(target)){signal?.throwIfAborted();copy.update(chunk);}
    const after=await input.stat();
    if(copy.digest("hex")!==sha256||bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error("An Android expansion file changed during import.");
    return {bytes,sha256};
  }finally{await input.close();}
}

/** Seed expansion storage once. Application downloads and updates remain owned
 * by the application; runtime replacement never restores old expansion bytes. */
async function installExpansions(input,packageName,dataRoot,{archive=false,signal,destination:requestedDestination}={}){
  async function install(entries,copy){
    if(!entries.length)return [];
    const destination=requestedDestination||path.join(dataRoot,"obb");Writable.assertOwnDirectory(dataRoot,destination);
    const names=new Set(),selected=[];let bytes=0;
    for(const entry of entries){
      const name=expansionName(entry.name,packageName,{archive});if(!name)continue;
      const key=name.normalize("NFC").toLowerCase();if(names.has(key))throw new Error("Android expansion filenames collide on macOS.");names.add(key);
      bytes+=entry.bytes;if(bytes>LIMITS.extractedBytes)throw new Error("Android expansion files exceed the supported size.");
      if(entry.linked)throw new Error("Android expansion files must be regular files.");
      selected.push({...entry,name});
    }
    const result=[];
    for(const entry of selected){
      signal?.throwIfAborted();const output=path.join(destination,entry.name),existing=await optionalStat(output);
      if(existing){
        if(!existing.isFile()||existing.isSymbolicLink())throw new Error("Android expansion storage must contain regular files.");
        result.push({name:entry.name,bytes:existing.size,existing:true});continue;
      }
      const temporary=await fs.promises.mkdtemp(path.join(destination,".import-")),staged=path.join(temporary,"expansion");
      try{
        const copied=await copy(entry,staged);signal?.throwIfAborted();
        // link publishes a complete file without replacing an application file
        // that may have appeared while extraction was in flight.
        try{await fs.promises.link(staged,output);result.push({name:entry.name,...copied});}
        catch(error){if(error.code!=="EEXIST")throw error;const current=await optionalStat(output);if(!current?.isFile()||current.isSymbolicLink())throw new Error("Android expansion storage must contain regular files.");result.push({name:entry.name,bytes:current.size,existing:true});}
      }finally{await fs.promises.rm(temporary,{recursive:true,force:true});}
    }
    return result;
  }
  if(archive)return withApk(input,container=>install(container.entries.filter(entry=>/\.obb$/i.test(entry.name)).map(entry=>({name:entry.name,source:entry.name,bytes:entry.uncompressedSize,linked:(entry.externalAttributes>>>16&0xf000)===0xa000})),(entry,output)=>container.copy(entry.source,output,{signal})));
  const stat=await fs.promises.lstat(input),root=stat.isDirectory()?input:path.dirname(input),entries=[];
  for(const directory of [root,path.join(root,"Android","obb",packageName)]){
    const folder=await optionalStat(directory);if(!folder)continue;if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error("Android expansion sources must be regular folders.");
    for(const entry of await fs.promises.readdir(directory,{withFileTypes:true})){
      if(!/\.obb$/i.test(entry.name))continue;const file=path.join(directory,entry.name),details=await fs.promises.lstat(file);
      entries.push({name:entry.name,source:file,bytes:details.size,linked:!details.isFile()||details.isSymbolicLink()});
    }
  }
  return install(entries,(entry,output)=>copyFile(entry.source,output,signal));
}
module.exports={installExpansions};
