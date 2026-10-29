#import <Foundation/Foundation.h>
#include "image-admission.hpp"
#include <cassert>
#include <thread>
#include <atomic>
namespace {std::atomic<unsigned>queries{0},allocations{0};uint64_t workingSet=1024,allocated=0,textureBytes=400;bool rejectTexture=false,surfaceInUse=false;IOSurfaceRef controlledSurface=nullptr;}
extern "C" Boolean IOSurfaceIsInUse(IOSurfaceRef surface){assert(surface==controlledSurface);return surfaceInUse;}
@interface BudgetTexture:NSObject
@end
@implementation BudgetTexture
- (NSUInteger)allocatedSize{return textureBytes;}
@end
@interface BudgetDevice:NSObject
@end
@implementation BudgetDevice
- (NSUInteger)recommendedMaxWorkingSetSize{++queries;return workingSet;}
- (NSUInteger)currentAllocatedSize{++queries;return allocated;}
- (MTLSizeAndAlign)heapTextureSizeAndAlignWithDescriptor:(MTLTextureDescriptor*)descriptor{(void)descriptor;return {textureBytes,256};}
- (id)newTextureWithDescriptor:(MTLTextureDescriptor*)descriptor{(void)descriptor;++allocations;return rejectTexture?nil:[BudgetTexture new];}
@end
int main(){@autoreleasepool{
    id<MTLDevice>device=(id<MTLDevice>)[BudgetDevice new];assert(queries==0&&allocations==0);
    auto pending=macfx::reserveImageBytes(device,600);bool denied=false;const auto denials=macfx::threadImageDenials();
    try{auto other=macfx::reserveImageBytes(device,400);}catch(const macfx::ImageBudgetExceeded&){denied=true;}assert(denied);
    // A retriable denial is counted on its thread; a structural one is not.
    assert(macfx::threadImageDenials()==denials+1);try{auto never=macfx::reserveImageBytes(device,1ull<<40);assert(!never);}catch(const macfx::ImageBudgetExceeded&error){assert(error.structurallyImpossible);}
    assert(macfx::threadImageDenials()==denials+1);std::thread([&]{assert(macfx::threadImageDenials()==0);}).join();
    pending->commit();auto retired=pending;pending.reset();denied=false;
    try{auto other=macfx::reserveImageBytes(device,400);}catch(const macfx::ImageBudgetExceeded&){denied=true;}assert(denied);
    retired.reset();auto replacement=macfx::reserveImageBytes(device,900);replacement.reset();
    // The actual production texture helper associates the reservation with
    // the image. A retained retired image keeps the admission charged.
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:10 height:10 mipmapped:NO];
    NSMutableArray *inFlight=[NSMutableArray new];
    @autoreleasepool{id texture=macfx::newAdmittedTexture(device,descriptor);[inFlight addObject:texture];}
    denied=false;try{auto other=macfx::reserveImageBytes(device,600);}catch(const macfx::ImageBudgetExceeded&){denied=true;}assert(denied);
    [inFlight removeAllObjects];auto released=macfx::reserveImageBytes(device,600);released.reset();
    rejectTexture=true;try{auto failed=macfx::newAdmittedTexture(device,descriptor);assert(!failed);}catch(const macfx::ImageBudgetExceeded&){}
    auto refunded=macfx::reserveImageBytes(device,900);refunded.reset();
    // The real retirement list consumes an owned CF lease, with a controlled
    // use predicate. No platform IOSurface/GPU allocation is needed here.
    workingSet=65536;auto external=macfx::reserveImageBytes(device,4096,0,{},true);external->commit();
    NSObject *surfaceOwner=[NSObject new];controlledSurface=(IOSurfaceRef)CFBridgingRetain(surfaceOwner);surfaceInUse=true;
    macfx::retireOwnedSurface(controlledSurface,std::move(external));macfx::pollRetiredImages();
    denied=false;try{auto other=macfx::reserveImageBytes(device,60000);}catch(const macfx::ImageBudgetExceeded&){denied=true;}assert(denied);
    surfaceInUse=false;macfx::pollRetiredImages();controlledSurface=nullptr;auto drained=macfx::reserveImageBytes(device,60000);drained.reset();
    workingSet=0;auto unknown=macfx::reserveImageBytes(device,4ull<<30);unknown.reset();
    assert(allocations==2);puts("actual image admission: pending/committed/retired leases, failed replacement refund and unknown-budget policy passed; NSObject device/textures only");
}}
