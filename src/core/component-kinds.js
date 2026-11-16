'use strict';
// Domains describe where code executes; architectures belong to measured builds.
const rows = [
 ['wine','Wine','process',['host:windows-userland'],[]],
 ['cpu-translator','CPU translator','system|guest',['cpu:translate'],[]],
 ['d3d-translator','Direct3D translator','guest',[],[]],
 ['vulkan-driver','Vulkan driver','host',['api:vulkan'],[]],
 ['nvapi','NVAPI','guest',['nvapi'],[]],
 ['ngx','NGX','guest+host',['ngx'],[]],
 ['media','Media','host',['media:gstreamer'],[]],
 ['audio','Audio','host',['audio:coreaudio-wine'],[]],
 ['steam-bridge','Steam bridge','guest+host',['steam:client'],[]],
 ['addon','Wine add-on','guest',[],[]],
 ['graphics-core','Graphics processor','host',['graphics:processor'],[]]
];
const KINDS = Object.freeze(Object.fromEntries(rows.map(([id,label,domain,provides,requires]) => [id,Object.freeze({id,label,domain,provides:Object.freeze(provides),requires:Object.freeze(requires),adapter:id})])));
function getKind(id) { return Object.hasOwn(KINDS,id) ? KINDS[id] : null; }
module.exports={KINDS,getKind};
