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
struct PreparedRecording {
 AdmissionStatus admission=AdmissionStatus::Unavailable;
 Status recording=Status::Unavailable;
 int32_t nativeResult=0;
};
// PE-only connection to the actual command-list implementation, located by its
// own COM method address. No backend name or filename selects the translator.
class CommandBridge {
 // Streamline's documented third-party native-interface query returns an
 // owned underlying interface of the same kind. Never pass its proxy into a
 // translator's implementation-specific typed export.
 inline static constexpr GUID nativeInterfaceId={0xadec44e2,0x61f0,0x45c3,{0xad,0x9f,0x1b,0x37,0x37,0x92,0x84,0xff}};
 template<class T>class NativeReference {
  T*value=nullptr;
 public:
  explicit NativeReference(T*source){
   if(!source)return;
   const auto status=source->QueryInterface(nativeInterfaceId,reinterpret_cast<void**>(&value));
   if(FAILED(status)){
    if(value){value->Release();value=nullptr;}
    if(status==E_NOINTERFACE){source->AddRef();value=source;}
   }
  }
  ~NativeReference(){if(value)value->Release();}
  NativeReference(const NativeReference&)=delete;NativeReference&operator=(const NativeReference&)=delete;
  T*get()const{return value;}
 };
 using Context=int32_t(WINAPI*)(ID3D12GraphicsCommandList*,uint64_t*,uint64_t*);
 using Resolve=int32_t(WINAPI*)(ID3D12Resource*,uint32_t,uint32_t,uint32_t,RSWineVulkanSceneImageV1*,uint32_t*,uint32_t*);
 using Record=int32_t(WINAPI*)(ID3D12GraphicsCommandList*,const RSWineVulkanSceneRequestV2*,ID3D12Resource*const*);
 HMODULE translator=nullptr,wine=nullptr;
 Context context=nullptr;Resolve resolve=nullptr;Record record=nullptr;
 RSWineVulkanScenePrepareCall3 prepareCall=nullptr;
 RSWineVulkanSceneCancelCall3 cancelCall=nullptr;
 RSWineVulkanSceneQueryCall3 queryCall=nullptr;
 ID3D12GraphicsCommandList*commands=nullptr;bool recordingAttempted=false;
 struct Resource {Image image;ID3D12Resource*value;};std::vector<Resource>resources;
 std::unique_ptr<Producer>producer;
 template<class T>bool owns(T*value)const{
  if(!value||!translator)return false;
  HMODULE owner=nullptr;void*method=(*reinterpret_cast<void***>(value))[0];
  return GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(method),&owner)&&owner==translator;
 }
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
  NativeReference<ID3D12GraphicsCommandList>actual(list);if(!actual.get())return;
  void*method=(*reinterpret_cast<void***>(actual.get()))[0];
  if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,reinterpret_cast<LPCWSTR>(method),&translator)||
     !GetModuleHandleExW(0,L"winevulkan.dll",&wine))return;
  context=reinterpret_cast<Context>(GetProcAddress(translator,"MacLauncherVkd3dSceneContext1"));
  resolve=reinterpret_cast<Resolve>(GetProcAddress(translator,"MacLauncherVkd3dResolveSceneImage1"));
  record=reinterpret_cast<Record>(GetProcAddress(translator,"MacLauncherVkd3dRecordScene2"));
  auto api=reinterpret_cast<RSWineVulkanSceneAPICall1>(GetProcAddress(wine,"MacLauncherWineVulkanSceneAPI1"));
  auto control=reinterpret_cast<RSWineVulkanSceneContextCall1>(GetProcAddress(wine,"MacLauncherWineVulkanSceneContext1"));
  prepareCall=reinterpret_cast<RSWineVulkanScenePrepareCall3>(GetProcAddress(wine,"MacLauncherWineVulkanPrepareScene3"));
  cancelCall=reinterpret_cast<RSWineVulkanSceneCancelCall3>(GetProcAddress(wine,"MacLauncherWineVulkanCancelScene3"));
  queryCall=reinterpret_cast<RSWineVulkanSceneQueryCall3>(GetProcAddress(wine,"MacLauncherWineVulkanQueryScene3"));
  if(context&&resolve&&record&&api&&api()==1&&control)producer=std::make_unique<Producer>(observer,feature,control,submit,this);
 }
 ~CommandBridge(){producer.reset();clear();if(wine)FreeLibrary(wine);if(translator)FreeLibrary(translator);}
 bool connected()const{return bool(producer);}
 CommandBridge(const CommandBridge&)=delete;CommandBridge&operator=(const CommandBridge&)=delete;
 template<class Parameters>QueryStatus queryFeature(ID3D12GraphicsCommandList*list,const Parameters&parameters,Feature feature,int32_t&result){
  if(!producer||!queryCall||!list)return QueryStatus::Unavailable;
  NativeReference<ID3D12GraphicsCommandList>actual(list);if(!owns(actual.get()))return QueryStatus::Unavailable;
  Evaluation shape;shape.feature=feature;uint64_t commands=0;
  if(context(actual.get(),&shape.device,&commands)!=0)return QueryStatus::Invalid;
  ParameterReader<Parameters,ID3D12Resource,CommandBridge>reader(parameters,*this);
  if(!readCreation(reader,shape))return QueryStatus::Invalid;
  return producer->query(shape,queryCall,result);
 }
 bool image(ID3D12Resource*resource,Image&out){
  NativeReference<ID3D12Resource>actual(resource);resource=actual.get();if(!owns(resource))return false;
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
 template<class Parameters>Status readInputs(ID3D12GraphicsCommandList*list,const Parameters&parameters,Evaluation&source){
  if(!producer||!list)return Status::Unavailable;
  clear();commands=list;recordingAttempted=false;
  if(context(list,&source.device,&source.commands)!=0){commands=nullptr;return Status::Invalid;}
  ParameterReader<Parameters,ID3D12Resource,CommandBridge>reader(parameters,*this);
  if(!readParameters(reader,source)){clear();commands=nullptr;return Status::Unavailable;}
  const Image*primary[]={&source.color,&source.depth,&source.motion,&source.output,&source.exposure};
  for(unsigned slot=0;slot<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++slot){
   const auto&expected=source.expectedImages[slot];if(!expected.image)continue;
   const Image*actual=slot<5?primary[slot]:slot>=RS_WINE_SCENE_AOV_FIRST?&source.guides[slot-RS_WINE_SCENE_AOV_FIRST]:nullptr;
   if(!actual||!same(expected,actual->binding)){clear();commands=nullptr;return Status::Unavailable;}
  }
  return Status::Recorded;
 }
 template<class Parameters>Status observe(ID3D12GraphicsCommandList*list,const Parameters&parameters,Evaluation source,int32_t&result){
  if(!producer)return Status::Unavailable;
  NativeReference<ID3D12GraphicsCommandList>actual(list);if(!owns(actual.get()))return Status::Unavailable;
  auto inputs=readInputs(actual.get(),parameters,source);if(inputs!=Status::Recorded)return inputs;
  auto status=producer->observe(source,result);clear();commands=nullptr;
  if(status==Status::Failed&&!recordingAttempted&&result!=-4)return Status::Unavailable;
  return status;
 }
 // This connects actual typed resources to command-free admission and the
 // normal translator recording boundary. Neither field is SDK output success;
 // its wrapper still needs the actual requested-output fulfillment contract.
 template<class Parameters>PreparedRecording prepareRecord(ID3D12GraphicsCommandList*list,const Parameters&parameters,Evaluation source){
  PreparedRecording result;
  if(!prepareCall||!cancelCall)return result;
  NativeReference<ID3D12GraphicsCommandList>actual(list);if(!owns(actual.get()))return result;
  auto inputs=readInputs(actual.get(),parameters,source);
  if(inputs!=Status::Recorded){result.admission=inputs==Status::Invalid?AdmissionStatus::Invalid:AdmissionStatus::Unavailable;return result;}
  result.admission=producer->prepare(source,prepareCall,cancelCall,result.nativeResult);
  if(result.admission==AdmissionStatus::Prepared)result.recording=producer->recordPrepared(result.nativeResult);
  clear();commands=nullptr;return result;
 }
};
}
#endif
