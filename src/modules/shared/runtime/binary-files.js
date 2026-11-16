const fs = require('node:fs'), path = require('node:path');
const { inspectFile } = require('./translator-description');
const { acceptsBinary } = require('../../../core/launch-plan');
const { peArchitecture } = require('../../../core/binary-arch');

// Choose by actual machine/slices, independently of a publisher's folder names.
// Both compatibility and materialization consume this exact file set.
function binaryFiles(files, { machine, architecture, requiredPaths = [], integration = 'native' } = {}) {
  const originals=new Map(), passthrough=[];
  const binaries=files.map(file=>fs.existsSync(file.path)?inspectFile(file):file).filter(file=>{
    if(!['pe','macho'].includes(file.format)){passthrough.push(file);return false;}originals.set(file.path,file);return true;
  }).map(file=>({...file,...(file.format==='pe'?{machine:peArchitecture(file.machine)}:{architectures:file.cpuSlices})}));
  const result=!architecture&&!machine?{binaries:binaries.filter((file,index,list)=>list.findIndex(other=>other.format===file.format&&path.basename(other.path)===path.basename(file.path))===index),excluded:[]}:require('../../../core/logical-libraries').selectLogicalLibraries({build:{binaries},hostArch:architecture,guestArch:peArchitecture(machine),integration});
  const selected=[...result.binaries.map(file=>originals.get(file.path)),...passthrough];
  const missing=result.excluded.map(item=>{const file=[...originals.values()].find(file=>require('../../../core/logical-libraries').logicalName(file)===item.logicalName);return {file,reason:item.reason};});
  return {files:selected,missing:missing.filter(item=>item.file&&(requiredPaths.includes(item.file.path)||!selected.some(file=>file.format===item.file.format)))};
}

module.exports = { binaryFiles };
