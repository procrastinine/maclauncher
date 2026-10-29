// Copyright (c) MacLauncher contributors. MIT license.
#include "temporal-plan.hpp"
#include "generation-provider.hpp"
#include "scene-frame.h"
#include "temporal-controls.hpp"
#include "scene-matrices.hpp"
#include "runtime-status.hpp"
#import <objc/runtime.h>
#include <vector>
#include <algorithm>
#include <mutex>
#include <map>
@interface RSMTemporalDrawable : NSObject { @public __weak id<CAMetalDrawable> drawable; }
@end
@implementation RSMTemporalDrawable
@end
struct TemporalRecord {
    id<MTLTexture> output;
    RSMTemporalDrawable *registration;
    macfx::TemporalPlanReceipt receipt;
    bool blocked=false,consumed=false;
    void*explicitOwner=nullptr;uint64_t explicitFrameId=0;std::shared_ptr<void>deferred;
};
@interface RSMTemporalReceipts : NSObject { @public std::vector<TemporalRecord> records; }
@end
@implementation RSMTemporalReceipts
@end
namespace macfx {
namespace {
const char drawableKey=0,receiptsKey=0;
id<MTLTexture> base(id<MTLTexture> image){for(unsigned i=0;i<8&&image.parentTexture;++i)image=image.parentTexture;return image;}
RSMTemporalReceipts *receipts(id<MTLCommandBuffer> commands,bool create) {
    auto value=(RSMTemporalReceipts*)objc_getAssociatedObject(commands,&receiptsKey);
    if(!value&&create){value=[RSMTemporalReceipts new];objc_setAssociatedObject(commands,&receiptsKey,value,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
    return value;
}
bool current(const TemporalRecord &record) {
    if(record.explicitOwner&&record.explicitFrameId)return true;
    auto drawable=record.registration?record.registration->drawable:nil;
    return drawable&&drawable.texture==record.output&&
        objc_getAssociatedObject(record.output,&drawableKey)==record.registration;
}
struct DeferredObserver {dispatch_queue_t queue=nullptr;std::function<void(ShaderResult)>callback;};
void notifyDeferred(std::vector<DeferredObserver>observers,ShaderResult result){for(auto&observer:observers){auto callback=std::move(observer.callback);dispatch_async(observer.queue,^{callback(result);});}}
struct Deferred final:DeferredTemporalOutput {
 std::mutex mutex;__weak id<MTLTexture>output;__weak id<MTLCommandBuffer>waitingConsumer;RSMTemporalDrawable*registration=nil;void*owner=nullptr,*retirementScope=nullptr;TemporalPlanReceipt receipt;id<MTLSharedEvent>event=nil;uint64_t value=0;int decision=0;bool consumed=false,canceled=false;std::vector<DeferredObserver>observers;ShaderResult terminal{false,"The Metal 4 scene work is pending",true};
 ~Deferred(){notifyDeferred(std::move(observers),{false,"The deferred Metal 4 frame was retired before publication"});}
 void submitted(bool accepted,id<MTLSharedEvent>signal,uint64_t at)override{std::vector<DeferredObserver>ready;{std::lock_guard guard(mutex);if(canceled)accepted=false;decision=accepted?1:-1;event=accepted?signal:nil;value=accepted?at:0;if(!accepted){canceled=true;terminal={false,"The original Metal 4 recording was retained"};ready.swap(observers);}}if(!accepted)notifyDeferred(std::move(ready),{false,"The original Metal 4 recording was retained"});}
 void completed(ShaderResult result)override{std::vector<DeferredObserver>ready;{std::lock_guard guard(mutex);if(!canceled)terminal=result;else result=terminal;if(!result.busy)ready.swap(observers);}notifyDeferred(std::move(ready),std::move(result));}
};
auto&deferredMutex=*new std::mutex;auto&deferred=*new std::map<void*,std::shared_ptr<Deferred>>;auto&allDeferred=*new std::vector<std::weak_ptr<Deferred>>;
}
std::shared_ptr<DeferredTemporalOutput>deferTemporalOutput(id<MTLTexture>output,TemporalPlanReceipt receipt,void*owner){return deferTemporalOutputForScope(output,std::move(receipt),owner,owner);}
std::shared_ptr<DeferredTemporalOutput>deferTemporalOutputForScope(id<MTLTexture>output,TemporalPlanReceipt receipt,void*owner,void*retirementScope){
 if(!output||!receipt.execution||!receipt.frameId)return {};auto registration=(RSMTemporalDrawable*)objc_getAssociatedObject(output,&drawableKey);if(!registration&&!owner)return {};
 auto record=std::make_shared<Deferred>();record->output=output;record->registration=registration;record->owner=owner;record->retirementScope=retirementScope;record->receipt=std::move(receipt);
 std::lock_guard guard(deferredMutex);for(auto it=deferred.begin();it!=deferred.end();)if(!it->second->output)it=deferred.erase(it);else ++it;auto key=(__bridge void*)output;if(deferred.size()>=64&&!deferred.count(key))return {};deferred[key]=record;allDeferred.erase(std::remove_if(allDeferred.begin(),allDeferred.end(),[](const auto&item){return item.expired();}),allDeferred.end());allDeferred.push_back(record);return record;
}
void clearDeferredTemporalOutputs(void*owner){std::vector<std::shared_ptr<Deferred>>retired;{std::lock_guard guard(deferredMutex);for(auto it=allDeferred.begin();it!=allDeferred.end();){if(auto record=it->lock()){if(record->owner==owner||record->retirementScope==owner)retired.push_back(std::move(record));++it;}else it=allDeferred.erase(it);}for(auto it=deferred.begin();it!=deferred.end();)if(it->second->owner==owner||it->second->retirementScope==owner)it=deferred.erase(it);else ++it;}for(auto&record:retired)record->submitted(false,nil,0);}
bool deferredTemporalOutputHasEventConsumer(const std::shared_ptr<DeferredTemporalOutput>&value){auto record=std::dynamic_pointer_cast<Deferred>(value);if(!record)return false;std::lock_guard guard(record->mutex);auto consumer=record->waitingConsumer;return record->decision>0&&record->event&&record->value&&(record->consumed||(consumer&&consumer.status!=MTLCommandBufferStatusError));}
bool observeDeferredTemporalOutput(id<MTLCommandBuffer>consumer,id<MTLTexture>output,uint64_t expectedFrameId,dispatch_queue_t queue,std::function<void(ShaderResult)>callback){
 if(!output||!consumer||consumer.status>=MTLCommandBufferStatusCommitted||!consumer.retainedReferences||consumer.device!=output.device||!queue||!callback)return false;output=base(output);std::shared_ptr<Deferred>record;{std::lock_guard guard(deferredMutex);auto found=deferred.find((__bridge void*)output);if(found==deferred.end())return false;record=found->second;}
 std::vector<DeferredObserver>ready;ShaderResult result;@synchronized(consumer){{std::lock_guard guard(record->mutex);if(record->consumed||record->decision<=0||!record->event||!record->value||(!record->terminal.busy&&!record->terminal.encoded))return false;if(expectedFrameId){if(expectedFrameId!=record->receipt.frameId)return false;}else if(!record->registration||!record->registration->drawable||record->registration->drawable.texture!=output||objc_getAssociatedObject(output,&drawableKey)!=record->registration)return false;
 auto list=receipts(consumer,true);const bool pinned=std::any_of(list->records.begin(),list->records.end(),[&](const auto&item){return item.deferred.get()==record.get();});if(!pinned){TemporalRecord pin;pin.output=output;pin.registration=record->registration;pin.explicitOwner=record.get();pin.explicitFrameId=record->receipt.frameId;pin.deferred=record;list->records.push_back(std::move(pin));[consumer addCompletedHandler:^(id<MTLCommandBuffer>done){@synchronized(done){if(auto held=receipts(done,false))for(auto&item:held->records){item.deferred.reset();item.receipt={};}}}];}
 if(record->decision>0&&record->event&&record->value){[consumer encodeWaitForEvent:record->event value:record->value];record->waitingConsumer=consumer;}
 DeferredObserver observer{queue,std::move(callback)};if(record->terminal.busy)record->observers.push_back(std::move(observer));else{result=record->terminal;ready.push_back(std::move(observer));}}}
 notifyDeferred(std::move(ready),std::move(result));return true;
}
std::optional<ShaderFrame>temporalOutputSourceFrame(id<MTLCommandBuffer>commands,id<MTLTexture>output){
 if(!commands||!output)return {};output=base(output);@synchronized(commands){if(auto list=receipts(commands,false))for(const auto&item:list->records)if(item.output==output&&!item.blocked&&current(item)){
  if(item.deferred){auto record=std::static_pointer_cast<Deferred>(item.deferred);std::lock_guard guard(record->mutex);return record->receipt.sourceFrame;}return item.receipt.sourceFrame;
 }}return {};
}
TemporalPlanReceipt takeDeferredTemporalOutput(id<MTLCommandBuffer>commands,id<MTLTexture>output,uint64_t expectedFrameId){
 std::shared_ptr<Deferred>record;@synchronized(commands){if(auto list=receipts(commands,false))for(const auto&item:list->records)if(item.output==output&&item.deferred&&!item.blocked&&!item.consumed){record=std::static_pointer_cast<Deferred>(item.deferred);if(!expectedFrameId)expectedFrameId=item.explicitFrameId;break;}}if(!record){std::lock_guard guard(deferredMutex);auto found=deferred.find((__bridge void*)output);if(found==deferred.end())return {};record=found->second;}
 std::lock_guard guard(record->mutex);if(record->consumed||record->decision<0||!commands||commands.status>=MTLCommandBufferStatusCommitted||commands.device!=output.device||!commands.retainedReferences)return {};
 if(expectedFrameId){if(expectedFrameId!=record->receipt.frameId)return {};}else if(!record->registration||!record->registration->drawable||record->registration->drawable.texture!=output||objc_getAssociatedObject(output,&drawableKey)!=record->registration)return {};
 if(!record->decision){TemporalPlanReceipt result;result.preparing=true;result.frameId=record->receipt.frameId;result.reason="Waiting for the actual Metal 4 scene submission";return result;}
 if(!record->event||!record->value)return {};
 // Actual known submission authorizes an event dependency, not successful
 // prefix metadata. A caller can register its exact wait while preserving its
 // complete previous image until GPU publication has actually succeeded.
 if(!record->terminal.encoded){TemporalPlanReceipt pending;pending.preparing=true;pending.frameId=record->receipt.frameId;pending.reason=record->terminal.reason;if(record->terminal.busy){[commands encodeWaitForEvent:record->event value:record->value];record->waitingConsumer=commands;}return pending;}
 if(record->receipt.completion){auto ready=record->receipt.completion();if(!ready.encoded){TemporalPlanReceipt pending;pending.preparing=true;pending.reason=ready.reason;return pending;}}
 [commands encodeWaitForEvent:record->event value:record->value];record->waitingConsumer=commands;record->consumed=true;{std::lock_guard index(deferredMutex);auto found=deferred.find((__bridge void*)output);if(found!=deferred.end()&&found->second==record)deferred.erase(found);}auto result=record->receipt;auto complete=result.completion;result.completion=[record,complete]{std::lock_guard guard(record->mutex);if(!record->terminal.encoded&&!record->terminal.busy)return record->terminal;return complete?complete():ShaderResult{true,{}};};return result;
}
bool reserveExplicitTemporalOutput(id<MTLCommandBuffer>commands,id<MTLTexture>output,void*owner,uint64_t frameId){
    if(!commands||!output||!owner||!frameId||output.device!=commands.device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return false;
    @synchronized(commands){auto list=receipts(commands,true);for(auto&record:list->records)if(record.output==output){if(record.explicitOwner==owner&&record.explicitFrameId==frameId&&!record.blocked&&!record.consumed&&record.receipt.preparing&&!record.receipt.execution){record.receipt={};return true;}record.blocked=true;record.receipt={};return false;}
        if(list->records.size()>=8)return false;TemporalRecord record;record.output=output;record.explicitOwner=owner;record.explicitFrameId=frameId;list->records.push_back(std::move(record));return true;
    }
}
void registerTemporalDrawable(id<CAMetalDrawable> drawable) {
    if(!drawable||!effectPlanDemands(PlanDemandTemporal))return;
    auto owner=[RSMTemporalDrawable new];owner->drawable=drawable;
    objc_setAssociatedObject(drawable.texture,&drawableKey,owner,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
bool reserveTemporalOutput(id<MTLCommandBuffer> commands,id<MTLTexture> output) {
    if(!commands||!output||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return false;
    @synchronized(commands) {
        auto owner=(RSMTemporalDrawable*)objc_getAssociatedObject(output,&drawableKey);
        if(!owner||!owner->drawable||owner->drawable.texture!=output)return false;
        auto list=receipts(commands,true);
        for(auto &record:list->records)if(record.output==output){record.blocked=true;record.receipt={};return false;}
        if(list->records.size()>=8)return false;
        list->records.push_back({output,owner,{},false,false});return true;
    }
}
void publishTemporalOutput(id<MTLCommandBuffer> commands,id<MTLTexture> output,uint64_t frameId,std::shared_ptr<EffectExecution> execution,std::shared_ptr<FrameCapture> capture) {
    publishTemporalOutputWithDepth(commands,output,frameId,std::move(execution),std::move(capture),nullptr);
}
void publishTemporalOutputWithDepth(id<MTLCommandBuffer> commands,id<MTLTexture> output,uint64_t frameId,std::shared_ptr<EffectExecution> execution,std::shared_ptr<FrameCapture> capture,const DepthFrame*depth) {
    publishTemporalOutputWithDepth(commands,output,frameId,std::move(execution),std::move(capture),depth,false);
}
void publishTemporalOutputWithDepth(id<MTLCommandBuffer> commands,id<MTLTexture> output,uint64_t frameId,std::shared_ptr<EffectExecution> execution,std::shared_ptr<FrameCapture> capture,const DepthFrame*depth,bool displayMapped,const RSTemporalFrame*scene) {
    @synchronized(commands) {auto list=receipts(commands,false);if(!list)return;
        for(auto &record:list->records)if(record.output==output&&!record.blocked&&!record.consumed&&current(record)){
            record.receipt={std::move(execution),frameId,std::move(capture),depth?*depth:DepthFrame{nil,0,FrameOrigin::TopLeft}};
            record.receipt.displayMapped=displayMapped;record.receipt.scene=record.receipt.execution?record.receipt.execution->captureSceneLease(commands):nullptr;
            record.receipt.inputs=scene?temporalSceneInputMask(*scene):depth&&depth->texture?RuntimeInputDepth:0;
            [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){@synchronized(completed){auto retained=receipts(completed,false);if(retained)for(auto &item:retained->records)item.receipt={};}}];return;
        }
    }
}
bool hasTemporalOutput(id<MTLCommandBuffer> commands,id<MTLTexture> output) {
    output=base(output);
    @synchronized(commands) {auto list=receipts(commands,false);if(list)for(const auto &record:list->records)
        if(record.output==output&&!record.blocked&&!record.consumed&&(record.deferred||record.receipt.execution||record.receipt.preparing)&&current(record))return true;
    }return false;
}
void publishTemporalPreparation(id<MTLCommandBuffer> commands,id<MTLTexture> output,uint64_t frameId,const std::string&reason){
    @synchronized(commands){auto list=receipts(commands,false);if(!list)return;for(auto &record:list->records)if(record.output==output&&!record.blocked&&!record.consumed&&current(record)){
        record.receipt={};record.receipt.frameId=frameId;record.receipt.preparing=true;record.receipt.reason=reason;
        [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){@synchronized(completed){auto retained=receipts(completed,false);if(retained)for(auto&item:retained->records)item.receipt={};}}];return;
    }}
}
TemporalPlanReceipt takeTemporalOutput(id<MTLCommandBuffer> commands,id<MTLTexture> output) {
    output=base(output);
    @synchronized(commands) {auto list=receipts(commands,false);if(list)for(auto &record:list->records)
        if(record.output==output&&!record.blocked&&!record.consumed&&current(record)){
            if(record.deferred)return takeDeferredTemporalOutput(commands,output,record.explicitFrameId);record.consumed=true;return std::move(record.receipt);
        }
    }return takeDeferredTemporalOutput(commands,output);
}
// The reader's demand for this plan: one load, and no work without a plan.
bool temporalPlanRequested() noexcept {return effectPlanDemands(PlanDemandTemporal);}
}
extern "C" uint32_t rsGetSceneFrameDemand(uint32_t version){
    if(version!=1)return 0;
    if(macfx::effectPlanRequested())return macfx::effectPlanSceneFrameDemand();
    const auto temporal=[](uint32_t camera){return uint32_t(RS_SCENE_COLOR|RS_SCENE_DEPTH|RS_SCENE_MOTION|RS_SCENE_JITTER)|camera;};
    switch(macfx::temporalControls().method){
        case RS_TEMPORAL_METALFX:case RS_TEMPORAL_FSR4:case RS_TEMPORAL_XESS:return temporal(0);
        case RS_TEMPORAL_METALFX_DENOISED:return temporal(RS_SCENE_VIEW_MATRIX|RS_SCENE_PROJECTION_MATRIX);
        case RS_TEMPORAL_FSR2:case RS_TEMPORAL_FSR3:case RS_TEMPORAL_ASR:case RS_TEMPORAL_SGSR2:return temporal(RS_SCENE_CAMERA);
        default:return 0;
    }
}
