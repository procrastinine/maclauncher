const fs=require('node:fs');
const {withCatalogLock}=require('../../../src/modules/android/catalog-lock');
const [file,journal,name]=process.argv.slice(2);
withCatalogLock(file,async()=>{
 fs.appendFileSync(journal,name+':enter\n');process.stdout.write('acquired\n');
 process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));
 fs.appendFileSync(journal,name+':leave\n');
}).catch(error=>{console.error(error);process.exitCode=1;});
