const fs=require('node:fs');
const Preparation=require('../../../src/modules/android/prepare');
const Digests=require('../../../src/modules/android/preparation-digests');
const open=fs.promises.open.bind(fs.promises);let reads=0;
fs.promises.open=async(...args)=>{
  const handle=await open(...args),create=handle.createReadStream.bind(handle);
  handle.createReadStream=(...options)=>{reads++;return create(...options);};return handle;
};
(async()=>{
  const cache=Digests.open(process.argv[2]),sha256=await Preparation.fileHash(process.argv[3],undefined,cache);
  cache.save();process.stdout.write(JSON.stringify({sha256,reads}));
})().catch(error=>{process.stderr.write(error.message);process.exitCode=1;});
