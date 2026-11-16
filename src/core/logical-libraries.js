'use strict';
const path=require('node:path');
const {acceptsBinary,normalizeHostArchitecture}=require('./binary-compatibility');
const logicalName=binary=>binary.logicalName||(binary.format==='pe'?path.basename(binary.path||'').toLowerCase():binary.installName||path.basename(binary.path||''));
function fileProvides(binary){const name=path.basename(binary.path||'').toLowerCase();const api={'d3d8.dll':'d3d8','d3d9.dll':'d3d9','d3d10.dll':'d3d10','d3d10_1.dll':'d3d10','d3d10core.dll':'d3d10','d3d11.dll':'d3d11','d3d12.dll':'d3d12','dxgi.dll':'dxgi','ddraw.dll':'ddraw'}[name];return api?[api]:[];}
function selectLogicalLibraries({build={},hostArch,guestArch,needed=[],libraries,infrastructure=false}={}){
 const groups=new Map(),wanted=needed.map(value=>value.replace(/^api:/,''));
 for(const binary of build.binaries||[]){const name=logicalName(binary),apis=fileProvides(binary);
  if(binary.format==='pe'&&libraries?.length&&!libraries.some(value=>value.toLowerCase()===name.toLowerCase()))continue;
  if(binary.format==='pe'&&!libraries&&wanted.length&&apis.length&&!apis.some(api=>wanted.includes(api)))continue;
  // Included CPU support is the selected Wine's own inventory; only native helpers match its host slice.
  if(infrastructure&&binary.format==='pe')continue;
  const key=binary.format+':'+name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(binary);
 }
 const binaries=[],excluded=[];
 for(const alternatives of groups.values()){
  const compatible=alternatives.filter(binary=>acceptsBinary(hostArch,guestArch,'native',binary).accepted);
  if(normalizeHostArchitecture(hostArch)==='arm64')compatible.sort((a,b)=>Number(['arm64ec','arm64x'].includes(b.machine))-Number(['arm64ec','arm64x'].includes(a.machine)));
  if(compatible.length)binaries.push(compatible[0]);else excluded.push({logicalName:logicalName(alternatives[0]),reason:acceptsBinary(hostArch,guestArch,'native',alternatives[0]).reason});
 }
 return {accepted:!excluded.length,binaries,excluded,reason:excluded[0]?.reason};
}
module.exports={logicalName,fileProvides,selectLogicalLibraries};
