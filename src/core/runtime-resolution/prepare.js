'use strict';
const {resolvePlan}=require('../launch-plan');
const {applyPlan}=require('../../runtime-sources/adapters');
const reason=plan=>[...(plan.unsatisfied||[]),...(plan.excluded||[]).map(row=>row.reason)].filter(Boolean).join(' ');
function orderedDownloads(plan,builds){
 const pending=new Map(plan.downloads.map(id=>[id,builds.find(build=>build.id===id)])),result=[];
 while(pending.size){const ready=[...pending.values()].filter(build=>build&&!pending.has(build.parent));if(!ready.length)throw new Error('Selected runtime downloads have a missing build or cyclic parent.');for(const build of ready){pending.delete(build.id);result.push(build);}}
 return result;
}
async function prepareRuntimePlan({readInventory,context={},confirmInstall=context.confirmRuntimeInstall,installBuild,application,apply=applyPlan,resolve=resolvePlan}={}){
 if(typeof readInventory!=='function')throw new TypeError('Fresh runtime inventory is required.');
 const attempted=new Set();let previous;
 for(;;){
  context.signal?.throwIfAborted();
  const inventory=await readInventory({previous});
  const plan=resolve(inventory);
  if(!plan.satisfied)throw new Error(reason(plan)||'No complete execution plan satisfies this launch.');
  if(!plan.provisional){
   if(plan.components.some(component=>component.measured!==true||!component.installed))throw new Error('A fully measured execution plan is required.');
   const options=typeof application==='function'?await application({plan,inventory}):application;
   const applied=options===false?null:await apply(plan,{...options,builds:inventory.builds});
   return{plan,inventory,application:applied,cancelled:false};
  }
  const downloads=orderedDownloads(plan,inventory.builds);
  if(!downloads.length||downloads.some(build=>attempted.has(build.id)))throw new Error('Installation did not produce a fresh fully measured execution plan.');
  const first=downloads[0],source=inventory.sources?.find(source=>source.id===first.source),manager=(inventory.managers||[]).find(manager=>manager.id===(first.legacy?.managerId||source?.manager?.id||first.source));
  const request={managerId:manager?.id||source?.manager?.id||first.source,version:first.version,label:first.label||source?.label||manager?.label||first.id,requiresDownload:true,
   bytes:first.bytes,companions:downloads.slice(1).map(build=>({label:build.label||inventory.sources?.find(source=>source.id===build.source)?.label||build.id,versionLabel:build.version,bytes:build.bytes}))};
  const consent=typeof confirmInstall==='function'?await confirmInstall(request):false;
  if(consent!==true&&consent?.approved!==true)return{plan,inventory,cancelled:true,application:null};
  const install=installBuild||require('../../runtime-sources/install').installBuild;
  for(const build of downloads){
   context.signal?.throwIfAborted();
   const declaration=inventory.sources?.find(source=>source.id===build.source),owner=(inventory.managers||[]).find(manager=>manager.id===(build.legacy?.managerId||declaration?.manager?.id||build.source));
   if(!owner)throw new Error(`The selected runtime manager for ${build.id} is unavailable.`);
   await install({build,source:declaration,manager:owner,context,installOptions:{...(build.legacy?.installOptions||{}),...(declaration?.manager?.sectionId?{sectionId:declaration.manager.sectionId}:{}),version:build.version,exactVersion:true}});
   attempted.add(build.id);
  }
  previous={plan,inventory};
 }
}
module.exports={prepareRuntimePlan,orderedDownloads};
