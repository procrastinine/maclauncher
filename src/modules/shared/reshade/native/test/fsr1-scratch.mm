// Copyright (c) MacLauncher contributors. MIT license.
// FSR1 scratch images are shared per device. A replacement encoder at the same
// 4K output reuses the idle images of the encoder it replaces instead of
// charging the process scratch budget again, and the budget still bounds
// concurrent images. A resize releases idle images of the old extent, and an
// idle image of another encoder's extent gives way when the budget is full.
#include "fsr1.hpp"
#include "fsr1-budget.hpp"
#import <Metal/Metal.h>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace {
id<MTLTexture> image(id<MTLDevice> device,NSUInteger width,NSUInteger height,MTLTextureUsage usage){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=usage;auto texture=[device newTextureWithDescriptor:descriptor];assert(texture);return texture;
}
struct Frames {
    id<MTLDevice> device;id<MTLCommandQueue> queue;id<MTLTexture> source;std::vector<id<MTLTexture>> outputs;std::vector<id<MTLCommandBuffer>> pending;
    // Encodes into a retained, unsubmitted buffer; its scratch lease lasts until it completes.
    bool encode(macfx::Fsr1Encoder &encoder,std::string &reason,bool &busy,NSUInteger width=3840,NSUInteger height=2160){
        auto output=image(device,width,height,MTLTextureUsageShaderWrite);auto commands=[queue commandBuffer];assert(commands);
        const bool encoded=encoder.encode(commands,{source,output,pending.size()+1},.5f,reason,&busy);
        outputs.push_back(output);pending.push_back(commands);return encoded;
    }
    void complete(){for(auto commands:pending){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}pending.clear();outputs.clear();}
};
size_t scratchBytes(id<MTLDevice> device,NSUInteger width,NSUInteger height){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    return [device heapTextureSizeAndAlignWithDescriptor:descriptor].size;
}
// Completion handlers return images to the pool asynchronously.
void charged(size_t expected,const char *when){
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
    while(macfx::fsr1::ScratchBudget::retainedBytes()!=expected&&std::chrono::steady_clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto actual=macfx::fsr1::ScratchBudget::retainedBytes();
    if(actual!=expected){std::fprintf(stderr,"%s: %zu scratch bytes charged, expected %zu\n",when,actual,expected);assert(actual==expected);}
}
}

int main(){@autoreleasepool{
    auto device=MTLCreateSystemDefaultDevice();if(!device){std::puts("No Metal device");return 77;}
    Frames frames{device,[device newCommandQueue],image(device,1920,1080,MTLTextureUsageShaderRead),{},{}};std::string reason;bool busy=false;
    // How many 4K scratch images the process budget holds on this device.
    const size_t large=scratchBytes(device,3840,2160),small=scratchBytes(device,2560,1440);
    const unsigned capacity=unsigned(macfx::fsr1::ScratchBudget::maximum/large);
    std::printf("4K scratch images within the budget: %u\n",capacity);assert(capacity>=3&&capacity<=6);
    // The budget has no room for one 1440p image beside a full set of 4K images.
    assert(capacity*large+small>macfx::fsr1::ScratchBudget::maximum);
    {
        macfx::Fsr1Encoder retained(device);
        // The retained chain fills all but one image; a candidate validates the last.
        for(unsigned i=0;i+1<capacity;++i){const bool encoded=frames.encode(retained,reason,busy);if(!encoded)std::fprintf(stderr,"Retained frame %u: %s\n",i,reason.c_str());assert(encoded);}
        macfx::Fsr1Encoder candidate(device);
        {const bool encoded=frames.encode(candidate,reason,busy);if(!encoded)std::fprintf(stderr,"Candidate validation: %s\n",reason.c_str());assert(encoded);}
        // One more concurrent 4K image exceeds the 256 MiB process budget.
        {const bool encoded=frames.encode(candidate,reason,busy);assert(!encoded&&busy&&reason=="FSR scratch memory budget is full");}
        frames.complete();
        // After the change the candidate renders all but one image in flight while
        // the retained chain finishes one more: every frame reuses an idle image.
        for(unsigned i=0;i+1<capacity;++i){const bool encoded=frames.encode(candidate,reason,busy);if(!encoded)std::fprintf(stderr,"Replacement frame %u: %s\n",i,reason.c_str());assert(encoded);}
        {const bool encoded=frames.encode(retained,reason,busy);if(!encoded)std::fprintf(stderr,"Retained final frame: %s\n",reason.c_str());assert(encoded);}
        frames.complete();
    }
    // With no encoder left, the pool releases its images; a new encoder allocates again.
    charged(0,"After the last encoder");
    {macfx::Fsr1Encoder later(device);for(unsigned i=0;i<capacity;++i){const bool encoded=frames.encode(later,reason,busy);if(!encoded)std::fprintf(stderr,"Later frame %u: %s\n",i,reason.c_str());assert(encoded);}frames.complete();}
    charged(0,"After the later encoder");
    {
        macfx::Fsr1Encoder resized(device);
        for(unsigned i=0;i<capacity;++i)assert(frames.encode(resized,reason,busy));
        frames.complete();charged(capacity*large,"Idle 4K images of a live encoder");
        // The encoder's output becomes 1440p: its idle 4K images are stale.
        assert(frames.encode(resized,reason,busy,2560,1440));charged(small,"After a resize");
        frames.complete();charged(small,"Idle 1440p image");
        // A full set of 4K images in flight takes the budget from the idle 1440p image.
        macfx::Fsr1Encoder other(device);
        for(unsigned i=0;i<capacity;++i){const bool encoded=frames.encode(other,reason,busy);if(!encoded)std::fprintf(stderr,"4K frame %u under pressure: %s\n",i,reason.c_str());assert(encoded);}
        charged(capacity*large,"4K frames in flight");frames.complete();
        // And the idle 4K images give way to the 1440p encoder in turn.
        {const bool encoded=frames.encode(resized,reason,busy,2560,1440);if(!encoded)std::fprintf(stderr,"1440p frame under pressure: %s\n",reason.c_str());assert(encoded);}
        charged(small,"1440p frame in flight");frames.complete();
        assert(frames.encode(other,reason,busy));frames.complete();charged(small+large,"Both extents idle");
    }
    charged(0,"After both encoders");
    std::puts("FSR1 scratch: a replacement encoder at the same 4K output reused the retained chain's idle images; the budget still refused one more concurrent image; a resize released stale images; idle images of another extent gave way under pressure; the pool released its images after the last encoder");
    return 0;
}}
