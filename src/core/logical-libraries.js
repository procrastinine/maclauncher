'use strict';
const path=require('node:path');
const {acceptsBinary}=require('./binary-compatibility');
function logicalName(binary){return binary.logicalName||(binary.format==='pe'?path.basename(binary.path||'').toLowerCase():binary.installName||path.basename(binary.path||''));}
function fileProvides(binary){const name=path.basename(binary.path||'').toLowerCase();const map={'d3d8.dll':'d3d8','d3d9.dll':'d3d9','d3d10.dll':'d3d10','d3d10core.dll':'d3d10','d3d11.dll':'d3d11','d3d12.dll':'d3d12','dxgi.dll':'dxgi','ddraw.dll':'ddraw'};return map[name]?[`api:${map[name]}`]:[];}
function selectLogicalLibraries({build,hostArch,guestArch,integration='native',needed=[],libraries,infrastructure=false}={}){
 const groups=new Map();for(const binary of build.binaries||[]){const key=binary.format+':'+logicalName(binary);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(binary);}
 const binaries=[],excluded=[];
 for(const alternatives of groups.values()){
  const first=alternatives[0],name=logicalName(first),apis=fileProvides(first);
  if(libraries?.length&&!libraries.map(x=>x.toLowerCase()).includes(name.toLowerCase())&&first.format==='pe')continue;
  if(!libraries&&needed.length&&apis.length&&!apis.some(api=>needed.includes(api)))continue;
  const compatible=alternatives.filter(binary=>acceptsBinary(hostArch,infrastructure&&binaryIsPE(binary)?(integration==='wow64'?'arm64':'x86_64'):guestArch,infrastructure?'arm64ec':integration,binary).accepted);
  compatible.sort((a,b)=>((integration==='arm64ec'&&['arm64ec','arm64x'].includes(b.machine))?1:0)-((integration==='arm64ec'&&['arm64ec','arm64x'].includes(a.machine))?1:0));
  if(!compatible.length){excluded.push({logicalName:name,reason:acceptsBinary(hostArch,infrastructure&&first.format==='pe'?(integration==='wow64'?'arm64':'x86_64'):guestArch,infrastructure?'arm64ec':integration,first).reason});continue;}
  binaries.push(compatible[0]);
 }
 return {accepted:excluded.length===0,binaries,excluded,reason:excluded[0]?.reason};
}
function binaryIsPE(binary){return binary.format==='pe';}
module.exports={logicalName,fileProvides,selectLogicalLibraries};
