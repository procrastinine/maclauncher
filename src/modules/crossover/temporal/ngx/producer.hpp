#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "routing.hpp"
namespace maclauncher::ngx {
enum class AdmissionStatus {Prepared,Unavailable,Invalid,Busy,Failed};
enum class QueryStatus {Supported,Unavailable,Invalid,Busy,Failed};
// The translator feature owns a native context token. Recorded flights keep
// their existing native references after this recording owner is retired.
class Producer {
 RSWineVulkanSceneContextCall1 control;
 RSWineVulkanSceneRecordCall2 sink;
 using Recorder=int32_t(*)(void*,const RSWineVulkanSceneRequestV2*);
 Recorder recorder=nullptr;void*recordStorage=nullptr;
 uint64_t observer,identity,device=0,generation=0,consumer=0,lastFrame=0;
 bool retired=false;
 RSWineVulkanSceneCancelCall3 cancelAdmission=nullptr;
 RSWineVulkanSceneRequestV2 admission{};
 RSWineVulkanSceneContextV1 request(uint32_t operation)const {
  RSWineVulkanSceneContextV1 r{};r.size=sizeof(r);r.version=1;r.profile=RS_WINE_VULKAN_SCENE_PROFILE;
  r.operation=operation;r.observerId=observer;r.contextId=identity;r.device=device;r.generation=generation;r.consumerId=consumer;return r;
 }
 Status deviceContext(uint64_t actualDevice,bool reset,int32_t&result){
  if(!actualDevice||(device&&device!=actualDevice))return Status::Invalid;
  device=actualDevice;
  if(!generation||reset){
   discardAdmission();
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
  return Status::Recorded;
 }
 Status context(Evaluation&source,int32_t&result){
  if(source.frameId<=lastFrame)return Status::Invalid;
  source.generation=source.consumer=1;RSWineVulkanSceneRequestV2 packet{};
  auto status=map(source,packet);if(status!=Status::Recorded)return status;
  status=deviceContext(source.device,source.reset,result);
  if(status==Status::Recorded){source.generation=generation;source.consumer=consumer;}return status;
 }
 void discardAdmission(){
  if(admission.base.consumerId&&cancelAdmission)cancelAdmission(&admission);
  admission={};cancelAdmission=nullptr;
 }
public:
 Producer(uint64_t observerId,uint64_t featureId,RSWineVulkanSceneContextCall1 context,RSWineVulkanSceneRecordCall2 record):control(context),sink(record),observer(observerId),identity(featureId){}
 Producer(uint64_t observerId,uint64_t featureId,RSWineVulkanSceneContextCall1 context,Recorder record,void*storage):control(context),sink(nullptr),recorder(record),recordStorage(storage),observer(observerId),identity(featureId){}
 Producer(const Producer&)=delete;Producer&operator=(const Producer&)=delete;
 ~Producer(){retire();}
 void retire(){if(retired)return;discardAdmission();retired=true;if(control&&generation){auto r=request(RS_WINE_SCENE_CONTEXT_DESTROY);control(&r);}}
 QueryStatus query(const Evaluation&shape,RSWineVulkanSceneQueryCall3 queryCall,int32_t&result){
  if(retired||!control||!queryCall||!observer||!identity)return QueryStatus::Unavailable;
  if(shape.feature!=Feature::RayReconstruction&&shape.feature!=Feature::FrameGeneration)return QueryStatus::Unavailable;
  if(!shape.width||!shape.height||!shape.outputWidth||!shape.outputHeight||
     (shape.maxRenderWidth&&shape.width>shape.maxRenderWidth)||
     (shape.maxRenderHeight&&shape.height>shape.maxRenderHeight))return QueryStatus::Invalid;
  auto status=deviceContext(shape.device,false,result);
  if(status!=Status::Recorded)return status==Status::Busy?QueryStatus::Busy:status==Status::Invalid?QueryStatus::Invalid:status==Status::Failed?QueryStatus::Failed:QueryStatus::Unavailable;
  RSWineVulkanSceneRequestV2 packet{};auto&p=packet.base;auto&f=p.frame;
  p.size=sizeof(p);p.version=1;p.profile=RS_WINE_VULKAN_SCENE_PROFILE;
  p.flags=RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED;p.device=device;p.ownerId=generation;p.consumerId=consumer;
  f.method=shape.method;f.profile=shape.profile;f.renderWidth=shape.width;f.renderHeight=shape.height;
  f.maxRenderWidth=shape.maxRenderWidth?shape.maxRenderWidth:shape.width;
  f.maxRenderHeight=shape.maxRenderHeight?shape.maxRenderHeight:shape.height;
  f.outputWidth=shape.outputWidth;f.outputHeight=shape.outputHeight;
  f.flags=(shape.reversedDepth?RS_TEMPORAL_DEPTH_REVERSED:0)|(shape.infiniteDepth?RS_TEMPORAL_DEPTH_INFINITE:0)|
      (shape.jitteredMotion?RS_TEMPORAL_JITTERED_MOTION:0)|(shape.outputMotion?RS_TEMPORAL_OUTPUT_MOTION:0)|
      (shape.autoExposure?RS_TEMPORAL_AUTO_EXPOSURE:0);
  packet.metadata.size=sizeof(packet.metadata);packet.metadata.version=2;
  result=queryCall(&packet,shape.feature==Feature::RayReconstruction?2:3);
  return !result?QueryStatus::Supported:result==1||result==2?QueryStatus::Busy:result==-8?QueryStatus::Unavailable:result==-3?QueryStatus::Invalid:QueryStatus::Failed;
 }
 Status observe(Evaluation source,int32_t&result){
  if(retired||!control||(!sink&&!recorder)||!observer||!identity)return Status::Unavailable;
  discardAdmission();auto status=context(source,result);if(status!=Status::Recorded)return status;
  RSWineVulkanSceneRequestV2 packet{};
  if(recorder){
   status=map(source,packet);if(status!=Status::Recorded)return status;
   result=recorder(recordStorage,&packet);
   status=result==0?Status::Recorded:result==1||result==2?Status::Busy:result==-8?Status::Unavailable:Status::Failed;
  }else status=record(source,sink,result);
  if(status==Status::Recorded)lastFrame=source.frameId;
  return status;
 }
 // Preparation and command recording are deliberately distinct results. No
 // SDK wrapper can treat an AdmissionStatus::Prepared as fulfilled output.
 AdmissionStatus prepare(Evaluation source,RSWineVulkanScenePrepareCall3 prepareCall,
     RSWineVulkanSceneCancelCall3 cancelCall,int32_t&result){
  if(retired||!control||!prepareCall||!cancelCall||!observer||!identity)return AdmissionStatus::Unavailable;
  discardAdmission();auto status=context(source,result);
  if(status!=Status::Recorded)return status==Status::Busy?AdmissionStatus::Busy:status==Status::Invalid?AdmissionStatus::Invalid:status==Status::Failed?AdmissionStatus::Failed:AdmissionStatus::Unavailable;
  if(source.feature!=Feature::RayReconstruction)return AdmissionStatus::Unavailable;
  RSWineVulkanSceneRequestV2 packet{};map(source,packet);auto expected=packet;
  result=prepareCall(&packet,2);
  if(result)return result==1||result==2?AdmissionStatus::Busy:result==-8?AdmissionStatus::Unavailable:AdmissionStatus::Failed;
  const auto token=packet.base.consumerId;const bool replacement=packet.base.flags==0;
  packet.base.consumerId=expected.base.consumerId;packet.base.flags=expected.base.flags;
  if(!replacement||!token||token==expected.base.consumerId||std::memcmp(&packet,&expected,sizeof(packet))){
   packet.base.consumerId=token;packet.base.flags=0;cancelCall(&packet);return AdmissionStatus::Failed;
  }
  packet.base.consumerId=token;packet.base.flags=0;admission=packet;cancelAdmission=cancelCall;
  return AdmissionStatus::Prepared;
 }
 Status recordPrepared(int32_t&result){
  if(retired||!admission.base.consumerId||(!sink&&!recorder))return Status::Unavailable;
  result=recorder?recorder(recordStorage,&admission):sink(&admission);
  const auto frame=admission.base.frameId;discardAdmission();
  if(!result){lastFrame=frame;return Status::Recorded;}
  return result==1||result==2?Status::Busy:result==-8?Status::Unavailable:Status::Failed;
 }
};
}
