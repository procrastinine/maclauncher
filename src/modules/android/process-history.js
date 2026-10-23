const fs = require("node:fs");
const path = require("node:path");
const Writable = require("../shared/writable-input");
const LIMIT = 8192, COUNT = 32;
// Android/Linux signal numbers, rather than Darwin's differing numeric ABI.
const SIGNALS = { SIGHUP:1,SIGINT:2,SIGQUIT:3,SIGILL:4,SIGTRAP:5,SIGABRT:6,SIGIOT:6,
  SIGBUS:7,SIGFPE:8,SIGKILL:9,SIGUSR1:10,SIGSEGV:11,SIGUSR2:12,SIGPIPE:13,SIGALRM:14,
  SIGTERM:15,SIGCHLD:17,SIGCONT:18,SIGSTOP:19,SIGTSTP:20,SIGTTIN:21,SIGTTOU:22,
  SIGURG:23,SIGXCPU:24,SIGXFSZ:25,SIGVTALRM:26,SIGPROF:27,SIGWINCH:28,SIGIO:29,SIGSYS:31 };
const integer = (n,min,max) => Number.isSafeInteger(n)&&n>=min&&n<=max;
function open(directory, packageName) {
  Writable.assertOwnDirectory(directory,directory,{create:false});
  const identity=fs.statSync(directory),file=path.join(directory,"process-exits.json");
  function read() {
    let fd;
    try {
      fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size>LIMIT)throw new Error("Invalid Android process history file.");
      const buffer=Buffer.alloc(LIMIT+1);const size=fs.readSync(fd,buffer,0,buffer.length,0);
      if(size>LIMIT)throw new Error("Android process history is too large.");
      const value=JSON.parse(buffer.subarray(0,size).toString("utf8"));
      if(value.schemaVersion!==1||value.packageName!==packageName||!Array.isArray(value.records)||value.records.length>COUNT)
        throw new Error("Invalid Android process history identity.");
      for(const record of value.records)if(!integer(record.pid,1,0x7fffffff)||!integer(record.uid,0,0x7fffffff)||
          !integer(record.timestamp,0,Number.MAX_SAFE_INTEGER)||!integer(record.status,0,255)||![1,2].includes(record.reason)||
          typeof record.processName!=="string"||!record.processName.length||record.processName.length>1024||record.processName.includes("\0"))
        throw new Error("Invalid Android process exit record.");
      return value.records;
    } catch(error) {if(error.code==="ENOENT")return [];throw error;}
    finally {if(fd!==undefined)fs.closeSync(fd);}
  }
  const initial=read();
  return {
    json:JSON.stringify(initial),
    recordExit({pid,processName,uid,code,signal}) {
      const current=fs.lstatSync(directory);
      if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)
        throw new Error("Android application storage changed before process completion.");
      const status=signal?SIGNALS[signal]:code;
      if(!integer(pid,1,0x7fffffff)||!integer(uid,0,0x7fffffff)||!integer(status,0,255))
        throw new Error("Android process completion status is unavailable.");
      if(typeof processName!=="string"||!processName.length||processName.length>1024||processName.includes("\0"))
        throw new Error("Invalid Android process name.");
      const record={pid,uid,processName,timestamp:Date.now(),reason:signal?2:1,status};
      const records=[record,...read()].slice(0,COUNT);
      const encode=()=>JSON.stringify({schemaVersion:1,packageName,records})+"\n";
      while(Buffer.byteLength(encode())>LIMIT)records.pop();
      Writable.atomicWrite(file,encode(),{root:directory});
    }
  };
}
module.exports={open};
