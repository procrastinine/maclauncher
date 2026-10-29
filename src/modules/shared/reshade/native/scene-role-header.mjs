// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import {SCENE_SHADER_INPUTS} from '../../effects/operation-contracts.mjs';
export function sceneRoleHeader(){
 const symbol=name=>'RS_SHADER_SCENE_'+name.replace(/([a-z])([A-Z])/g,'$1_$2').toUpperCase();
 return '// Generated from the shared scene input registry. MIT license.\n#pragma once\n#include <stdint.h>\n'+
  '#define RS_SHADER_SCENE_ABI_VERSION 1\nenum RSShaderSceneRole {\n'+
  SCENE_SHADER_INPUTS.map((name,index)=>' '+symbol(name)+'='+index).join(',\n')+',\n RS_SHADER_SCENE_ROLE_COUNT='+SCENE_SHADER_INPUTS.length+'\n};\n'+
  'static const char*const rsShaderSceneRoleNames[RS_SHADER_SCENE_ROLE_COUNT]={'+SCENE_SHADER_INPUTS.map(name=>JSON.stringify(name)).join(',')+'};\n';
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){
 if(process.argv.length!==4||process.argv[2]!=='--output')throw Error('Expected --output <header>.');
 fs.writeFileSync(path.resolve(process.argv[3]),sceneRoleHeader());
}
