#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "command-bridge.hpp"
#include "scene-source.hpp"
#include <atomic>
#include <optional>
namespace maclauncher::ngx {
struct ObservationResult {Status status=Status::Unavailable;int32_t nativeResult=0;};
template<class Original,class Observer,class Result>Result evaluateWithObservation(Original&&original,Observer&&observer,Result success,Result failed){
 const auto result=original();if(result!=success)return result;
 try{const auto observed=observer();if(observed.status==Status::Failed&&observed.nativeResult<0)return failed;}
 catch(...){/* Optional preparation preserves the genuine original output. */}
 return result;
}
}
#ifdef _WIN32
namespace maclauncher::ngx {
inline thread_local std::optional<RSWineVulkanSceneRequestV2>activeSource;
// This is an observation scope, not a provider/feature availability export.
// Callers restore/clear it after the matching Evaluate, including failed calls.
inline int setSource(const RSWineVulkanSceneRequestV2*source){
 activeSource.reset();Evaluation checked;if(!source||!sourceEvaluation(*source,checked))return 0;
 activeSource=*source;return 1;
}
class DllObserver {
 inline static std::atomic<uint64_t>identities{1};
 std::unique_ptr<CommandBridge>bridge;
 void connect(ID3D12GraphicsCommandList*commands){
  if(!bridge||!bridge->connected()){const auto id=identities.fetch_add(1);if(id)bridge=std::make_unique<CommandBridge>(commands,id,1);}
 }
public:
 template<class Parameters>QueryStatus onCreate(ID3D12GraphicsCommandList*commands,const Parameters&parameters,Feature feature,int32_t&nativeResult){
  connect(commands);return bridge?bridge->queryFeature(commands,parameters,feature,nativeResult):QueryStatus::Unavailable;
 }
 template<class Parameters>Status afterOriginal(ID3D12GraphicsCommandList*commands,const Parameters&parameters,Feature feature,int32_t&nativeResult){
  if(!activeSource)return Status::Unavailable;
  Evaluation source;if(!sourceEvaluation(*activeSource,source))return Status::Unavailable;source.feature=feature;
  connect(commands);if(!bridge)return Status::Unavailable;
  return bridge->observe(commands,parameters,source,nativeResult);
 }
};
}
extern "C" __declspec(dllexport) int MacLauncherSetNgxSceneSource2(const RSWineVulkanSceneRequestV2*source){return maclauncher::ngx::setSource(source);}
extern "C" __declspec(dllexport) void MacLauncherClearNgxSceneSource2(){maclauncher::ngx::activeSource.reset();}
#endif
