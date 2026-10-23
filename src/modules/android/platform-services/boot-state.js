const path=require("node:path"),{execFile}=require("node:child_process"),{promisify}=require("node:util");
const {readPrivate,writePrivate}=require("./paths");
const {withCatalogLock}=require("../catalog-lock");

// Launch and service supervisors share this short metadata transaction. A
// service/process restart is not a device boot. The Mac session identifier stays
// in private profile storage; Android clients receive only the counter.
async function bootCount(storage){
  const {stdout}=await promisify(execFile)("/usr/sbin/sysctl",["-n","kern.bootsessionuuid"],{encoding:"utf8",maxBuffer:4096});
  const session=stdout.trim();
  if(!/^[0-9a-f-]{36}$/i.test(session))throw Error("Android boot state could not be read.");
  const file=path.join(storage.root,"boot.json");
  return withCatalogLock(path.join(storage.root,"boot.lock"),async()=>{
    let previous;
    try{previous=await readPrivate(file);}catch(error){if(error.code!=="ENOENT")throw error;}
    if(previous&&(!Number.isSafeInteger(previous.count)||previous.count<1||previous.count>=2147483647||typeof previous.session!=="string"))
      throw Error("Android boot state is invalid.");
    if(previous?.session===session)return previous.count;
    const count=(previous?.count||0)+1;
    await writePrivate(file,{session,count});return count;
  });
}

module.exports={bootCount};
