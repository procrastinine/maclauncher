const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { cloneOrCopy } = require("../copy-file");
const pending = new Map();
const digest = file => { const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"); try { const bytes=Buffer.alloc(1024*1024);let count;while((count=fs.readSync(fd,bytes,0,bytes.length,null)))hash.update(bytes.subarray(0,count));return hash.digest("hex"); } finally { fs.closeSync(fd); } };
// The publisher asset identity is shared across managers and architectures.
// Hashes check downloaded bytes; they never decide Wine compatibility.
async function acquire({ userDataDir, asset, destination, download, signal }) {
  const key = crypto.createHash("sha256").update(JSON.stringify([asset.url,asset.sha256,asset.bytes,asset.assetId])).digest("hex");
  const base = path.join(userDataDir,"runtimes","artifacts"), file=path.join(base,key), receipt=file+".json";
  const valid=()=>{try { const row=JSON.parse(fs.readFileSync(receipt,"utf8")), sha256=digest(file);return sha256===row.sha256&&(!asset.sha256||sha256===asset.sha256)?{sha256}:null; }catch{return null;}};
  let found=valid();
  if(!found){
    if(!pending.has(file)) pending.set(file,(async()=>{
      fs.mkdirSync(base,{recursive:true});const temporary=file+"."+crypto.randomUUID();
      try { await download(temporary);signal?.throwIfAborted();const sha256=digest(temporary);
        if(asset.sha256&&sha256!==asset.sha256)throw Error("Runtime archive SHA-256 differs from its publisher digest.");
        if(asset.bytes!==undefined&&fs.statSync(temporary).size!==asset.bytes)throw Error("Runtime archive size differs from its publisher record.");
        fs.renameSync(temporary,file);fs.writeFileSync(receipt,JSON.stringify({sha256}));return {sha256};
      }finally{fs.rmSync(temporary,{force:true});}
    })().finally(()=>pending.delete(file)));
    found=await pending.get(file);
  }
  signal?.throwIfAborted();await cloneOrCopy(file,destination,{signal,exclusive:true});return found;
}
module.exports={acquire};
