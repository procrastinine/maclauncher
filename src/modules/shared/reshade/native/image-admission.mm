// Copyright (c) MacLauncher contributors. MIT license.
#include "image-admission.hpp"
#include "runtime-status.hpp"
#import <objc/runtime.h>
#include <algorithm>
#include <map>
#include <mutex>
#include <string>
#include <atomic>
#include <vector>
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
// A denial that can fit later is retried by its caller, so it reports
// Preparing; only a request that can never fit reports Bypassed.
void status(uintptr_t context,std::string_view stage,uint64_t requested,bool accepted,std::string_view reason,bool impossible=false){
    if(!context)return;macfx::RuntimeStatusEvent event;event.context=context;event.processing=true;
    event.phase=accepted?macfx::RuntimeStatusPhase::Prepared:impossible?macfx::RuntimeStatusPhase::Bypassed:macfx::RuntimeStatusPhase::Preparing;
    event.stageId=stage.empty()?"image-memory":stage;event.requestedMethod="image-memory";event.activeMethod=accepted?"admitted":impossible?"bypass":"pending";
    event.requestedBytes=requested;event.admittedBytes=accepted?requested:0;event.reason=reason;macfx::observeRuntimeStatus(event);
}
std::string unavailable(uint64_t requested,const macfx::ImageBudgetDecision&decision){return "Graphics image memory admission requires "+std::to_string(requested)+" bytes; projected "+std::to_string(decision.projected)+" exceeds available working set "+std::to_string(decision.limit);}
char reservationKey;
// Retriable ledger and allocation denials raised on this thread.
thread_local uint64_t threadDenials=0;
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
uint64_t macfx::threadImageDenials()noexcept{return threadDenials;}
void macfx::ImageReservation::commit(uint64_t actual){
    if(!actual)actual=impl->size;auto snapshot=observed(impl->state);ImageBudgetDecision decision;bool denied=false;
    {std::lock_guard lock(impl->state->mutex);if(impl->committed)return;
        if(actual>impl->size){snapshot.committed=impl->state->committed;snapshot.pending=impl->state->pending;snapshot.externalCommitted=impl->state->external;
            decision=admitImageBytes(snapshot,actual-impl->size);denied=!decision.admitted;}
        if(!denied){impl->state->pending-=impl->size;impl->size=actual;(impl->external?impl->state->external:impl->state->committed)+=actual;impl->committed=true;}
    }
    if(denied){const auto reason=unavailable(actual,decision);status(impl->context,impl->stage,actual,false,reason,decision.structurallyImpossible);threadDenials+=!decision.structurallyImpossible;throw ImageBudgetExceeded(reason,decision.structurallyImpossible);}
}
std::shared_ptr<macfx::ImageReservation> macfx::reserveImageBytes(id<MTLDevice>device,uint64_t bytes,uintptr_t context,std::string_view stage,bool external){
    if(!device||!bytes)throw ImageBudgetExceeded("Graphics image memory size is invalid",true);
    pollRetiredImages();auto state=images(device);auto snapshot=observed(state);ImageBudgetDecision decision;
    auto result=std::shared_ptr<ImageReservation>(new ImageReservation(std::make_unique<ImageReservation::Impl>(state,bytes,context,stage,external)));
    {std::lock_guard lock(state->mutex);snapshot.committed=state->committed;snapshot.pending=state->pending;snapshot.externalCommitted=state->external;
        decision=admitImageBytes(snapshot,bytes);if(decision.admitted){state->pending+=bytes;result->impl->reserved=true;}}
    if(!decision.admitted){const auto reason=unavailable(bytes,decision);status(context,stage,bytes,false,reason,decision.structurallyImpossible);threadDenials+=!decision.structurallyImpossible;throw ImageBudgetExceeded(reason,decision.structurallyImpossible);}
    status(context,stage,bytes,true,{});return result;
}
namespace {
void attachReservation(id resource,const std::shared_ptr<macfx::ImageReservation>&reservation){
    if(!resource||!reservation)return;auto retained=[MacFXImageReservation new];retained->value=reservation;
    objc_setAssociatedObject(resource,&reservationKey,retained,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
}
void macfx::attachImageReservation(id<MTLTexture>texture,const std::shared_ptr<ImageReservation>&reservation){attachReservation(texture,reservation);}
namespace {
id<MTLTexture> admittedTexture(id<MTLDevice>device,MTLTextureDescriptor*descriptor,uintptr_t context,std::string_view stage,uint64_t&bytes){
    const auto estimate=[device heapTextureSizeAndAlignWithDescriptor:descriptor];
    auto reservation=macfx::reserveImageBytes(device,estimate.size,context,stage);
    id<MTLTexture>texture=[device newTextureWithDescriptor:descriptor];if(!texture){++threadDenials;throw macfx::ImageBudgetExceeded("Cannot allocate an admitted graphics image");}
    reservation->commit(std::max<uint64_t>(estimate.size,texture.allocatedSize));bytes=reservation->bytes();attachReservation(texture,reservation);return texture;
}
id<MTLBuffer> admittedBuffer(id<MTLDevice>device,NSUInteger length,MTLResourceOptions options,uintptr_t context,std::string_view stage,uint64_t&bytes){
    const auto estimate=[device heapBufferSizeAndAlignWithLength:length options:options];
    auto reservation=macfx::reserveImageBytes(device,std::max<uint64_t>(estimate.size,length),context,stage);
    id<MTLBuffer>buffer=[device newBufferWithLength:length options:options];if(!buffer){++threadDenials;throw macfx::ImageBudgetExceeded("Cannot allocate an admitted graphics buffer");}
    reservation->commit(std::max<uint64_t>(reservation->bytes(),buffer.allocatedSize));bytes=reservation->bytes();attachReservation(buffer,reservation);return buffer;
}
}
id<MTLTexture> macfx::newAdmittedTexture(id<MTLDevice>device,MTLTextureDescriptor*descriptor,uintptr_t context,std::string_view stage){
    uint64_t bytes=0;return admittedTexture(device,descriptor,context,stage,bytes);
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
// One pool per device. Prepared handles keep descriptor work off the frame path.
struct macfx::PooledImage::Lease {
    std::atomic<size_t>users{0};std::weak_ptr<PreparedImageLease::State>state;size_t index=0;
    void release()noexcept;
};
struct macfx::ImagePoolClient::Pool:std::enable_shared_from_this<Pool> {
    struct Key {
        bool buffer=false,shared=false;NSUInteger width=0,height=0,depth=0,array=0,mips=0,samples=0,length=0;
        MTLTextureType type=MTLTextureType2D;MTLPixelFormat format=MTLPixelFormatInvalid;MTLTextureUsage usage=MTLTextureUsageUnknown;
        MTLStorageMode storage=MTLStorageModePrivate;MTLHazardTrackingMode hazard=MTLHazardTrackingModeDefault;MTLCPUCacheMode cache=MTLCPUCacheModeDefaultCache;
        MTLResourceOptions options=0;BOOL optimized=YES;MTLTextureSwizzleChannels swizzle{};std::string role;id<MTLCommandQueue>queue;
        bool operator==(const Key&o)const{return buffer==o.buffer&&shared==o.shared&&width==o.width&&height==o.height&&depth==o.depth&&array==o.array&&mips==o.mips&&samples==o.samples&&length==o.length&&
            type==o.type&&format==o.format&&usage==o.usage&&storage==o.storage&&hazard==o.hazard&&cache==o.cache&&options==o.options&&optimized==o.optimized&&
            swizzle.red==o.swizzle.red&&swizzle.green==o.swizzle.green&&swizzle.blue==o.swizzle.blue&&swizzle.alpha==o.swizzle.alpha&&role==o.role&&queue==o.queue;}
    };
    struct Entry {Key key;id<MTLTexture>texture;id<MTLBuffer>buffer;uint64_t bytes=0;size_t holders=0;std::weak_ptr<PooledImage::Lease>cached;};
    id<MTLDevice>device;std::mutex mutex;std::vector<std::shared_ptr<Entry>>entries;
    std::map<const void*,std::map<std::string,Key,std::less<>>>demand;
    std::vector<std::weak_ptr<PreparedImageLease::State>>prepared;
    explicit Pool(id<MTLDevice>value):device(value){}
    static std::map<uintptr_t,std::weak_ptr<Pool>>&pools(){static auto *value=new std::map<uintptr_t,std::weak_ptr<Pool>>;return *value;}
    static std::mutex&poolsMutex(){static auto *value=new std::mutex;return *value;}
    static std::shared_ptr<Pool>find(id<MTLDevice>device,bool create){
        const auto key=reinterpret_cast<uintptr_t>((__bridge void*)device);std::lock_guard lock(poolsMutex());auto &weak=pools()[key];
        if(auto value=weak.lock())return value;if(!create)return {};auto value=std::make_shared<Pool>(device);weak=value;return value;
    }
    static Key textureKey(MTLTextureDescriptor*d,std::string_view role,id<MTLCommandQueue>queue,bool shared){
        Key k;k.shared=shared;k.width=d.width;k.height=d.height;k.depth=d.depth;k.array=d.arrayLength;k.mips=d.mipmapLevelCount;k.samples=d.sampleCount;k.type=d.textureType;k.format=d.pixelFormat;
        k.usage=d.usage;k.storage=d.storageMode;k.hazard=d.hazardTrackingMode;k.cache=d.cpuCacheMode;k.optimized=d.allowGPUOptimizedContents;k.swizzle=d.swizzle;k.role=role;k.queue=queue;return k;
    }
    bool demandedLocked(const Key&key)const{
        for(const auto &[client,roles]:demand)for(const auto &[role,value]:roles)if(value==key)return true;return false;
    }
    bool idleLocked(const Entry&entry)const{
        if(!entry.holders)return true;auto cached=entry.cached.lock();return cached&&cached->users.load(std::memory_order_acquire)==0;
    }
    void collectLocked(std::vector<std::shared_ptr<Entry>>&released){
        for(auto it=entries.begin();it!=entries.end();)
            if(!(*it)->holders&&((*it)->key.shared||!demandedLocked((*it)->key))){released.push_back(std::move(*it));it=entries.erase(it);}else ++it;
    }
    PooledImage holdLocked(const std::shared_ptr<Entry>&entry);
    void cache(const PooledImage&,const std::shared_ptr<PooledImage::Lease>&);
    void uncache(const PooledImage&,const std::shared_ptr<PooledImage::Lease>&);
    bool evictIdle();
    template<class Allocate>PooledImage request(const Key&key,size_t limit,uintptr_t context,Allocate allocate){
        for(unsigned attempt=0;;++attempt){
            std::unique_lock lock(mutex);
            for(const auto&entry:entries)if(entry->key==key&&(key.shared||!entry->holders))return holdLocked(entry);
            if(!key.shared&&size_t(std::count_if(entries.begin(),entries.end(),[&](const auto&entry){return entry->key==key;}))>=limit)return {};
            auto entry=std::make_shared<Entry>();entry->key=key;
            const bool idle=std::any_of(entries.begin(),entries.end(),[&](const auto&value){return idleLocked(*value);});
            try{allocate(*entry,idle&&attempt==0?0:context);entries.push_back(entry);return holdLocked(entry);}
            catch(const ImageBudgetExceeded&error){
                if(attempt||error.structurallyImpossible)throw;
                lock.unlock();if(!evictIdle())throw;
            }
        }
    }
    void release(const std::shared_ptr<Entry>&entry)noexcept{
        std::shared_ptr<Entry>released;{std::lock_guard lock(mutex);
        if(entry->holders)--entry->holders;
        if(!entry->holders&&(entry->key.shared||!demandedLocked(entry->key))){auto it=std::find(entries.begin(),entries.end(),entry);if(it!=entries.end()){released=std::move(*it);entries.erase(it);}}}
    }
};
struct macfx::PooledImage::Hold {
    std::shared_ptr<ImagePoolClient::Pool>pool;std::shared_ptr<ImagePoolClient::Pool::Entry>entry;
    ~Hold(){if(pool&&entry)pool->release(entry);}
};
macfx::PooledImage::PooledImage(std::shared_ptr<Hold>value)noexcept:hold(std::move(value)){}
macfx::PooledImage::PooledImage(std::shared_ptr<Hold>value,std::shared_ptr<Lease>ticket)noexcept:hold(std::move(value)),lease(std::move(ticket)){if(lease)lease->users.fetch_add(1,std::memory_order_relaxed);}
macfx::PooledImage::PooledImage(const PooledImage&other)noexcept:hold(other.hold),lease(other.lease){if(lease)lease->users.fetch_add(1,std::memory_order_relaxed);}
macfx::PooledImage::PooledImage(PooledImage&&other)noexcept:hold(std::move(other.hold)),lease(std::move(other.lease)){}
macfx::PooledImage&macfx::PooledImage::operator=(const PooledImage&other)noexcept{if(this!=&other){PooledImage next(other);hold.swap(next.hold);lease.swap(next.lease);}return *this;}
macfx::PooledImage&macfx::PooledImage::operator=(PooledImage&&other)noexcept{if(this!=&other){reset();hold=std::move(other.hold);lease=std::move(other.lease);}return *this;}
macfx::PooledImage::~PooledImage(){reset();}
void macfx::PooledImage::reset()noexcept{
    auto ticket=std::move(lease);hold.reset();if(ticket&&ticket->users.fetch_sub(1,std::memory_order_acq_rel)==1)ticket->release();
}
macfx::PooledImage macfx::ImagePoolClient::Pool::holdLocked(const std::shared_ptr<Entry>&entry){
    auto hold=std::make_shared<PooledImage::Hold>();hold->pool=shared_from_this();hold->entry=entry;++entry->holders;return PooledImage(std::move(hold));
}
void macfx::ImagePoolClient::Pool::cache(const PooledImage&image,const std::shared_ptr<PooledImage::Lease>&ticket){std::lock_guard lock(mutex);image.hold->entry->cached=ticket;}
void macfx::ImagePoolClient::Pool::uncache(const PooledImage&image,const std::shared_ptr<PooledImage::Lease>&ticket){
    if(!image)return;std::lock_guard lock(mutex);if(image.hold->entry->cached.lock()==ticket)image.hold->entry->cached.reset();
}
id<MTLTexture> macfx::PooledImage::texture()const noexcept{return hold?hold->entry->texture:nil;}
id<MTLBuffer> macfx::PooledImage::buffer()const noexcept{return hold?hold->entry->buffer:nil;}
struct macfx::PreparedImageLease::State:std::enable_shared_from_this<State> {
    enum class Phase{Empty,Warming,Idle,Held};
    struct Slot{PooledImage image;std::shared_ptr<PooledImage::Lease>ticket;Phase phase=Phase::Empty;};
    std::shared_ptr<ImagePoolClient::Pool>pool;ImagePoolClient::Pool::Key key;MTLTextureDescriptor*descriptor;
    std::mutex mutex;std::vector<Slot>slots;std::vector<size_t>free;size_t limit;
    State(std::shared_ptr<ImagePoolClient::Pool>value,ImagePoolClient::Pool::Key identity,MTLTextureDescriptor*d,size_t capacity):pool(std::move(value)),key(std::move(identity)),descriptor([d copy]),limit(capacity){}
    ~State(){for(auto&slot:slots)if(slot.image)pool->uncache(slot.image,slot.ticket);}
    void capacity(size_t value){std::lock_guard lock(mutex);limit=std::max(limit,value);}
    bool warm(uintptr_t context){
        size_t index,capacity;std::shared_ptr<PooledImage::Lease>ticket;
        {std::lock_guard lock(mutex);if(!free.empty())return true;capacity=limit;
            auto it=std::find_if(slots.begin(),slots.end(),[](const auto&slot){return slot.phase==Phase::Empty;});
            if(it==slots.end()){
                if(slots.size()>=limit)return false;index=slots.size();free.reserve(index+1);
                auto created=std::make_shared<PooledImage::Lease>();created->state=shared_from_this();created->index=index;
                slots.push_back({{},std::move(created),Phase::Warming});
            }else{index=size_t(it-slots.begin());it->phase=Phase::Warming;}
            ticket=slots[index].ticket;
        }
        try{
            const auto device=pool->device;
            auto image=pool->request(key,capacity,context,[&](ImagePoolClient::Pool::Entry&entry,uintptr_t owner){entry.texture=admittedTexture(device,descriptor,owner,key.role,entry.bytes);});
            if(!image){std::lock_guard lock(mutex);slots[index].phase=Phase::Empty;return false;}
            pool->cache(image,ticket);
            {std::lock_guard lock(mutex);slots[index].image=std::move(image);slots[index].phase=Phase::Idle;free.push_back(index);}return true;
        }catch(...){std::lock_guard lock(mutex);slots[index].phase=Phase::Empty;throw;}
    }
    PooledImage acquire(){
        std::unique_lock lock(mutex,std::try_to_lock);if(!lock||free.empty())return {};
        const auto index=free.back();free.pop_back();auto&slot=slots[index];slot.phase=Phase::Held;
        return PooledImage(slot.image.hold,slot.ticket);
    }
    void release(size_t index)noexcept{
        std::lock_guard lock(mutex);if(index<slots.size()&&slots[index].phase==Phase::Held){slots[index].phase=Phase::Idle;free.push_back(index);}
    }
    bool evict(){
        std::vector<PooledImage>released;
        {std::lock_guard lock(mutex);released.reserve(free.size());
            for(const auto index:free){auto&slot=slots[index];pool->uncache(slot.image,slot.ticket);released.push_back(std::move(slot.image));slot.phase=Phase::Empty;}
            free.clear();}
        return !released.empty();
    }
};
void macfx::PooledImage::Lease::release()noexcept{if(auto owner=state.lock())owner->release(index);}
bool macfx::PreparedImageLease::prepare()const{return state&&state->warm(context);}
macfx::PooledImage macfx::PreparedImageLease::acquire()const{return state?state->acquire():PooledImage{};}
bool macfx::ImagePoolClient::Pool::evictIdle(){
    std::vector<std::shared_ptr<Entry>>released;std::vector<std::shared_ptr<PreparedImageLease::State>>clients;
    {std::lock_guard lock(mutex);
        for(auto it=entries.begin();it!=entries.end();)if(!(*it)->holders){released.push_back(std::move(*it));it=entries.erase(it);}else ++it;
        for(auto it=prepared.begin();it!=prepared.end();)if(auto value=it->lock()){clients.push_back(std::move(value));++it;}else it=prepared.erase(it);
    }
    bool evicted=!released.empty();released.clear();for(auto&client:clients)evicted=client->evict()||evicted;return evicted;
}
macfx::PooledImage macfx::shareWorkingImage(id<MTLDevice>device,MTLTextureDescriptor*descriptor,std::string_view role,id<MTLCommandQueue>queue,uintptr_t context){
    if(!device||!descriptor||role.empty()||!queue||queue.device!=device)throw std::invalid_argument("A shared working image requires a device, descriptor, role and queue");
    if(descriptor.hazardTrackingMode==MTLHazardTrackingModeUntracked||descriptor.storageMode==MTLStorageModeMemoryless)
        throw std::invalid_argument("Shared working images require tracked persistent storage; use an exclusive or caller-owned resource for this descriptor");
    using Pool=ImagePoolClient::Pool;auto pool=Pool::find(device,true);auto key=Pool::textureKey(descriptor,role,queue,true);
    return pool->request(key,SIZE_MAX,context,[&](Pool::Entry&entry,uintptr_t owner){entry.texture=admittedTexture(device,descriptor,owner,role,entry.bytes);});
}
macfx::PooledImage macfx::shareWorkingBuffer(id<MTLDevice>device,NSUInteger length,MTLResourceOptions options,std::string_view role,id<MTLCommandQueue>queue,uintptr_t context){
    if(!device||!length||role.empty()||!queue||queue.device!=device)throw std::invalid_argument("A shared working buffer requires a device, length, role and queue");
    if((options&MTLResourceHazardTrackingModeUntracked)==MTLResourceHazardTrackingModeUntracked||(options&MTLResourceStorageModeMask)==MTLResourceStorageModeMemoryless)
        throw std::invalid_argument("Shared working buffers require tracked persistent storage; use an exclusive or caller-owned resource for these options");
    using Pool=ImagePoolClient::Pool;auto pool=Pool::find(device,true);Pool::Key key;key.buffer=key.shared=true;key.length=length;key.options=options;key.role=role;key.queue=queue;
    return pool->request(key,SIZE_MAX,context,[&](Pool::Entry&entry,uintptr_t owner){entry.buffer=admittedBuffer(device,length,options,owner,role,entry.bytes);});
}
macfx::ImagePoolClient::ImagePoolClient(id<MTLDevice>device){if(!device)throw std::invalid_argument("An image pool client requires a device");pool=Pool::find(device,true);}
macfx::ImagePoolClient::~ImagePoolClient(){
    std::vector<std::shared_ptr<Pool::Entry>>released;{std::lock_guard lock(pool->mutex);pool->demand.erase(this);pool->collectLocked(released);}
}
macfx::PooledImage macfx::ImagePoolClient::lease(MTLTextureDescriptor*descriptor,std::string_view role,size_t limit,uintptr_t context){
    if(!descriptor||role.empty())throw std::invalid_argument("An image lease requires a descriptor and role");
    auto key=Pool::textureKey(descriptor,role,nil,false);std::vector<std::shared_ptr<Pool::Entry>>released;
    {std::lock_guard lock(pool->mutex);auto &roles=pool->demand[this];auto found=roles.find(role);if(found==roles.end())roles.emplace(std::string(role),key);else found->second=key;pool->collectLocked(released);}
    // Refund obsolete resources before admitting the replacement, outside the pool lock.
    released.clear();const auto device=pool->device;
    return pool->request(key,limit,context,[&](Pool::Entry&entry,uintptr_t owner){entry.texture=admittedTexture(device,descriptor,owner,role,entry.bytes);});
}
macfx::PreparedImageLease macfx::ImagePoolClient::prepare(MTLTextureDescriptor*descriptor,std::string_view role,size_t limit,uintptr_t context){
    if(!descriptor||role.empty()||!limit)throw std::invalid_argument("A prepared image lease requires a descriptor, role and positive capacity");
    auto key=Pool::textureKey(descriptor,role,nil,false);std::shared_ptr<PreparedImageLease::State>state;
    {std::lock_guard lock(pool->mutex);
        for(auto it=pool->prepared.begin();it!=pool->prepared.end();)if(auto value=it->lock()){if(value->key==key)state=std::move(value);++it;}else it=pool->prepared.erase(it);
        if(!state){state=std::make_shared<PreparedImageLease::State>(pool,key,descriptor,limit);pool->prepared.push_back(state);}
    }
    state->capacity(limit);PreparedImageLease result(std::move(state),context);result.prepare();return result;
}
macfx::ImagePoolUsage macfx::imagePoolUsage(id<MTLDevice>device){
    ImagePoolUsage usage;auto pool=ImagePoolClient::Pool::find(device,false);if(!pool)return usage;std::lock_guard lock(pool->mutex);
    for(const auto &entry:pool->entries){++usage.resources;usage.bytes+=entry->bytes;if(pool->idleLocked(*entry)){++usage.idle;usage.idleBytes+=entry->bytes;}else ++usage.held;}return usage;
}
