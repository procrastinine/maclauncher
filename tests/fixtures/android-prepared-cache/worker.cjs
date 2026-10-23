const fs=require('node:fs');
const Preparation=require('../../../src/modules/android/prepare');
const open=fs.promises.open.bind(fs.promises);let hashReads=[];
fs.promises.open=async(...args)=>{
  const handle=await open(...args),create=handle.createReadStream.bind(handle);
  handle.createReadStream=(...options)=>{hashReads.push(args[0]);return create(...options);};return handle;
};
let release;
process.on('message',async message=>{
  try{
    if(message.op==='prepare'){
      hashReads=[];
      const result=await Preparation.prepareApk(message.entry,{...message.options,retain:true,execute:async(_command,args)=>{
        fs.appendFileSync(message.conversions,process.pid+'\n');
        await new Promise(resolve=>setTimeout(resolve,100));
        fs.copyFileSync(message.converted,args[args.indexOf('io.github.kksimp.dex2jvm.ConvertApkSet')+2]);
      }});
      release=await Preparation.retainPrepared(result);
      process.send({root:result.root,sourceApk:result.sourceApk,convertedJar:result.convertedJar,hashReads});
    }else if(message.op==='release'){
      await release?.();release=null;process.send({released:true});
    }
  }catch(error){process.send({error:error.stack});}
});
process.on('disconnect',()=>process.exit(0));
