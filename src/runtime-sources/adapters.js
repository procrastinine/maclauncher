'use strict';
const {getKind}=require('../core/component-kinds');
const modules={'cpu-translator':()=>require('../runtime-adapters/cpu-translator'),wine:()=>require('../runtime-adapters/wine'),'d3d-translator':()=>require('../runtime-adapters/d3d-translator'),'vulkan-driver':()=>require('../runtime-adapters/vulkan-driver'),nvapi:()=>require('../runtime-adapters/nvapi'),ngx:()=>require('../runtime-adapters/ngx'),media:()=>require('../runtime-adapters/media'),'steam-bridge':()=>require('../runtime-adapters/steam-bridge')};
function getAdapter(kind){if(!getKind(kind))throw new Error('Unknown runtime component kind.');const load=modules[kind];if(!load)throw new Error(`No ${kind} adapter is implemented.`);return load();}
function applySelectedComponent({kind,build,parts,environment,parameters}){return getAdapter(kind).apply({build,parts,environment,parameters});}
module.exports={getAdapter,applySelectedComponent};
