'use strict';
const rows=[['wine','Wine'],['cpu-translator','CPU translator'],['d3d-translator','Direct3D translator'],['vulkan-driver','Vulkan driver'],['nvapi','NVAPI'],['ngx','NGX'],['media','Media'],['audio','Audio'],['steam-bridge','Steam bridge'],['graphics-core','Graphics processor']];
const KINDS=Object.freeze(Object.fromEntries(rows.map(([id,label])=>[id,Object.freeze({id,label,adapter:id})])));
const getKind=id=>Object.hasOwn(KINDS,id)?KINDS[id]:null;
module.exports={KINDS,getKind};
