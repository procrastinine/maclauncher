#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <dxgi1_2.h>
#include <d3d11.h>
#include <d3d12.h>
#include <atomic>
#include <memory>
#include <mutex>
namespace maclauncher::ngx {
inline bool sceneDestinationEnabled(){
 static const bool enabled=[](){char value[2];return GetEnvironmentVariableA("MACLAUNCHER_NGX_SCENE_DESTINATION_ENABLE",value,sizeof(value))==1&&value[0]=='1';}();
 return enabled;
}
// PE-local resource metadata, never a PE/Unix packet or native window pointer.
// Only the actual swapchain GetBuffer interception installs this authority.
inline constexpr GUID sceneDestinationId={0x33bd24ca,0xb106,0x4c24,{0x9c,0xee,0x86,0x1d,0xab,0x52,0xa9,0x41}};
struct SceneDestination: IUnknown {
 virtual HRESULT STDMETHODCALLTYPE window(uint64_t*)=0;
 virtual void STDMETHODCALLTYPE retire()=0;
};
namespace destination_detail {
template<class T>struct Reference {T*value=nullptr;~Reference(){if(value)value->Release();}T*operator->()const{return value;}void**output(){return reinterpret_cast<void**>(&value);}};
struct State {std::atomic<uint64_t>window{0};explicit State(uint64_t value):window(value){}};
class Lease final:public SceneDestination {
 std::atomic<ULONG>references{1};std::shared_ptr<State>state;
public:
 explicit Lease(std::shared_ptr<State>value):state(std::move(value)){}
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void**out)override{
  if(!out)return E_POINTER;*out=nullptr;
  if(id!=__uuidof(IUnknown)&&id!=sceneDestinationId)return E_NOINTERFACE;
  *out=static_cast<SceneDestination*>(this);AddRef();return S_OK;
 }
 ULONG STDMETHODCALLTYPE AddRef()override{return ++references;}
 ULONG STDMETHODCALLTYPE Release()override{const auto count=--references;if(!count)delete this;return count;}
 HRESULT STDMETHODCALLTYPE window(uint64_t*out)override{
  if(!out)return E_POINTER;*out=state->window.load(std::memory_order_acquire);
  return *out?S_OK:DXGI_ERROR_INVALID_CALL;
 }
 void STDMETHODCALLTYPE retire()override{state->window.store(0,std::memory_order_release);}
};
template<class Resource>SceneDestination*read(Resource*resource){
 IUnknown*stored=nullptr;UINT size=sizeof(stored);
 if(FAILED(resource->GetPrivateData(sceneDestinationId,&size,&stored))||size!=sizeof(stored)||!stored)return nullptr;
 SceneDestination*result=nullptr;
 stored->QueryInterface(sceneDestinationId,reinterpret_cast<void**>(&result));stored->Release();return result;
}
}
// One binding on the existing intercepted swapchain object. Resources retain
// the metadata lease, which holds no swapchain, resource, HWND or native window.
// Resize/destruction retires old leases even if an application retains buffers.
class SwapchainDestination {
 std::mutex mutex;destination_detail::Lease*lease=nullptr;
 void clear(){if(lease){lease->retire();lease->Release();lease=nullptr;}}
 template<class Resource>bool attachResource(Resource*resource,uint64_t hwnd){
  uint64_t previous=0;
  if(lease&&FAILED(lease->window(&previous)))clear();
  if(lease&&previous!=hwnd){clear();return false;}
  auto existing=destination_detail::read(resource);
  if(existing){uint64_t active=0;const bool ambiguous=SUCCEEDED(existing->window(&active))&&existing!=lease;
   if(ambiguous){existing->retire();clear();resource->SetPrivateDataInterface(sceneDestinationId,nullptr);existing->Release();return false;}
   existing->Release();
  }
  if(!lease)lease=new destination_detail::Lease(std::make_shared<destination_detail::State>(hwnd));
  return SUCCEEDED(resource->SetPrivateDataInterface(sceneDestinationId,lease));
 }
public:
 SwapchainDestination()=default;~SwapchainDestination(){clear();}
 SwapchainDestination(const SwapchainDestination&)=delete;SwapchainDestination&operator=(const SwapchainDestination&)=delete;
 void retire(){std::lock_guard guard(mutex);clear();}
 bool attach(IDXGISwapChain*chain,IUnknown*actualGetBufferResult)noexcept{try{
  if(!sceneDestinationEnabled())return false;
  if(!chain||!actualGetBufferResult)return false;
  destination_detail::Reference<IDXGISwapChain1>actual;HWND window=nullptr;
  if(FAILED(chain->QueryInterface(__uuidof(IDXGISwapChain1),actual.output()))){retire();return false;}
  const auto status=actual->GetHwnd(&window);
  if(FAILED(status)||!window){retire();return false;}
  std::lock_guard guard(mutex);
  destination_detail::Reference<ID3D12Resource>resource12;
  if(SUCCEEDED(actualGetBufferResult->QueryInterface(__uuidof(ID3D12Resource),resource12.output()))){
   return attachResource(resource12.value,uint64_t(reinterpret_cast<uintptr_t>(window)));
  }
  destination_detail::Reference<ID3D11Resource>resource11;
  if(SUCCEEDED(actualGetBufferResult->QueryInterface(__uuidof(ID3D11Resource),resource11.output()))){
   return attachResource(resource11.value,uint64_t(reinterpret_cast<uintptr_t>(window)));
  }
  return false;
 }catch(...){return false;}}
};
template<class Resource>bool sceneDestination(Resource*actualResource,uint64_t&hwnd){
 if(!sceneDestinationEnabled()||!actualResource)return false;auto authority=destination_detail::read(actualResource);if(!authority)return false;
 uint64_t value=0;const bool valid=SUCCEEDED(authority->window(&value))&&value;authority->Release();
 if(valid)hwnd=value;return valid;
}
}
