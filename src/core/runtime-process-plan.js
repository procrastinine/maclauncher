'use strict';
// Expectations describe a measured selected process. Actual PID, birth and
// in-process translation receipts are observations supplied by launch owners.
function measuredProcessPlan({build,invocationPath,sourceExecutablePath,architecture,guestArch,host}={}){
 const hardware=host?.hardwareArch||host?.hostArch;
 if(!architecture||!hardware)return {measured:false,reason:'Measured process architecture is unavailable.'};
 const execution=architecture===hardware?'native':architecture==='x86_64'&&hardware==='arm64'?'rosetta':null;
 if(!execution)throw new Error(`Cannot execute the selected ${architecture} process on ${hardware}.`);
 return {measured:true,build,invocationPath,sourceExecutablePath,actualExecutablePath:null,hostArch:architecture,guestArch,integration:'native',execution,expectedTranslated:execution==='rosetta'?1:0};
}
module.exports={measuredProcessPlan};
