const fs = require("node:fs");

// One startup segment and two recent segments; each process session owns them.
function boundedLog(file, {limit=8*1024*1024, headLimit=256*1024}={}) {
  if(!Number.isSafeInteger(limit)||limit<=0||!Number.isSafeInteger(headLimit)||headLimit<0)throw Error("Invalid log size");
  const open = name => fs.openSync(name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);
  let fd=open(file),head;
  try{head=open(file+'.head');}catch(error){fs.closeSync(fd);throw error;}
  let size=0, headSize=0, closed=false;
  const write=(handle,bytes,offset,count)=>{for(let end=offset+count;offset<end;){const written=fs.writeSync(handle,bytes,offset,end-offset);if(!written)throw Error("Log write made no progress");offset+=written;}};
  return {
    write(value) {
      if(closed)return;
      const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
      if(headSize<headLimit){const count=Math.min(bytes.length,headLimit-headSize);write(head,bytes,0,count);headSize+=count;}
      let offset=0;
      while(offset<bytes.length){
        if(size===limit){fs.closeSync(fd);fd=undefined;fs.renameSync(file,file+'.previous');fd=open(file);size=0;}
        const count=Math.min(bytes.length-offset,limit-size);
        write(fd,bytes,offset,count);size+=count;offset+=count;
      }
    },
    close(){if(closed)return;closed=true;try{if(fd!==undefined)fs.closeSync(fd);}finally{fd=undefined;fs.closeSync(head);}}
  };
}
module.exports = {boundedLog};
