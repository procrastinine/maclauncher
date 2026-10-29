// Copyright (c) MacLauncher contributors. MIT license.
const Providers=require('../../effects/providers'),Setup=require('./setup');
function throwIfAborted(signal){if(signal?.aborted)throw signal.reason||Object.assign(new Error('Model preparation was cancelled.'),{name:'AbortError'});}
const compatible=require('../../effects/neural-selection.mjs').compatibleNeuralModel;
function current(work,signal){
  throwIfAborted(signal);if(!signal)return Promise.resolve().then(work);
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason||Object.assign(new Error('Model preparation was cancelled.'),{name:'AbortError'}));},cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{throwIfAborted(signal);return work();}).then(value=>{cleanup();signal.aborted?abort():resolve(value);},error=>{cleanup();reject(error);});
  });
}
async function prepare(plan,options={},dependencies={}){
  const active=plan.enabled===false?[]:plan.video.filter(node=>node.enabled);
  const modelOperations=Object.fromEntries(active.map(node=>[node.id,Providers.modelOperation(node,options)]).filter(([,operation])=>operation));
  const wanted=active.filter(node=>modelOperations[node.id]&&!node.settings?.modelPath);
  if(!wanted.length)return {models:[],pending:[],modelOperations};
  const Neural=dependencies.neural||require('./index'),list=()=>Neural.listModels(options.userDataDir),reasons=new Map();let models=list();
  const acquire=options.acquireModels??options.launchPreparation===true;
  for(const method of new Set(wanted.map(node=>modelOperations[node.id]))){
    throwIfAborted(options.signal);if(models.some(row=>compatible(row,method)))continue;
    const source=Setup.sourcesFor(method).find(row=>row.defaultForOperation)||Setup.sourcesFor(method)[0];
    const fallback=source?'A compatible model is needed. Download the recommended model or import one.':'A compatible model is needed. Import a model for this operation.';
    // A missing model downloads only after consent. The manager's setup action
    // approves itself, so its route asks first; Setup asks inside.
    if(!acquire||!source||typeof options.confirmRuntimeInstall!=='function'){reasons.set(method,fallback);continue;}
    const provider=dependencies.provider||Neural.resolve(options.root||require('../index').runtimeRoot(options.app),options);
    if(!(provider?.supportedMethods||provider?.descriptor?.operations||[]).includes(method)){reasons.set(method,provider?.reason||'This graphics processor does not provide the selected neural operation.');continue;}
    try{
      // The shared manager task has its own cancellation control. A superseded
      // graph stops waiting immediately without cancelling another user's copy.
      const result=await current(async()=>{
        const installed=await(options.ensureNeuralModel?(await require('../../runtime/tool-install').downloadApproved(options,Setup.downloadPlan(source))?options.ensureNeuralModel({method,sourceVersion:source.version,setupActionId:source.files?'downloadModel:'+source.version:'downloadDlssMac'}):null):Setup.ensureNeuralModel({...options,signal:undefined,method}));
        if(installed)try{await options.onRuntimeStateChange?.({managerId:'graphics-neural-models'});}catch(error){require('../../graphics-warning')(options.logger,'The model library could not be refreshed.',error.message);}
        return installed;
      },options.signal);
      throwIfAborted(options.signal);models=list();if(!result||!models.some(row=>compatible(row,method)))reasons.set(method,fallback);
    }catch(error){throwIfAborted(options.signal);reasons.set(method,String(error?.message||fallback).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,512));}
  }
  // Without acquisition here (a live edit), a pending row names its curated
  // source; the graphics status owner asks consent and downloads it (S13).
  const acquisition=method=>{
    if(acquire)return null;
    const source=Setup.sourcesFor(method).find(row=>row.defaultForOperation)||Setup.sourcesFor(method)[0];
    return source?{operation:method,source:{version:source.version,label:source.files?source.label:'Neural rendering model',bytes:source.bytes,setupActionId:source.files?'downloadModel:'+source.version:'downloadDlssMac'}}:null;
  };
  return {models,modelOperations,pending:wanted.filter(node=>!models.some(row=>compatible(row,modelOperations[node.id]))).map(node=>{
    const operation=modelOperations[node.id],source=acquisition(operation);
    return {id:node.id,kind:node.kind,method:node.kind==='shader'?node.shader.preset:node.method,modelOperation:operation,requestKey:require('../../effects/live-plan').selectionKey(node),retained:false,reason:reasons.get(operation)||'A compatible model is needed.',...(source?{acquisition:source}:{})};
  })};
}
module.exports={prepare,compatible};
