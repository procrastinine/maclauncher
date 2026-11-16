'use strict';
const normalizeHostArchitecture=value=>({x64:'x86_64',aarch64:'arm64',x86:'i386'})[value]||value;
function acceptsBinary(host,guest,_integration,binary={}){
 host=normalizeHostArchitecture(host);guest=normalizeHostArchitecture(guest);
 if(binary.format==='macho')return !host||!binary.architectures?.length||binary.architectures.includes(host)?{accepted:true}:{accepted:false,reason:'Host library has no '+host+' Mach-O slice.'};
 if(binary.format==='pe'){
  const machine=typeof binary.machine==='number'?require('./binary-arch').peArchitecture(binary.machine):binary.machine;
  return !guest||!machine||machine==='unknown'||(guest==='x86_64'?['x86_64','arm64ec','arm64x'].includes(machine):guest===machine)?{accepted:true}:{accepted:false,reason:'PE '+machine+' cannot load in '+guest+'.'};
 }
 return {accepted:true};
}
module.exports={acceptsBinary,normalizeHostArchitecture};
