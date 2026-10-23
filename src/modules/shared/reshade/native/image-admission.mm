// Copyright (c) MacLauncher contributors. MIT license.
#include "image-admission.hpp"
#include "runtime-status.hpp"
#import <objc/runtime.h>
#include <map>
#include <mutex>
#include <string>
#include <atomic>
namespace {
struct DeviceImages {id<MTLDevice>device;std::mutex mutex;uint64_t committed=0,pending=0,external=0;explicit DeviceImages(id<MTLDevice>d):device(d){}};
struct RetiredImages {std::mutex mutex;std::shared_ptr<macfx::ImageReservation>head;};
std::atomic<bool>retiredPending{false};
RetiredImages&retiredImages(){static auto *value=new RetiredImages;return *value;}
std::shared_ptr<DeviceImages> images(id<MTLDevice>device){
    static std::mutex mutex;static std::map<uintptr_t,std::weak_ptr<DeviceImages>> devices;
    const auto key=reinterpret_cast<uintptr_t>((__bridge void*)device);std::lock_guard lock(mutex);
    auto &weak=devices[key];if(auto value=weak.lock())return value;
    auto value=std::make_shared<DeviceImages>(device);weak=value;return value;
}
macfx::ImageBudgetSnapshot observed(const std::shared_ptr<DeviceImages>&state){
    // Foreign device calls are never made while the reservation mutex is held.
    return {state->device.recommendedMaxWorkingSetSize,state->device.currentAllocatedSize,0,0};
}
void status(uintptr_t context,std::string_view stage,uint64_t requested,bool accepted,std::string_view reason){
    if(!context)return;macfx::RuntimeStatusEvent event;event.context=context;event.processing=true;
    event.phase=accepted?macfx::RuntimeStatusPhase::Prepared:macfx::RuntimeStatusPhase::Bypassed;
    event.stageId=stage.empty()?"image-memory":stage;event.requestedMethod="image-memory";event.activeMethod=accepted?"admitted":"bypass";
    event.requestedBytes=requested;event.admittedBytes=accepted?requested:0;event.reason=reason;macfx::observeRuntimeStatus(event);
}
std::string unavailable(uint64_t requested,const macfx::ImageBudgetDecision&decision){return "Graphics image memory admission requires "+std::to_string(requested)+" bytes; projected "+std::to_string(decision.projected)+" exceeds available working set "+std::to_string(decision.limit);}
char reservationKey;
}
struct macfx::ImageReservation::Impl {
    std::shared_ptr<DeviceImages>state;uint64_t size;bool reserved=false,committed=false,external=false;uintptr_t context;std::string stage;
    IOSurfaceRef retiredSurface=nullptr;std::shared_ptr<ImageReservation>retiredNext;
    Impl(std::shared_ptr<DeviceImages>s,uint64_t bytes,uintptr_t owner,std::string_view row,bool surface):state(std::move(s)),size(bytes),external(surface),context(owner),stage(row){}
    ~Impl(){if(!reserved)return;std::lock_guard lock(state->mutex);auto &counter=committed?(external?state->external:state->committed):state->pending;counter-=size;}
};
@interface MacFXImageReservation:NSObject {
@public std::shared_ptr<macfx::ImageReservation> value;
}
@end
@implementation MacFXImageReservation
@end
macfx::ImageReservation::ImageReservation(std::unique_ptr<Impl>value):impl(std::move(value)){}
macfx::ImageReservation::~ImageReservation()=default;
uint64_t macfx::ImageReservation::bytes()const noexcept{return impl->size;}
void macfx::ImageReservation::commit(uint64_t actual){
    if(!actual)actual=impl->size;auto snapshot=observed(impl->state);ImageBudgetDecision decision;bool denied=false;
    {std::lock_guard lock(impl->state->mutex);if(impl->committed)return;
        if(actual>impl->size){snapshot.committed=impl->state->committed;snapshot.pending=impl->state->pending;snapshot.externalCommitted=impl->state->external;
            decision=admitImageBytes(snapshot,actual-impl->size);denied=!decision.admitted;}
        if(!denied){impl->state->pending-=impl->size;impl->size=actual;(impl->external?impl->state->external:impl->state->committed)+=actual;impl->committed=true;}
    }
    if(denied){const auto reason=unavailable(actual,decision);status(impl->context,impl->stage,actual,false,reason);throw ImageBudgetExceeded(reason,decision.structurallyImpossible);}
}
std::shared_ptr<macfx::ImageReservation> macfx::reserveImageBytes(id<MTLDevice>device,uint64_t bytes,uintptr_t context,std::string_view stage,bool external){
    if(!device||!bytes)throw ImageBudgetExceeded("Graphics image memory size is invalid",true);
    pollRetiredImages();auto state=images(device);auto snapshot=observed(state);ImageBudgetDecision decision;
    auto result=std::shared_ptr<ImageReservation>(new ImageReservation(std::make_unique<ImageReservation::Impl>(state,bytes,context,stage,external)));
    {std::lock_guard lock(state->mutex);snapshot.committed=state->committed;snapshot.pending=state->pending;snapshot.externalCommitted=state->external;
        decision=admitImageBytes(snapshot,bytes);if(decision.admitted){state->pending+=bytes;result->impl->reserved=true;}}
    if(!decision.admitted){const auto reason=unavailable(bytes,decision);status(context,stage,bytes,false,reason);throw ImageBudgetExceeded(reason,decision.structurallyImpossible);}
    status(context,stage,bytes,true,{});return result;
}
void macfx::attachImageReservation(id<MTLTexture>texture,const std::shared_ptr<ImageReservation>&reservation){
    if(!texture||!reservation)return;auto retained=[MacFXImageReservation new];retained->value=reservation;
    objc_setAssociatedObject(texture,&reservationKey,retained,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
id<MTLTexture> macfx::newAdmittedTexture(id<MTLDevice>device,MTLTextureDescriptor*descriptor,uintptr_t context,std::string_view stage){
    const auto estimate=[device heapTextureSizeAndAlignWithDescriptor:descriptor];
    auto reservation=reserveImageBytes(device,estimate.size,context,stage);
    id<MTLTexture>texture=[device newTextureWithDescriptor:descriptor];if(!texture)throw ImageBudgetExceeded("Cannot allocate an admitted graphics image");
    reservation->commit(std::max<uint64_t>(estimate.size,texture.allocatedSize));attachImageReservation(texture,reservation);return texture;
}
void macfx::retireOwnedSurface(IOSurfaceRef surface,std::shared_ptr<ImageReservation>reservation){
    if(!surface)return;
    if(!reservation||!IOSurfaceIsInUse(surface)){CFRelease(surface);return;}
    auto &state=retiredImages();bool duplicate=false;{std::lock_guard lock(state.mutex);
    if(reservation->impl->retiredSurface)duplicate=true;
    else{reservation->impl->retiredSurface=surface;reservation->impl->retiredNext=std::move(state.head);state.head=std::move(reservation);retiredPending.store(true,std::memory_order_release);}}
    if(duplicate)CFRelease(surface);
}
void macfx::pollRetiredImages()noexcept{
    if(!retiredPending.load(std::memory_order_acquire))return;
    auto &state=retiredImages();std::shared_ptr<ImageReservation>pending,kept;ImageReservation *tail=nullptr;
    {std::unique_lock lock(state.mutex,std::try_to_lock);if(!lock.owns_lock())return;pending.swap(state.head);}
    while(pending){auto current=std::move(pending);pending=std::move(current->impl->retiredNext);
        if(IOSurfaceIsInUse(current->impl->retiredSurface)){if(!tail)tail=current.get();current->impl->retiredNext=std::move(kept);kept=std::move(current);}
        else{CFRelease(current->impl->retiredSurface);current->impl->retiredSurface=nullptr;}}
    {std::lock_guard lock(state.mutex);if(tail){tail->impl->retiredNext=std::move(state.head);state.head=std::move(kept);}retiredPending.store(bool(state.head),std::memory_order_release);}
}
