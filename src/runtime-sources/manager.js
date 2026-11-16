'use strict';

// A legacy manager id may contain several publisher sections. Its backend owns
// the existing installed/default state; this facade never copies that state.
function createSourceBackedManager({id,source,sources=source?[source]:[],adapter,backend,dependencies={}}={}) {
 if(!sources.length)throw new TypeError('A runtime source declaration is required.');
 const kind=sources[0].kind;
 const generic=!backend&&!adapter?.createBackend;
 adapter ||= require('./adapters').getAdapter(kind);
 if(sources.some(item=>item.kind!==kind))throw new TypeError('A source manager serves one component kind.');
 id ||= sources[0].manager?.id || sources[0].id;
 backend ||= generic?require('./backend').createSourceBackend({id,sources,source:sources[0],dependencies}):adapter.createBackend({id,sources,source:sources[0],dependencies});
 if(!backend||typeof backend!=='object')throw new TypeError('A source manager backend is required.');
 const manager=Object.create(backend);
 Object.assign(manager,{id,kind,sourceIds:sources.map(item=>item.id),sources,ui:backend.ui});
 for(const key of Object.keys(backend))if(typeof backend[key]==='function')manager[key]=backend[key].bind(backend);
 manager.listBuilds=context=>generic?backend.listBuilds(context):adapter?.listBuilds?adapter.listBuilds({manager:backend,sources,context}):backend.listBuilds?.(context)||[];
 manager.apply=options=>{if(typeof adapter?.apply!=='function')throw new Error(`No ${kind} launch adapter is registered.`);return adapter.apply(options);};
 return manager;
}
module.exports={createSourceBackedManager};
