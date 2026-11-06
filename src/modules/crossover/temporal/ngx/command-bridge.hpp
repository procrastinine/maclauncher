#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "producer.hpp"
#include "parameters.hpp"
#include <memory>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#include <d3d12.h>
namespace maclauncher::ngx {
// PE-only connection to the actual command-list implementation, located by its
// own COM method address. No backend name or filename selects the translator.
class CommandBridge {
 using Context=int32_t(WINAPI*)(ID3D12GraphicsCommandList*,uint64_t*,uint64_t*);
 using Resolve=int32_t(WINAPI*)(ID3D12Resource*,uint32_t,uint32_t,uint32_t,RSWineVulkanSceneImageV1*,uint32_t*,uint32_t*);
 using Record=int32_t(WINAPI*)(ID3D12GraphicsCommandList*,const RSWineVulkanSceneRequestV2*,ID3D12Resource*const*);
 HMODULE translator=nullptr,wine=nullptr;
 Context context=nullptr;Resolve resolve=nullptr;Record record=nullptr;
 ID3D12GraphicsCommandList*commands=nullptr;bool recordingAttempted=false;
 struct Resource {Image image;ID3D12Resource*value;};std::vector<Resource>resources;
 std::unique_ptr<Producer>producer;
 static bool same(const RSWineVulkanSceneImageV1&a,const RSWineVulkanSceneImageV1&b){return a.image==b.image&&a.aspect==b.aspect&&a.mipLevel==b.mipLevel&&a.arrayLayer==b.arrayLayer;}
 void clear(){for(auto&r:resources)r.value->Release();resources.clear();}
 static int32_t submit(void*storage,const RSWineVulkanSceneRequestV2*packet){
  auto&self=*static_cast<CommandBridge*>(storage);ID3D12Resource*resolved[RS_WINE_VULKAN_SCENE_IMAGE_COUNT]{};
  for(unsigned slot=0;slot<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++slot)if(packet->base.imageMask&(1u<<slot)){
   for(const auto&r:self.resources)if(same(r.image.binding,packet->base.images[slot])){
    if(resolved[slot]&&resolved[slot]!=r.value)return -3;
    resolved[slot]=r.value;
   }
   if(!resolved[slot])return -3;
  }
  self.recordingAttempted=true;return self.record(self.commands,packet,resolved);
 }
public:
 CommandBridge(ID3D12GraphicsCommandList*list,uint64_t observer,uint64_t feature){
  if(!list||!observer||!feature)return;
  char enabled[2];if(GetEnvironmentVariableA("MACLAUNCHER_NGX_SCENE_ENABLE",enabled,sizeof(enabled))!=1||enabled[0]!='1')return;
  void*method=(*reinterpret_cast<void***>(list))[0];
  if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,reinterpret_cast<LPCWSTR>(method),&translator)||
     !GetModuleHandleExW(0,L"winevulkan.dll",&wine))return;
  context=reinterpret_cast<Context>(GetProcAddress(translator,"MacLauncherVkd3dSceneContext1"));
  resolve=reinterpret_cast<Resolve>(GetProcAddress(translator,"MacLauncherVkd3dResolveSceneImage1"));
  record=reinterpret_cast<Record>(GetProcAddress(translator,"MacLauncherVkd3dRecordScene2"));
  auto api=reinterpret_cast<RSWineVulkanSceneAPICall1>(GetProcAddress(wine,"MacLauncherWineVulkanSceneAPI1"));
  auto control=reinterpret_cast<RSWineVulkanSceneContextCall1>(GetProcAddress(wine,"MacLauncherWineVulkanSceneContext1"));
  if(context&&resolve&&record&&api&&api()==1&&control)producer=std::make_unique<Producer>(observer,feature,control,submit,this);
 }
 ~CommandBridge(){producer.reset();clear();if(wine)FreeLibrary(wine);if(translator)FreeLibrary(translator);}
 bool connected()const{return bool(producer);}
 CommandBridge(const CommandBridge&)=delete;CommandBridge&operator=(const CommandBridge&)=delete;
 bool image(ID3D12Resource*resource,Image&out){
  Image resolved;
  // NGX resources are the actual base 2D attachments; array/mip views require
  // an explicit producer extension rather than guessing a selected slice.
  const auto desc=resource->GetDesc();if(desc.DepthOrArraySize!=1)return false;
  if(resolve(resource,0,0,0,&resolved.binding,&resolved.width,&resolved.height)!=0)return false;
  for(const auto&r:resources)if(same(r.image.binding,resolved.binding)){
   if(r.value!=resource)return false;out=resolved;return true;
  }
  resources.push_back({resolved,resource});resource->AddRef();out=resolved;return true;
 }
 template<class Parameters>Status observe(ID3D12GraphicsCommandList*list,const Parameters&parameters,Evaluation source,int32_t&result){
  if(!producer||!list)return Status::Unavailable;
  clear();commands=list;recordingAttempted=false;
  if(context(list,&source.device,&source.commands)!=0)return Status::Invalid;
  ParameterReader<Parameters,ID3D12Resource,CommandBridge>reader(parameters,*this);
  if(!readParameters(reader,source)){clear();return Status::Unavailable;}
  const Image*primary[]={&source.color,&source.depth,&source.motion,&source.output,&source.exposure};
  for(unsigned slot=0;slot<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++slot){
   const auto&expected=source.expectedImages[slot];if(!expected.image)continue;
   const Image*actual=slot<5?primary[slot]:slot>=RS_WINE_SCENE_AOV_FIRST?&source.guides[slot-RS_WINE_SCENE_AOV_FIRST]:nullptr;
   if(!actual||!same(expected,actual->binding)){clear();commands=nullptr;return Status::Unavailable;}
  }
  auto status=producer->observe(source,result);clear();commands=nullptr;
  if(status==Status::Failed&&!recordingAttempted&&result!=-4)return Status::Unavailable;
  return status;
 }
};
}
#endif
