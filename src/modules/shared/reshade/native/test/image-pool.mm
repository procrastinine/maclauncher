// Device resource pool: shared working images, exclusive leases, release and
// eviction against the actual image admission, with a controlled device whose
// images have 3840x2160 sizes.
#import <Foundation/Foundation.h>
#include "image-admission.hpp"
#include <cassert>
#include <cstdio>
#include <functional>
#include <memory>
#include <vector>
namespace {
uint64_t workingSet=0;int liveImages=0,allocations=0;
uint64_t pixelBytes(MTLPixelFormat format){
    switch(format){case MTLPixelFormatRGBA32Float:return 16;case MTLPixelFormatRGBA16Float:case MTLPixelFormatRG32Float:return 8;case MTLPixelFormatR8Unorm:return 1;default:return 4;}
}
uint64_t imageBytes(MTLTextureDescriptor*d){return macfx::alignedImageBytes(unsigned(d.width),unsigned(d.height),unsigned(pixelBytes(d.pixelFormat)));}
}
@interface PoolResource:NSObject {
@public uint64_t size;
}
@end
@implementation PoolResource
- (instancetype)initWithSize:(uint64_t)value{if((self=[super init])){size=value;++liveImages;++allocations;}return self;}
- (void)dealloc{--liveImages;}
- (NSUInteger)allocatedSize{return size;}
- (NSUInteger)length{return size;}
@end
@interface PoolDevice:NSObject
@end
@implementation PoolDevice
- (NSUInteger)recommendedMaxWorkingSetSize{return workingSet;}
- (NSUInteger)currentAllocatedSize{return 0;}
- (MTLSizeAndAlign)heapTextureSizeAndAlignWithDescriptor:(MTLTextureDescriptor*)d{return {imageBytes(d),4096};}
- (MTLSizeAndAlign)heapBufferSizeAndAlignWithLength:(NSUInteger)length options:(MTLResourceOptions)options{(void)options;return {(length+4095)/4096*4096,4096};}
- (id)newTextureWithDescriptor:(MTLTextureDescriptor*)d{return [[PoolResource alloc]initWithSize:imageBytes(d)];}
- (id)newBufferWithLength:(NSUInteger)length options:(MTLResourceOptions)options{(void)options;return [[PoolResource alloc]initWithSize:(length+4095)/4096*4096];}
@end
@interface PoolQueue:NSObject {
@public id device;
}
@end
@implementation PoolQueue
- (id)device{return device;}
@end
namespace {
id<MTLDevice>device;
MTLTextureDescriptor*descriptor(NSUInteger width,NSUInteger height,MTLPixelFormat format,bool render=false){
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];d.storageMode=MTLStorageModePrivate;
    d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|(render?MTLTextureUsageRenderTarget:0);return d;
}
id<MTLCommandQueue>queue(){auto value=[PoolQueue new];value->device=device;return (id<MTLCommandQueue>)value;}
// Bytes the image budget can still admit, found from the actual admission.
uint64_t available(){
    uint64_t low=0,high=workingSet;
    while(low+4096<=high){const uint64_t mid=((low+high)/2+4095)/4096*4096;
        try{auto probe=macfx::reserveImageBytes(device,mid);low=mid;}catch(const macfx::ImageBudgetExceeded&){high=mid-4096;}}
    return low;
}
bool denied(const std::function<void()>&request){@autoreleasepool{try{request();}catch(const macfx::ImageBudgetExceeded&){return true;}return false;}}
bool invalid(const std::function<void()>&request){@autoreleasepool{try{request();}catch(const std::invalid_argument&){return true;}return false;}}
// Identity without a strong or autoreleased reference that would keep the image alive.
const void*identity(const macfx::PooledImage&value){@autoreleasepool{id object=value.texture();if(!object)object=value.buffer();return (__bridge const void*)object;}}
// The full-size and half-size working set of one FidelityFX DoF instance.
std::vector<std::pair<const char*,MTLTextureDescriptor*>>dofImages(NSUInteger w,NSUInteger h){
    const auto halfW=(w+1)/2,halfH=(h+1)/2;
    return {{"dof.source",descriptor(w,h,MTLPixelFormatRGBA32Float,true)},{"dof.result",descriptor(w,h,MTLPixelFormatRGBA32Float)},{"dof.oriented",descriptor(w,h,MTLPixelFormatRGBA32Float,true)},
        {"dof.near",descriptor(halfW,halfH,MTLPixelFormatRGBA32Float)},{"dof.far",descriptor(halfW,halfH,MTLPixelFormatRGBA32Float)}};
}
struct Chain {std::vector<macfx::PooledImage>images;};
Chain dof(id<MTLCommandQueue>q,NSUInteger w,NSUInteger h){
    Chain c;for(const auto&[role,d]:dofImages(w,h))c.images.push_back(macfx::shareWorkingImage(device,d,role,q));return c;
}
}
int main(){@autoreleasepool{
    device=(id<MTLDevice>)[PoolDevice new];const auto mainQueue=queue(),otherQueue=queue();
    const uint64_t source4k=imageBytes(descriptor(3840,2160,MTLPixelFormatRGBA32Float)),half4k=imageBytes(descriptor(1920,1080,MTLPixelFormatRGBA32Float));
    const uint64_t set4k=3*source4k+2*half4k;
    // Room for one 4K working set and half of another: two private copies never fit.
    workingSet=(set4k+set4k/2)*16/15;const uint64_t budget=available();assert(budget>=set4k&&budget<2*set4k);

    // Shared: the candidate holds the retained chain's images; nothing new is charged.
    auto retained=dof(mainQueue,3840,2160);assert(liveImages==5&&available()==budget-set4k);
    auto usage=macfx::imagePoolUsage(device);assert(usage.resources==5&&usage.held==5&&usage.bytes==set4k&&!usage.idle);
    // A private copy of the same working set (the previous per-instance images) does not fit.
    assert(denied([&]{NSMutableArray*copy=[NSMutableArray new];for(const auto&image:dofImages(3840,2160))[copy addObject:macfx::newAdmittedTexture(device,image.second)];}));
    assert(available()==budget-set4k);
    const int allocated=allocations;auto candidate=dof(mainQueue,3840,2160);assert(allocations==allocated);
    for(size_t i=0;i<5;++i)assert(identity(candidate.images[i])==identity(retained.images[i]));
    assert(liveImages==5&&available()==budget-set4k&&macfx::imagePoolUsage(device).bytes==set4k);
    // Roles and queues separate images: a second queue never shares the first's.
    assert(denied([&]{(void)dof(otherQueue,3840,2160);}));assert(liveImages==5&&available()==budget-set4k);
    // The retained chain retires: the candidate keeps every image.
    retained.images.clear();assert(liveImages==5&&macfx::imagePoolUsage(device).held==5);
    candidate.images.clear();assert(liveImages==0&&available()==budget&&macfx::imagePoolUsage(device).resources==0);
    std::puts("shared working images: a 4K candidate holds the retained chain's 5 images with no new charge; release with the last holder");

    // Release on resize: the 4K set ends with its last holder; the 1440p set remains.
    retained=dof(mainQueue,3840,2160);candidate=dof(mainQueue,2560,1440);
    const uint64_t set1440=macfx::imagePoolUsage(device).bytes-set4k;assert(liveImages==10&&available()==budget-set4k-set1440);
    retained.images.clear();assert(liveImages==5&&available()==budget-set1440&&macfx::imagePoolUsage(device).bytes==set1440);
    candidate.images.clear();assert(liveImages==0&&available()==budget);
    std::puts("resize: the retired 4K working set is released and its charge refunded at once");

    // Shared buffers follow the same keys.
    {auto a=macfx::shareWorkingBuffer(device,3840*2160*16,MTLResourceStorageModePrivate,"cmaa2.items",mainQueue),b=macfx::shareWorkingBuffer(device,3840*2160*16,MTLResourceStorageModePrivate,"cmaa2.items",mainQueue);
     auto c=macfx::shareWorkingBuffer(device,2560*1440*16,MTLResourceStorageModePrivate,"cmaa2.items",mainQueue);
     assert(identity(a)&&identity(a)==identity(b)&&identity(c)!=identity(a)&&liveImages==2);}
    assert(liveImages==0&&available()==budget);

    // Exclusive leases: idle images of the key are reused by the same or another
    // client; a full key reports busy; an idle image nobody demands is released.
    const auto scratch4k=descriptor(3840,2160,MTLPixelFormatRGBA16Float),scratch1440=descriptor(2560,1440,MTLPixelFormatRGBA16Float);
    const uint64_t slot4k=imageBytes(scratch4k);
    {auto accepted=std::make_unique<macfx::ImagePoolClient>(device);
     auto first=accepted->lease(scratch4k,"scratch",2),second=accepted->lease(scratch4k,"scratch",2);assert(first&&second&&identity(first)!=identity(second));
     assert(!accepted->lease(scratch4k,"scratch",2)&&liveImages==2);
     const void*reused=identity(first);first.reset();usage=macfx::imagePoolUsage(device);assert(usage.idle==1&&usage.idleBytes==slot4k&&liveImages==2);
     const int allocated=allocations;auto again=accepted->lease(scratch4k,"scratch",2);assert(identity(again)==reused&&allocations==allocated&&liveImages==2);again.reset();
     // A candidate with the same descriptor reuses the accepted client's idle image.
     auto replacement=std::make_unique<macfx::ImagePoolClient>(device);const auto before=available();
     auto borrowed=replacement->lease(scratch4k,"scratch",2);assert(identity(borrowed)==reused&&available()==before&&liveImages==2);borrowed.reset();second.reset();
     // The accepted client resizes; the candidate still demands 4K, so the idle 4K images stay.
     auto resized=accepted->lease(scratch1440,"scratch",2);assert(resized&&liveImages==3&&macfx::imagePoolUsage(device).idle==2);
     replacement.reset();assert(liveImages==1&&macfx::imagePoolUsage(device).resources==1);
     resized.reset();assert(liveImages==1&&macfx::imagePoolUsage(device).idle==1);
     accepted.reset();assert(liveImages==0&&available()==budget);}
    std::puts("leases: idle reuse across clients, busy at the key limit, release when no client's latest descriptor matches");

    // Prepared handles resolve a descriptor once and acquire cached tickets:
    // no resource allocation, descriptor access or fresh hold is needed for a
    // warm frame. Another execution shares only a returned exclusive slot.
    {macfx::ImagePoolClient accepted(device),candidate(device);
     auto key=descriptor(2560,1440,MTLPixelFormatRGBA16Float);
     auto prepared=accepted.prepare(key,"prepared.frame",2);
     auto replacement=candidate.prepare(key,"prepared.frame",2);
     assert(prepared&&replacement&&liveImages==1&&macfx::imagePoolUsage(device).idle==1);
     const int warmAllocations=allocations;
     const void*firstIdentity=nullptr;
     for(unsigned i=0;i<256;++i){auto frame=prepared.acquire();assert(frame);if(!i)firstIdentity=identity(frame);else assert(identity(frame)==firstIdentity);}
     assert(allocations==warmAllocations&&liveImages==1);
     auto frame=prepared.acquire();auto completion=frame;frame.reset();
     assert(!replacement.acquire()&&macfx::imagePoolUsage(device).held==1);
     key.width=32;key.height=32;
     assert(replacement.prepare());auto next=replacement.acquire();
     assert(next&&identity(next)!=firstIdentity&&liveImages==2&&!prepared.prepare()&&available()==budget-2*imageBytes(scratch1440));
     // Dropping the frame alone cannot return a command-completion copy.
     completion.reset();auto recycled=prepared.acquire();assert(identity(recycled)==firstIdentity);
     auto abandoned=recycled;recycled.reset();assert(!prepared.acquire());
     abandoned.reset();recycled=prepared.acquire();assert(identity(recycled)==firstIdentity);
     // The handle owns a copy of its descriptor, not a mutable caller pointer.
     next.reset();recycled.reset();assert(prepared.prepare()&&allocations==warmAllocations+1);
    }
    assert(liveImages==0&&available()==budget);
    std::puts("prepared leases: stable allocation-free acquisition, candidate reuse, last-copy completion/abandon return and descriptor snapshot");

    // A frame outlives its graph/descriptor handle without being recycled.
    {macfx::PooledImage inFlight;
     {macfx::ImagePoolClient owner(device);auto prepared=owner.prepare(scratch1440,"prepared.retired",1);inFlight=prepared.acquire();assert(inFlight&&liveImages==1);}
     assert(inFlight&&liveImages==1&&macfx::imagePoolUsage(device).held==1);inFlight.reset();}
    assert(liveImages==0&&available()==budget);

    // Pressure is local and retriable. It does not discard held work or poison
    // the prepared key, and a later worker warm succeeds with the same handle.
    {macfx::ImagePoolClient owner(device);auto prepared=owner.prepare(scratch4k,"prepared.retry",2);auto frame=prepared.acquire();
     const auto remaining=available();auto pressure=macfx::reserveImageBytes(device,remaining);
     assert(denied([&]{(void)prepared.prepare();})&&frame&&liveImages==1);
     pressure.reset();assert(prepared.prepare());auto next=prepared.acquire();assert(next&&identity(frame)!=identity(next)&&liveImages==2);
     next.reset();frame.reset();
     // An idle prepared bucket is evictable, and the same handle warms again.
     const auto before=allocations;
     {auto other=macfx::shareWorkingImage(device,descriptor(4500,8192,MTLPixelFormatRGBA32Float),"pressure.large",mainQueue);assert(other);}
     assert(!prepared.acquire()&&liveImages==0&&prepared.prepare()&&allocations==before+2);
    }
    assert(liveImages==0&&available()==budget);
    std::puts("prepared pressure: held frames survive refusal; idle eviction and later warm reuse the same valid key");

    // Obsolete idle descriptors must refund before replacement admission. This
    // replacement fits alone but cannot fit beside the two obsolete slots.
    {macfx::ImagePoolClient owner(device);auto first=owner.lease(scratch4k,"resize.refund",2),second=owner.lease(scratch4k,"resize.refund",2);first.reset();second.reset();
     auto large=owner.lease(descriptor(4500,8192,MTLPixelFormatRGBA32Float),"resize.refund",2);assert(large&&liveImages==1);}
    assert(liveImages==0&&available()==budget);

    // Descriptors that change shader-visible channels cannot alias. Untracked
    // or memoryless resources use the supported exclusive/caller-owned route.
    {auto plain=descriptor(32,32,MTLPixelFormatRGBA16Float);MTLTextureDescriptor*swizzled=[plain copy];
     swizzled.swizzle=MTLTextureSwizzleChannels{MTLTextureSwizzleBlue,MTLTextureSwizzleGreen,MTLTextureSwizzleRed,MTLTextureSwizzleAlpha};
     auto a=macfx::shareWorkingImage(device,plain,"swizzle",mainQueue),b=macfx::shareWorkingImage(device,swizzled,"swizzle",mainQueue);assert(identity(a)!=identity(b));
     MTLTextureDescriptor*untracked=[plain copy];untracked.hazardTrackingMode=MTLHazardTrackingModeUntracked;
     assert(invalid([&]{(void)macfx::shareWorkingImage(device,untracked,"untracked",mainQueue);}));
     macfx::ImagePoolClient owner(device);auto exclusive=owner.prepare(untracked,"untracked",1);assert(exclusive.acquire());
     MTLTextureDescriptor*memoryless=[plain copy];memoryless.storageMode=MTLStorageModeMemoryless;
     assert(invalid([&]{(void)macfx::shareWorkingImage(device,memoryless,"memoryless",mainQueue);}));
     assert(invalid([&]{(void)macfx::shareWorkingBuffer(device,4096,MTLResourceStorageModePrivate|MTLResourceHazardTrackingModeUntracked,"untracked",mainQueue);}));}
    assert(liveImages==0&&available()==budget);
    std::puts("descriptor safety: channel swizzles segregate resources; untracked/memoryless sharing is rejected without blocking exclusive resources");

    // Eviction under pressure: idle images of other keys give way to a request
    // that would not fit; held images never do.
    {auto client=std::make_unique<macfx::ImagePoolClient>(device);std::vector<macfx::PooledImage>held;
     for(;;){try{held.push_back(client->lease(scratch4k,"scratch"));}catch(const macfx::ImageBudgetExceeded&){break;}}
     assert(held.size()>=3&&available()<slot4k);const auto count=held.size();
     assert(denied([&]{(void)macfx::shareWorkingImage(device,descriptor(3840,2160,MTLPixelFormatRGBA32Float),"dof.result",mainQueue);}));
     held.pop_back();held.pop_back();held.pop_back();assert(liveImages==int(count)&&macfx::imagePoolUsage(device).idle==3);
     auto working=macfx::shareWorkingImage(device,descriptor(3840,2160,MTLPixelFormatRGBA32Float),"dof.result",mainQueue);
     usage=macfx::imagePoolUsage(device);assert(working&&!usage.idle&&usage.held==count-3+1&&liveImages==int(count-3+1));
     // A request larger than the whole budget is impossible and evicts nothing.
     held.pop_back();assert(macfx::imagePoolUsage(device).idle==1);
     bool impossible=false;try{(void)macfx::shareWorkingImage(device,descriptor(16384,16384,MTLPixelFormatRGBA32Float),"too-large",mainQueue);}catch(const macfx::ImageBudgetExceeded&error){impossible=error.structurallyImpossible;}
     assert(impossible&&macfx::imagePoolUsage(device).idle==1);
     working.reset();held.clear();client.reset();assert(liveImages==0&&available()==budget);}
    std::puts("eviction: idle images of other keys are released before a request is refused; held images and impossible requests are not");
    std::printf("4K DoF working set %.1f MB; budget %.1f MB; transition charge shared %.1f MB, private %.1f MB\n",set4k/1e6,budget/1e6,0.0,set4k/1e6);
}}
