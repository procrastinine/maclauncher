'use strict';
const Requirements=require('../../modules/shared/runtime/feature-requirements');
const {versionAtLeast}=Requirements;
// Source declarations order included builds; measured compatibility decides loadability.
function sourceAutomatic({source,role,included,compatibility={},host={},settings={},environment={},selected={}}){
 const data=source.source||source,entries=data.automatic?.[role]||[];
 const eligible=token=>token==='gpu:apple-physical'?host.physicalAppleGPU===true:token==='metal:4'?Requirements.requirementSupport(Requirements.METAL4,host).supported===true:token.startsWith('macos>=')?Boolean(host.macOSVersion)&&versionAtLeast(host.macOSVersion,token.slice(7)):token.startsWith('cpu:')?token.slice(4)===(host.hardwareArch==='x64'?'x86_64':host.hardwareArch):true;
 for(let entry of entries){entry=typeof entry==='string'?{embed:entry}:entry;const embed=data.embeds?.find(embed=>embed.id===entry.embed);if(!embed)continue;
  const when=entry.when;if(when?.setting){const value=Object.hasOwn(settings,when.setting)?settings[when.setting]:environment[when.setting],equal=value===when.equals;if(when.not?equal:!equal)continue;}
  if(when?.selected&&selected[when.selected.role]?.engine!==when.selected.engine)continue;
  if([...(embed.interfaces?.requires||[]),...(entry.requires||[])].some(token=>!eligible(token)))continue;
  const item=included.find(item=>item.id===entry.embed||item.embedId===entry.embed||item.engine===embed.engine&&(!item.templateComponent||embed.parts.some(part=>part.name===item.templateComponent)));
  if(item&&compatibility[item.id]?.compatible!==false)return item;
 }
 return null;
}
module.exports={sourceAutomatic};
