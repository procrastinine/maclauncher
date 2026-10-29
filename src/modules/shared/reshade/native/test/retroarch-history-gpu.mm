// Copyright (c) MacLauncher contributors. MIT license.
// Actual librashader history pixels, 8x8 offscreen; execution requires --gpu.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#ifndef MACFX_RETROARCH_SOURCE
#define MACFX_RETROARCH_SOURCE <retroarch.hpp>
#endif
#include MACFX_RETROARCH_SOURCE
#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

namespace {
constexpr unsigned side=8;
using Pixel=std::array<unsigned char,4>;
using Pixels=std::array<Pixel,side*side>;
constexpr Pixel red{255,0,0,255},green{0,255,0,255},blue{0,0,255,255},white{255,255,255,255};
Pixel bgra(Pixel rgba){return {rgba[2],rgba[1],rgba[0],rgba[3]};}
PFN_libra_mtl_filter_chain_create realCreate=nullptr;
PFN_libra_mtl_filter_chain_frame realFrame=nullptr;
PFN_libra_mtl_filter_chain_free realFree=nullptr;
unsigned creates=0,frameCalls=0,frees=0;
libra_error_t observedCreate(libra_shader_preset_t *preset,id<MTLCommandQueue>queue,const filter_chain_mtl_opt_t *options,libra_mtl_filter_chain_t *out){
    auto error=realCreate(preset,queue,options,out);++creates;
    std::fprintf(stderr,"C API create=%u chain=%p queue=%p error=%p\n",creates,reinterpret_cast<void*>(*out),(__bridge void*)queue,reinterpret_cast<void*>(error));return error;
}
libra_error_t observedFrame(libra_mtl_filter_chain_t *chain,id<MTLCommandBuffer>commands,size_t frameId,id<MTLTexture>input,id<MTLTexture>output,const libra_viewport_t *viewport,const float *mvp,const frame_mtl_opt_t *options){
    ++frameCalls;std::fprintf(stderr,"C API frame=%u id=%zu chain=%p commands=%p status=%lu queue=%p input=%p output=%p\n",frameCalls,frameId,reinterpret_cast<void*>(*chain),(__bridge void*)commands,(unsigned long)commands.status,(__bridge void*)commands.commandQueue,(__bridge void*)input,(__bridge void*)output);
    return realFrame(chain,commands,frameId,input,output,viewport,mvp,options);
}
libra_error_t observedFree(libra_mtl_filter_chain_t *chain){
    auto previous=*chain;auto error=realFree(chain);++frees;
    std::fprintf(stderr,"C API free=%u chain=%p error=%p\n",frees,reinterpret_cast<void*>(previous),reinterpret_cast<void*>(error));return error;
}
void observeAPI(){
    auto &api=macfx::RetroarchAPI::instance();realCreate=api.create;realFrame=api.frame;realFree=api.free;
    api.create=observedCreate;api.frame=observedFrame;api.free=observedFree;
}
void commandState(const char *stage,id<MTLCommandBuffer>commands){
    std::fprintf(stderr,"%s commands=%p status=%lu queue=%p creates=%u frames=%u frees=%u\n",stage,(__bridge void*)commands,(unsigned long)commands.status,(__bridge void*)commands.commandQueue,creates,frameCalls,frees);
}
id<MTLTexture>texture(id<MTLDevice>device,Pixel color,const char *label){
    // Match the provider's native history format so repeated frames reuse the
    // ring slot. RGBA input makes its BGRA history destination resize each time.
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:side height:side mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
    auto value=[device newTextureWithDescriptor:descriptor];
    if(!value)throw std::runtime_error("Cannot allocate history control texture");
    value.label=@(label);Pixels pixels;pixels.fill(bgra(color));
    [value replaceRegion:MTLRegionMake2D(0,0,side,side) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:side*sizeof(Pixel)];return value;
}
void submit(id<MTLCommandBuffer>commands){
    [commands commit];[commands waitUntilCompleted];
    if(commands.status!=MTLCommandBufferStatusCompleted)
        throw std::runtime_error(commands.error.localizedDescription.UTF8String?:"History control command buffer failed");
}
// A replacement generation is prepared off the frame path. Its first attempt
// reports busy without encoding; a later attempt adopts the prepared chain.
void encode(macfx::RetroarchChain &owner,id<MTLCommandBuffer>commands,id<MTLTexture>input,id<MTLTexture>output,uint64_t frame){
    for(unsigned attempt=0;;++attempt)try{owner.encode(commands,input,output,frame,16.666667f);return;}
    catch(const macfx::RetroarchBusy &error){if(std::strncmp(error.what(),"Preparing",9)||attempt>=5000)throw;std::this_thread::sleep_for(std::chrono::milliseconds(1));}
}
bool verify(id<MTLTexture>texture,Pixel expected,const char *label){
    if(texture.pixelFormat!=MTLPixelFormatBGRA8Unorm)throw std::runtime_error("Unexpected history control pixel format");
    Pixels pixels;[texture getBytes:pixels.data() bytesPerRow:side*sizeof(Pixel) fromRegion:MTLRegionMake2D(0,0,side,side) mipmapLevel:0];
    for(auto &pixel:pixels)pixel=bgra(pixel); // BGRA bytes to logical RGBA.
    const auto first=pixels.front();std::printf("%s RGBA=%u,%u,%u,%u expected=%u,%u,%u,%u\n",label,first[0],first[1],first[2],first[3],expected[0],expected[1],expected[2],expected[3]);
    for(const auto &pixel:pixels)if(pixel!=expected)return false;return true;
}
}
int main(int argc,const char **argv){@autoreleasepool{
    // Compilation and an accidental no-argument invocation do not create a device.
    if(argc!=4||std::strcmp(argv[1],"--gpu")){std::fprintf(stderr,"Usage: retroarch-history-gpu --gpu <history.slangp> <librashader.dylib>\n");return 2;}
    unsetenv("RESHADE_CONTROL_FILE");unsetenv("RESHADE_DIAGNOSTICS");setenv("RESHADE_LIBRASHADER",argv[3],1);
    try {
        auto device=MTLCreateSystemDefaultDevice();if(!device)throw std::runtime_error("Metal device unavailable");
        auto queue=[device newCommandQueue];if(!queue)throw std::runtime_error("Metal queue unavailable");
        std::printf("Actual Retroarch history device=%s source=8x8 target=8x8 format=BGRA8Unorm offscreen; no window\n",device.name.UTF8String);
        observeAPI();
        macfx::RetroarchChain owner(argv[2],std::string(64,'a'),queue);
        auto inputA=texture(device,red,"history-input-A-red"),inputB=texture(device,green,"history-input-B-green");
        auto inputC=texture(device,blue,"history-input-C-blue"),inputD=texture(device,white,"history-input-D-white");
        auto outputA=texture(device,white,"history-output-A"),outputB=texture(device,white,"history-output-B");
        auto outputC=texture(device,white,"history-output-C"),outputD=texture(device,white,"history-output-D");
        auto a=[queue commandBuffer];encode(owner,a,inputA,outputA,1);
        commandState("A encoded before B",a);
        // A has rotated the old CPU history ring but has not written its GPU slot.
        auto b=[queue commandBuffer];encode(owner,b,inputB,outputB,2);submit(b);
        commandState("A after B completed",a);
        // First history after a reset is unspecified. The second must be B green.
        auto c=[queue commandBuffer];encode(owner,c,inputC,outputC,3);submit(c);
        commandState("A after C completed",a);
        if(!verify(outputC,green,"ordered C history"))return 3;
        // On the old adapter A now overwrites the slot that C just filled blue.
        // An isolated old generation cannot alter the current generation's slot.
        submit(a);
        bool unchanged=true;
        unchanged&=verify(inputA,red,"immutable A after late A");unchanged&=verify(inputB,green,"immutable B after late A");
        unchanged&=verify(inputC,blue,"immutable C after late A");unchanged&=verify(inputD,white,"immutable D after late A");
        if(!unchanged)return 5;
        if(!verify(outputD,white,"untouched D before encode"))return 6;
        auto d=[queue commandBuffer];encode(owner,d,inputD,outputD,4);submit(d);
        if(!verify(outputD,blue,"D history after late A"))return 4;
        std::puts("Actual Retroarch history pixels passed: ordered green history and blue history after late red submission");return 0;
    }catch(const std::exception &error){std::fprintf(stderr,"History control failed: %s\n",error.what());return 1;}
}}
