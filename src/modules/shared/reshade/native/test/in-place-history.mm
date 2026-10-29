// Copyright (c) MacLauncher contributors. MIT license.
#include "in-place-history.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

namespace {
using Pixel=std::array<unsigned char,4>;
id<MTLTexture> image(id<MTLDevice> device,unsigned width=8){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:8 mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
    auto value=[device newTextureWithDescriptor:descriptor];assert(value);return value;
}
void fill(id<MTLTexture> value,Pixel color){std::vector<Pixel> pixels(value.width*value.height,color);
    [value replaceRegion:MTLRegionMake2D(0,0,value.width,value.height) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:value.width*4];}
Pixel read(id<MTLTexture> value){Pixel pixel{};[value getBytes:pixel.data() bytesPerRow:4 fromRegion:MTLRegionMake2D(0,0,1,1)mipmapLevel:0];return pixel;}
void complete(id<MTLCommandBuffer> commands){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}
void cpu(){
    macfx::InPlaceHistory history;const auto state=history.prepare(nil,"a",1);
    assert(!macfx::InPlaceHistory::original(state));assert(macfx::InPlaceHistory::transient(state));
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    assert(macfx::InPlaceHistory::transient(state));assert(!macfx::InPlaceHistory::original(state));
    macfx::InPlaceHistory::bypass(state);
    assert(history.prepare(nil,"a",1)==state&&macfx::InPlaceHistory::original(state));
    assert(history.prepare(nil,"b",1)==state&&!macfx::InPlaceHistory::original(state));
    assert(history.prepare(nil,"b",2)!=state);history.reset();assert(history.prepare(nil,"b",1)!=state);
    puts("CPU policy: pressure remains recoverable past the old deadline; explicit failure, settings/color invalidation and Off reset passed; no Metal device");
}
void gpu(){
    auto device=MTLCreateSystemDefaultDevice();assert(device);auto queue=[device newCommandQueue];assert(queue);
    auto gray=image(device),raw=image(device),target=image(device);const Pixel monochrome={77,77,77,255},color={20,70,230,255};
    fill(gray,monochrome);fill(raw,color);fill(target,color);
    // The old Busy boundary forwarded the untouched original: keep that actual
    // colored GPU target as the negative control, rather than calling it gray.
    assert(read(raw)==color&&read(raw)!=monochrome);
    macfx::InPlaceHistory history;auto state=history.prepare(target,"a",1);
    auto recorded=[queue commandBuffer];macfx::InPlaceHistory::capture(state,recorded,gray);
    auto before=[queue commandBuffer];assert(!macfx::InPlaceHistory::replay(state,before,target));
    complete(recorded);
    for(unsigned i=0;i<4;++i){fill(target,color);auto replay=[queue commandBuffer];assert(macfx::InPlaceHistory::replay(state,replay,target));complete(replay);assert(read(target)==monochrome);}
    assert(read(raw)==color&&read(gray)==monochrome&&state->images.size()<=2);
    // Different producer queues may complete in reverse submission order.
    // The newest completed source sequence must remain the accepted image.
    macfx::InPlaceHistory ordered;auto ordering=ordered.prepare(target,"ordered",1);
    auto other=[device newCommandQueue];assert(other);
    auto older=[queue commandBuffer];macfx::InPlaceHistory::capture(ordering,older,raw);
    auto newer=[other commandBuffer];macfx::InPlaceHistory::capture(ordering,newer,gray);complete(newer);complete(older);
    fill(target,color);auto latest=[queue commandBuffer];assert(macfx::InPlaceHistory::replay(ordering,latest,target));complete(latest);assert(read(target)==monochrome);
    // A pending history writer cannot replace the last completed gray frame.
    auto late=[queue commandBuffer];macfx::InPlaceHistory::capture(state,late,raw);
    auto next=history.prepare(target,"b",1);assert(next==state);
    complete(late);fill(target,color);auto retained=[queue commandBuffer];assert(macfx::InPlaceHistory::replay(next,retained,target));complete(retained);assert(read(target)==monochrome);
    // Reader and writer ownership survives caller release and unsubmitted work.
    @autoreleasepool{auto abandoned=[queue commandBuffer];macfx::InPlaceHistory::capture(next,abandoned,raw);abandoned=nil;}
    auto valid=[queue commandBuffer];macfx::InPlaceHistory::capture(next,valid,gray);complete(valid);
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    fill(target,color);auto delayed=[queue commandBuffer];assert(macfx::InPlaceHistory::replay(next,delayed,target));complete(delayed);assert(read(target)==monochrome);
    macfx::InPlaceHistory::bypass(next);
    assert(macfx::InPlaceHistory::original(next));auto ignored=[queue commandBuffer];macfx::InPlaceHistory::capture(next,ignored,gray);
    assert(macfx::InPlaceHistory::original(history.prepare(target,"b",1)));
    auto resized=image(device,16);auto changed=history.prepare(resized,"b",1);assert(changed!=next);
    auto stale=[queue commandBuffer];assert(!macfx::InPlaceHistory::replay(changed,stale,resized));
    assert(history.prepare(resized,"b",2)!=changed);history.reset();
    puts("GPU pixels: raw negative control stayed colored; Busy replay stayed gray; real completion, reverse-queue ordering, old-epoch rejection, bounded images, abandoned commands and contract invalidation passed");
}
}
int main(int argc,char **argv){@autoreleasepool{if(argc==2&&!std::strcmp(argv[1],"--cpu")){cpu();return 0;}gpu();return 0;}}
