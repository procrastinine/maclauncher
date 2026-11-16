'use strict';
// Expectations describe a measured selected process. Actual PID, birth and
// in-process translation receipts are observations supplied by launch owners.
function measuredProcessPlan({id='wine',kind='wine',build,invocationPath,sourceExecutablePath,architecture,guestArch,host}={}){
 const {normalizeHostArchitecture}=require('./binary-compatibility');
 const hardware=normalizeHostArchitecture(host?.hardwareArch||host?.hostArch);architecture=normalizeHostArchitecture(architecture);
 if(!architecture||!hardware)return {measured:false,reason:'Measured process architecture is unavailable.'};
 let main;try{main=require('../modules/shared/runtime/macho-load-commands').readMachOLoadCommands(sourceExecutablePath).slices.find(slice=>slice.architecture===architecture&&slice.fileType===2);}catch{}
 if(!main)return{id,kind,required:true,build,measured:false,reason:'The selected source main executable is not measured as MH_EXECUTE.',sourceExecutablePath,invocationPath,actualExecutablePath:null};
 const execution=architecture===hardware?'native':architecture==='x86_64'&&hardware==='arm64'?'rosetta':null;
 if(!execution)throw new Error(`Cannot execute the selected ${architecture} process on ${hardware}.`);
 return {id,kind,required:true,measured:true,build,invocationPath,sourceExecutablePath,actualExecutablePath:null,hostArch:architecture,guestArch,integration:'native',execution,expectedTranslated:execution==='rosetta'?1:0};
}
module.exports={measuredProcessPlan};
