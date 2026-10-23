// Copyright (c) MacLauncher contributors. MIT license.
#include "temporal-plan.hpp"
#import <objc/runtime.h>
#include <vector>
#include <algorithm>
@interface RSMTemporalDrawable : NSObject { @public __weak id<CAMetalDrawable> drawable; }
@end
@implementation RSMTemporalDrawable
@end
struct TemporalRecord {
    id<MTLTexture> output;
    RSMTemporalDrawable *registration;
    macfx::TemporalPlanReceipt receipt;
    bool blocked=false,consumed=false;
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
    auto drawable=record.registration?record.registration->drawable:nil;
    return drawable&&drawable.texture==record.output&&
        objc_getAssociatedObject(record.output,&drawableKey)==record.registration;
}
}
void registerTemporalDrawable(id<CAMetalDrawable> drawable) {
    if(!drawable||!temporalPlanRequested())return;
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
    @synchronized(commands) {auto list=receipts(commands,false);if(!list)return;
        for(auto &record:list->records)if(record.output==output&&!record.blocked&&!record.consumed&&current(record)){
            record.receipt={std::move(execution),frameId,std::move(capture)};
            [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){@synchronized(completed){auto retained=receipts(completed,false);if(retained)for(auto &item:retained->records)item.receipt={};}}];return;
        }
    }
}
bool hasTemporalOutput(id<MTLCommandBuffer> commands,id<MTLTexture> output) {
    output=base(output);
    @synchronized(commands) {auto list=receipts(commands,false);if(list)for(const auto &record:list->records)
        if(record.output==output&&!record.blocked&&!record.consumed&&record.receipt.execution&&current(record))return true;
    }return false;
}
TemporalPlanReceipt takeTemporalOutput(id<MTLCommandBuffer> commands,id<MTLTexture> output) {
    output=base(output);
    @synchronized(commands) {auto list=receipts(commands,false);if(list)for(auto &record:list->records)
        if(record.output==output&&!record.blocked&&!record.consumed&&current(record)){
            record.consumed=true;return std::move(record.receipt);
        }
    }return {};
}
bool temporalPlanRequested() noexcept {
    if(!effectPlanRequested())return false;
    try{@autoreleasepool{
        // AppKit can query hooked drawables during late process teardown,
        // after main-thread TLS destructors. Keep this small metadata reader
        // alive like effectPlanMode; per-frame GPU owners still retire normally.
        static auto *const state=new EffectPlanState;
        state->poll();const auto document=state->snapshot();
        return document&&document->mode=="advanced"&&std::any_of(document->nodes.begin(),document->nodes.end(),[](const auto &node){return node.enabled&&node.kind=="temporal";});
    }}catch(...){return false;}
}
}
