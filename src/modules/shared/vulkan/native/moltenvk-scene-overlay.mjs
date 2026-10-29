// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export const source=JSON.parse(fs.readFileSync(path.join(root,'moltenvk-scene-source.json')));
export const ownedFiles=['scene-interop.h','scene-command.hpp','scene-command.inc'];
export const commonHeaders={
 'frame.h':'../../reshade/temporal/frame.h',
 'scene-aovs.h':'../../reshade/temporal/scene-aovs.h',
 'scene-matrices.h':'../../reshade/temporal/scene-matrices.h',
 'image-color.h':'../../reshade/native/image-color.h',
 'vulkan-scene.h':'../../reshade/native/vulkan-scene.h'
};
function original(repository,file){return execFileSync('git',['-C',repository,'show',source.revision+':'+file],{encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1'},maxBuffer:16<<20});}
function replace(text,from,to,file){if(text.split(from).length!==2)throw Error('MoltenVK source anchor changed: '+file);return text.replace(from,to);}
export function sceneSources(repository){
 const files=new Map();
 const edit=(file,changes)=>{let text=original(repository,file);for(const[from,to]of changes)text=replace(text,from,to,file);files.set(file,text);};
 const commands='MoltenVK/MoltenVK/Commands/';
 edit(commands+'MVKCommandPool.h',[
  ['#include "MVKCmdDebug.h"','#include "MVKCmdDebug.h"\n#include "scene-command.hpp"'],
  ['#pragma mark Command resources','MVKCommandTypePool<MVKCmdMacfxScene> _cmdMacfxScenePool;\n\n#pragma mark Command resources']
 ]);
 edit(commands+'MVKCommandPool.mm',[
  ['void MVKCommandPool::trim() {','void MVKCommandPool::trim() {\n    _cmdMacfxScenePool.clear();'],
  ['\t_commandBufferPool(device, usePooling),','\t_cmdMacfxScenePool(usePooling),\n\t_commandBufferPool(device, usePooling),']
 ]);files.set(commands+'MVKCommandPool.mm',files.get(commands+'MVKCommandPool.mm')+'\n#include "scene-command.inc"\n');
 edit(commands+'MVKCommandBuffer.h',[
  ['\tvoid addCommand(MVKCommand* command);','\tvoid addCommand(MVKCommand* command);\n    bool canRecordMacfxSceneOperation() const { return _canAcceptCommands; }\n    bool canRecordMacfxSceneStaging() const { return _canAcceptCommands && !_immediateCmdEncoder && (!_prefilledMTLCmdBuffer || _prefilledMTLCmdBuffer.retainedReferences); }\n    bool _macfxSceneStaging=false, _macfxSceneStagingEscaped=false;']
 ]);
 edit(commands+'MVKCommandBuffer.mm',[
  ['VkResult MVKCommandBuffer::reset(VkCommandBufferResetFlags flags) {','VkResult MVKCommandBuffer::reset(VkCommandBufferResetFlags flags) {\n    _macfxSceneStaging = _macfxSceneStagingEscaped = false;'],
  ['\t\tif (cmdBuff->_hasStageCounterTimestampCommand) { _hasStageCounterTimestampCommand = true; }','\t\tif (cmdBuff->_hasStageCounterTimestampCommand) { _hasStageCounterTimestampCommand = true; }\n        if (cmdBuff->_macfxSceneStaging) {\n            _macfxSceneStaging = true;\n            _macfxSceneStagingEscaped = _macfxSceneStagingEscaped || _immediateCmdEncoder || cmdBuff->_macfxSceneStagingEscaped;\n        }']
 ]);
 {
  const file=commands+'MVKCommandBuffer.mm',guard='if (!isUsingMetalArgumentBuffers() || !getDevice()->hasResidencySet()) return;';
  let text=files.get(file);
  if(text.split(guard).length!==7)throw Error('MoltenVK barrier guard count changed');
  text=text.replaceAll(guard,'if ((!isUsingMetalArgumentBuffers() || !getDevice()->hasResidencySet()) && !_cmdBuffer->_macfxSceneStaging) return;');
  const index='auto fenceIndex = _pEncodingContext->fenceSlots.wait[stage][i];';
  if(text.split(index).length!==4)throw Error('MoltenVK barrier wait count changed');
  // Index zero belongs to the original cross-submission residency path. The
  // opt-in boundary uses only producer fences updated in this recording.
  text=text.replaceAll(index,index+'\n        if (!fenceIndex && (!isUsingMetalArgumentBuffers() || !getDevice()->hasResidencySet())) continue;');
  files.set(file,text);
 }
 edit('MoltenVK/MoltenVK/GPUObjects/MVKDevice.mm',[
  ['#include "MVKDevice.h"','#include "MVKDevice.h"\n#include "scene-interop.h"'],
  ['PFN_vkVoidFunction MVKDevice::getProcAddr(const char* pName) {','PFN_vkVoidFunction MVKDevice::getProcAddr(const char* pName) {\n    if (pName && !strcmp(pName, "rsMoltenVKSceneOperationAPI")) return (PFN_vkVoidFunction)rsMoltenVKSceneOperationAPI;\n    if (pName && !strcmp(pName, "rsMoltenVKSceneStagingAPI")) return (PFN_vkVoidFunction)rsMoltenVKSceneStagingAPI;\n    if (pName && !strcmp(pName, "rsMoltenVKRecordSceneOperation")) return (PFN_vkVoidFunction)rsMoltenVKRecordSceneOperation;']
 ]);
 edit('MoltenVK/MoltenVK/GPUObjects/MVKDevice.h',[
  ['class MVKDevice : public MVKDispatchableVulkanAPIObject {\n\npublic:', 'class MVKDevice : public MVKDispatchableVulkanAPIObject {\n\npublic:\n    std::atomic<uint32_t> _macfxSceneRecordingCount{0};']
 ]);
 edit('MoltenVK/MoltenVK/GPUObjects/MVKQueue.mm',[
  ['mtlCmdBuffDesc.retainedReferences = retainRefs;', 'mtlCmdBuffDesc.retainedReferences = retainRefs || _device->_macfxSceneRecordingCount.load(std::memory_order_acquire) != 0;']
 ]);
 edit('MoltenVK/CMakeLists.txt',[['COMMAND ${GIT_EXECUTABLE} rev-parse --short HEAD','COMMAND ${CMAKE_COMMAND} -E echo db66022459ff']]);
 for(const file of ownedFiles)files.set(commands+file,fs.readFileSync(path.join(root,file)));
 files.set('MoltenVK/include/MoltenVK/scene-interop.h',fs.readFileSync(path.join(root,'scene-interop.h')));
 for(const[name,file]of Object.entries(commonHeaders))files.set('MoltenVK/include/macfx-temporal/'+name,fs.readFileSync(path.resolve(root,file)));
 return files;
}
