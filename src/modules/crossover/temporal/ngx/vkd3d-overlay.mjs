// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
// Operates on the recipe's owned prepared tree, never its upstream checkout.
// The caller retains the normal exact source pin and upstream license closure.
export function applyPreparedSceneOverlay(directory) {
 const file=path.join(directory,'libs/vkd3d/command.c');
 const original=fs.readFileSync(file,'utf8');
 if(original.includes('MacLauncherVkd3dRecordScene2')||original.includes('maclauncher-scene.inc'))throw Error('The scene overlay is already present.');
 for(const anchor of ['unsafe_impl_from_ID3D12CommandList(', 'd3d12_command_list_flush_dgc_batch(', 'd3d12_command_list_end_current_render_pass(', 'd3d12_command_list_end_transfer_batch(', 'd3d12_command_list_track_resource_usage('])
  if(!original.includes(anchor))throw Error('The selected VKD3D command source lacks '+anchor);
 const here=import.meta.dirname,target=path.dirname(file);
 const files=[['vkd3d-scene.inc','maclauncher-scene.inc'],['../vulkan/scene-request.h','scene-request.h'],['../vulkan/scene-metadata.h','maclauncher-scene-metadata.h']];
 for(const [source,name]of files){const destination=path.join(target,name);if(fs.existsSync(destination))throw Error('The prepared source already contains '+name);fs.copyFileSync(path.resolve(here,source),destination);}
 fs.writeFileSync(file,original+'\n#include "maclauncher-scene.inc"\n');
 return {files:['libs/vkd3d/command.c',...files.map(([,name])=>'libs/vkd3d/'+name)]};
}
