// Copyright (c) MacLauncher contributors. MIT license.
// Five-export ABI proxy. Original contexts, callbacks, descriptor chains and
// provider queries remain authoritative, including all FG/swapchain operations.
#define NOMINMAX
#include <windows.h>
#include "capture.hpp"
#include "observation.h"
#include "wine-observer.hpp"
#include "profile.hpp"
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
namespace {
HMODULE selfModule=nullptr;
INIT_ONCE originalOnce=INIT_ONCE_STATIC_INIT;
HMODULE originalModule=nullptr;
BOOL CALLBACK loadOriginal(PINIT_ONCE,PVOID,PVOID*){
 wchar_t file[32768];const DWORD length=GetModuleFileNameW(selfModule,file,32768);if(!length||length>=32768)return TRUE;
 std::wstring name(file,length);const auto slash=name.find_last_of(L"\\/");if(slash==std::wstring::npos)return TRUE;
 name.resize(slash+1);name+=maclauncherOriginalLibrary;
 originalModule=LoadLibraryExW(name.c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);return TRUE;
}
template<class T>T original(const char*name){InitOnceExecuteOnce(&originalOnce,loadOriginal,nullptr,nullptr);return originalModule?reinterpret_cast<T>(GetProcAddress(originalModule,name)):nullptr;}
struct Context {maclauncher::fidelityfx::UpscaleContext metadata;uint64_t identity=0;std::atomic<uint64_t>ordinal{0};};
std::atomic<uint64_t>nextContext{1};
std::mutex contextsLock;
std::unordered_map<ffxContext,std::shared_ptr<Context>>contexts;
std::shared_ptr<Context>lookup(ffxContext key)noexcept{try{std::lock_guard lock(contextsLock);const auto found=contexts.find(key);return found==contexts.end()?nullptr:found->second;}catch(...){return {};}}
void forget(ffxContext key,const std::shared_ptr<Context>&expected)noexcept{try{std::lock_guard lock(contextsLock);const auto found=contexts.find(key);if(found!=contexts.end()&&found->second==expected)contexts.erase(found);}catch(...){}}
struct Observer {
 MLFfxObserverV1 value;
 explicit Observer(const MLFfxObserverV1&source):value(source){value.retain(value.storage);}
 ~Observer(){try{value.release(value.storage);}catch(...){}}
};
// Explicit unregister releases outside loader teardown. The empty registry
// itself has process lifetime and never owns an original SDK or GPU resource.
std::shared_ptr<Observer>&observer(){static auto*value=new std::shared_ptr<Observer>();return *value;}
std::shared_ptr<Observer>currentObserver()noexcept{try{return std::atomic_load(&observer());}catch(...){return {};}}
std::mutex observerSetLock;
bool observerExplicit=false;
std::once_flag observerBootstrap;
int ML_FFX_CALL setObserver(const MLFfxObserverV1*value){
 if(value&&(value->size!=sizeof(*value)||value->version!=1||!value->retain||!value->release||!value->observed))return 0;
 try{auto next=value?std::make_shared<Observer>(*value):nullptr;std::shared_ptr<Observer>previous;
  {std::lock_guard lock(observerSetLock);observerExplicit=true;previous=std::atomic_exchange(&observer(),std::move(next));}return 1;
 }catch(...){return 0;}
}
void ensureWineObserver()noexcept{
 try{std::call_once(observerBootstrap,[]{
  {std::lock_guard lock(observerSetLock);if(observerExplicit||currentObserver())return;}
  MLFfxObserverV1 value{};if(!maclauncher::fidelityfx::createWineObserver(value))return;
  try{auto next=std::make_shared<Observer>(value);std::shared_ptr<Observer>previous;
   {std::lock_guard lock(observerSetLock);if(!observerExplicit&&!currentObserver())previous=std::atomic_exchange(&observer(),std::move(next));}
  }catch(...){}
  value.release(value.storage);
 });}catch(...){}
}
}
extern "C" __declspec(dllexport) const MLFfxObservationAPIV1* ML_FFX_CALL MacLauncherFFXObservationAPI1(){static const MLFfxObservationAPIV1 api{sizeof(api),1,setObserver};return &api;}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){selfModule=module;DisableThreadLibraryCalls(module);}return TRUE;}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxCreateContext(ffxContext*context,ffxCreateContextDescHeader*desc,const ffxAllocationCallbacks*callbacks){
 const auto call=original<PfnFfxCreateContext>("ffxCreateContext");if(!call)return FFX_API_RETURN_NO_PROVIDER;
 const auto result=call(context,desc,callbacks);
 if(result==FFX_API_RETURN_OK&&context&&*context){try{auto next=std::make_shared<Context>();next->identity=nextContext.fetch_add(1,std::memory_order_relaxed);next->metadata=maclauncher::fidelityfx::captureContext(desc);
  {std::lock_guard lock(contextsLock);contexts[*context]=next;}
  if(next->metadata.vulkan)ensureWineObserver();
 }catch(...){}}
 return result;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxDestroyContext(ffxContext*context,const ffxAllocationCallbacks*callbacks){
 const auto call=original<PfnFfxDestroyContext>("ffxDestroyContext");if(!call)return FFX_API_RETURN_NO_PROVIDER;
 const auto previous=context?*context:nullptr;const auto current=lookup(previous);const auto result=call(context,callbacks);if(result==FFX_API_RETURN_OK){forget(previous,current);auto target=currentObserver();if(current&&target&&target->value.destroyed)try{target->value.destroyed(target->value.storage,current->identity,previous);}catch(...){}}return result;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxConfigure(ffxContext*context,const ffxConfigureDescHeader*desc){
 const auto call=original<PfnFfxConfigure>("ffxConfigure");return call?call(context,desc):FFX_API_RETURN_NO_PROVIDER;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxQuery(ffxContext*context,ffxQueryDescHeader*desc){
 const auto call=original<PfnFfxQuery>("ffxQuery");return call?call(context,desc):FFX_API_RETURN_NO_PROVIDER;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxDispatch(ffxContext*context,const ffxDispatchDescHeader*desc){
 const auto call=original<PfnFfxDispatch>("ffxDispatch");if(!call)return FFX_API_RETURN_NO_PROVIDER;
 const auto previous=context?*context:nullptr;const auto current=lookup(previous);
 // Recording capability alone cannot authorize skipping the original. An
 // optional owned observer uses only the matching Wine PE interface;
 // PE Vulkan wrappers and callbacks are never cast to native Metal or ICD ABI.
 const auto result=call(context,desc);
 if(result==FFX_API_RETURN_OK&&current&&desc&&desc->type==FFX_API_DISPATCH_DESC_TYPE_UPSCALE){
  const auto identity=current->ordinal.fetch_add(1,std::memory_order_relaxed)+1;auto target=currentObserver();
  if(target&&context&&*context==previous){try{maclauncher::fidelityfx::UpscaleDispatch source;if(maclauncher::fidelityfx::captureDispatch(current->metadata,desc,identity,source)){
    MLFfxUpscaleObservationV1 value{};value.size=sizeof(value);value.version=1;value.originalContext=previous;value.contextId=current->identity;value.contentId=identity;value.create=source.context.create;value.backend=source.context.backend;value.dispatch=source.dispatch;target->value.observed(target->value.storage,&value);
  }}catch(...){}}
 }
 return result;
}
