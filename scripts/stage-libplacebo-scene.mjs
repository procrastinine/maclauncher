import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SCENE_SHADER_INPUTS} from '../src/modules/shared/effects/operation-contracts.mjs';
import {SOURCE,VULKAN_HEADERS,FAST_FLOAT} from '../src/modules/shared/reshade/libplacebo/scene-overlay.mjs';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const samePin=(value,pin)=>value?.origin===pin.origin&&value?.commit===pin.commit&&value?.license===pin.license;
const fastFloat=FAST_FLOAT;
export function stageLibplaceboScene({directory,metadata,recipeRoot}){
  if(metadata.sceneInputsAPI===undefined||metadata.sceneInputsAPI===0)return null;
  const roles=SCENE_SHADER_INPUTS.filter(name=>!['viewMatrix','projectionMatrix'].includes(name));
  if(metadata.sceneInputsAPI!==1||JSON.stringify(metadata.sceneInputRoles)!==JSON.stringify(roles))throw Error('The libplacebo named input roles differ from the common image contract.');
  const recipes=['libplacebo-build.mjs','compiler-isolation.mjs','libplacebo/scene-source.mjs','libplacebo/scene-overlay.mjs','libplacebo/scene-profile.json'];
  const owned=new Map(recipes.map(name=>['maclauncher/'+name,path.join(recipeRoot,name)]));
  const declarations=new Map(),pins=new Set();
  for(const architecture of metadata.architectures){
    const receiptName='notices/libplacebo/scene-source'+(architecture==='arm64'?'':'.x86_64')+'.json';
    if(!metadata.files.some(row=>row.path===receiptName))throw Error('The libplacebo source interface declaration is missing: '+architecture);
    const receipt=JSON.parse(fs.readFileSync(path.join(directory,receiptName),'utf8'));
    if(receipt.architecture!==architecture||!samePin(receipt.source,SOURCE)||!samePin(receipt.vulkanHeaders,VULKAN_HEADERS)||
        receipt.fastFloat&&!samePin(receipt.fastFloat,fastFloat)||receipt.overlaySha256!==hash(path.join(recipeRoot,'libplacebo/scene-overlay.mjs'))||
        receipt.recipeSha256!==hash(path.join(recipeRoot,'libplacebo/scene-source.mjs')))throw Error('The libplacebo source recipe or public dependency pin changed: '+architecture);
    const input=metadata.inputs?.find(row=>row.name==='libplacebo'&&row.architecture===architecture);
    if(!input||!samePin(input,SOURCE)||input.overlaySha256!==receipt.overlaySha256||input.recipeSha256!==receipt.recipeSha256||
        JSON.stringify(input.headerInputs)!==JSON.stringify(receipt.headerInputs))throw Error('The libplacebo provider source inputs differ: '+architecture);
    const dependencies=[VULKAN_HEADERS,...(receipt.fastFloat?[fastFloat]:[])];
    if(JSON.stringify(input.dependencies)!==JSON.stringify(dependencies))throw Error('The libplacebo nested dependencies differ from its source recipe.');
    for(const [pin,relative]of [[SOURCE,'libplacebo-scene'],[VULKAN_HEADERS,'libplacebo-vulkan-headers'],...(receipt.fastFloat?[[fastFloat,'libplacebo-fast-float']]:[])]){
      declarations.set(pin.origin,pin);pins.add(`${pin.commit} third_party/${relative}`);
    }
    for(const [file,names]of [[metadata.library,['rsLibplaceboSceneInputsAPI','rsLibplaceboBindSceneInputs']],
      ['libplacebo/libplacebo.360.dylib',['pl_mpv_user_shader_external_textures_api','pl_mpv_user_shader_set_external_textures']]]){
      const symbols=execFileSync('/usr/bin/nm',['-arch',architecture,'-gU',path.join(directory,file)],{encoding:'utf8'});
      for(const name of names)if(!new RegExp('\\b_'+name+'\\b').test(symbols))throw Error(`The ${architecture} libplacebo named input implementation is missing: ${name}`);
    }
  }
  return {roles:[...roles],owned,pins:[...pins].map(line=>' '+line),sources:[...declarations.values()]};
}
