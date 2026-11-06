#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "routing.hpp"
namespace maclauncher::ngx {
// The translator feature owns a native context token. Recorded flights keep
// their existing native references after this recording owner is retired.
class Producer {
 RSWineVulkanSceneContextCall1 control;
 RSWineVulkanSceneRecordCall2 sink;
 uint64_t observer,identity,device=0,generation=0,consumer=0,lastFrame=0;
 bool retired=false;
 RSWineVulkanSceneContextV1 request(uint32_t operation)const {
  RSWineVulkanSceneContextV1 r{};r.size=sizeof(r);r.version=1;r.profile=RS_WINE_VULKAN_SCENE_PROFILE;
  r.operation=operation;r.observerId=observer;r.contextId=identity;r.device=device;r.generation=generation;r.consumerId=consumer;return r;
 }
public:
 Producer(uint64_t observerId,uint64_t featureId,RSWineVulkanSceneContextCall1 context,RSWineVulkanSceneRecordCall2 record):control(context),sink(record),observer(observerId),identity(featureId){}
 Producer(const Producer&)=delete;Producer&operator=(const Producer&)=delete;
 ~Producer(){retire();}
 void retire(){if(retired)return;retired=true;if(control&&generation){auto r=request(RS_WINE_SCENE_CONTEXT_DESTROY);control(&r);}}
 Status observe(Evaluation source,int32_t&result){
  if(retired||!control||!sink||!observer||!identity)return Status::Unavailable;
  if(device&&device!=source.device)return Status::Invalid;
  if(source.frameId<=lastFrame)return Status::Invalid;
  source.generation=source.consumer=1;RSWineVulkanSceneRequestV2 packet{};
  auto status=map(source,packet);if(status!=Status::Recorded)return status;
  device=source.device;
  if(!generation||source.reset){
   uint32_t operation=generation?RS_WINE_SCENE_CONTEXT_RESET:RS_WINE_SCENE_CONTEXT_BEGIN;
   auto r=request(operation);result=control(&r);
   if(result!=0)return result==1||result==2?Status::Busy:result==-8?Status::Unavailable:Status::Failed;
   if(r.size!=sizeof(r)||r.version!=1||r.profile!=RS_WINE_VULKAN_SCENE_PROFILE||r.operation!=operation||
      r.observerId!=observer||r.contextId!=identity||r.device!=device||!r.generation||!r.consumerId||r.reserved[0]||r.reserved[1]){
    RSWineVulkanSceneContextV1 cancel{};cancel.size=sizeof(cancel);cancel.version=1;cancel.profile=RS_WINE_VULKAN_SCENE_PROFILE;
    cancel.operation=RS_WINE_SCENE_CONTEXT_UNREGISTER;cancel.observerId=observer;control(&cancel);retired=true;return Status::Failed;
   }
   generation=r.generation;consumer=r.consumerId;
  }
  source.generation=generation;source.consumer=consumer;status=record(source,sink,result);
  if(status==Status::Recorded)lastFrame=source.frameId;
  return status;
 }
};
}
