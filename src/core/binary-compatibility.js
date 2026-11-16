'use strict';
const {peMachineCode}=require('./binary-arch');
// This table applies to measured binaries, independently of publisher names.
function acceptsBinary(processHost, guestArch, integration, binary) {
  if(binary.format==='macho') return typeof processHost==='string'&&binary.architectures?.includes(processHost)
    ? {accepted:true} : {accepted:false,reason:`Host library has no ${processHost} Mach-O slice.`};
  if(binary.format==='pe') {
    const nativeHybrid=integration==='arm64ec' && guestArch==='x86_64' && ['arm64ec','arm64x'].includes(binary.machine);
    if(peMachineCode(guestArch)&&peMachineCode(binary.machine)&&(binary.machine===guestArch || nativeHybrid)) return {accepted:true};
    return {accepted:false,reason:`PE ${binary.machine} cannot load in ${guestArch} (${integration}).`};
  }
  return {accepted:false,reason:`No ${binary.format} integration is selected for this process.`};
}
module.exports={acceptsBinary};
