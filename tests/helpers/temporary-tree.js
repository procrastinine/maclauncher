const fs=require('node:fs'),path=require('node:path');

// Native translation caches publish read-only directories. Restore only the
// disposable tree's own directory permissions, without following any symlink.
function removeTemporaryTree(root){
 const writable=directory=>{
  fs.chmodSync(directory,0o700);
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}))
   if(entry.isDirectory())writable(path.join(directory,entry.name));
 };
 if(!fs.existsSync(root))return;
 writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
}
module.exports={removeTemporaryTree};
