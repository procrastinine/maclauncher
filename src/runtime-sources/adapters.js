'use strict';
const {getKind}=require('../core/component-kinds');
const modules={'cpu-translator':()=>require('../runtime-adapters/cpu-translator'),wine:()=>require('../runtime-adapters/wine'),'d3d-translator':()=>require('../runtime-adapters/d3d-translator'),'vulkan-driver':()=>require('../runtime-adapters/vulkan-driver'),nvapi:()=>require('../runtime-adapters/nvapi'),ngx:()=>require('../runtime-adapters/ngx'),media:()=>require('../runtime-adapters/media'),'steam-bridge':()=>require('../runtime-adapters/steam-bridge')};
function getAdapter(kind){if(!getKind(kind))throw new Error('Unknown runtime component kind.');const load=modules[kind];if(!load)throw new Error(`No ${kind} adapter is implemented.`);return load();}
function applySelectedComponent({kind,build,parts,environment,parameters}){return getAdapter(kind).apply({build,parts,environment,parameters});}
async function applyPlan(plan,{builds,parts={},environment={},parameters={}}={}){
 if(!plan?.satisfied||plan.provisional||plan.components.some(component=>!component.installed||component.measured!==true))throw new Error('A fully measured execution plan is required after installation.');
 let current={...environment};const applied=[];
 for(const component of plan.components){const build=builds.find(build=>build.id===component.build);if(!build||build.measured!==true)throw new Error('The selected measured build is unavailable.');
  const output=await applySelectedComponent({kind:component.kind,build,parts:parts[component.build],environment:current,parameters:parameters[component.build]||parameters});current=output.environment||current;applied.push({build:component.build,...output});
 }
 return {environment:current,applied};
}
module.exports={getAdapter,applySelectedComponent,applyPlan};
