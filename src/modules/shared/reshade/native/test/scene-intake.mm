// Copyright (c) MacLauncher contributors. MIT license.
// The temporal intake that a FidelityFX or DLSS adapter feeds, end to end on
// the actual GPU: rsProcessTemporalFrame with an ordered plan whose temporal
// row is MetalFX, on the input layout that FidelityFX games hand over (packed
// float RG11B10Float colour and output, a render region smaller than the
// textures, reversed infinite Depth32Float, RG16Float motion and R8 masks).
// The ordered scene must finish preparing and encode within a bounded number
// of frames while frames keep arriving at display rate. A GPU-bound game then
// submits each frame while its two earlier frames are still on the GPU, which
// the fixture reproduces with a shared event. The oldest of them completes
// before the preparation worker gets to a refused frame's request, as when the
// worker is busy preparing other work. The scene's prepared images must still
// grow to fit the frames in flight: after 1.5 s no frame may be refused.
// Each encoded scene then leaves a receipt for the final image of the window
// that presents it. When every prepared image is held by frames on the GPU, a
// refused scene leaves the previous image in the output, and that reused
// image carries the receipt of the scene it reuses. After the scene stops,
// the next final image has no receipt and runs its complete chain.
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#include "fixture-files.hpp"
#include "live-controls.hpp"
#include "native-config.hpp"
#include "process-phase.hpp"
#include "scene-destination.hpp"
#include "temporal-frame.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>
#include <thread>

namespace {
id<MTLTexture> image(id<MTLDevice> device,MTLPixelFormat format,NSUInteger width,NSUInteger height,MTLTextureUsage usage){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
    descriptor.usage=usage;descriptor.storageMode=MTLStorageModePrivate;return [device newTextureWithDescriptor:descriptor];
}
int fail(const std::string &reason){std::fprintf(stderr,"scene intake: %s\n",reason.c_str());return 1;}
}
namespace macfx {dispatch_queue_t effectPreparationQueue();}

int main(int argc,char **argv){@autoreleasepool{
    const auto phase=fixture::phase(argc,argv);argc=phase.argc;argv=phase.argv;
    if(phase.name.empty()){
        char scratch[1024];temporaryPath(scratch,"macfx-scene-intake-XXXXXX");if(!mkdtemp(scratch))return fail("Cannot create the plan directory");
        const std::string directory=scratch;
        const int status=fixture::runPhase("intake",{{"RESHADE_EXPLICIT_HOST",nullptr},{"RESHADE_EFFECT_PLAN",(directory+"/plan.json").c_str()},
            {"RESHADE_CONTROL_FILE",(directory+"/controls").c_str()},{"RESHADE_LIVE_EFFECTS",scratch}});
        [NSFileManager.defaultManager removeItemAtPath:@(scratch) error:nil];return status;
    }
    NSString *plan=@(macfx::nativeConfig().effectPlanFile->c_str()),*controls=@(macfx::nativeConfig().controlFile->c_str());
    macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.flags=8;packet.targetHz=60;packet.multiplier=2;packet.sharpness=.5;packet.flowScale=1;
    std::memset(packet.effectKey,'0',64);std::memset(packet.revision,'0',64);
    if(!replaceFile([NSData dataWithBytes:&packet length:sizeof(packet)],controls))return fail("Cannot publish controls");
    NSString *revision=[@"" stringByPaddingToLength:64 withString:@"d" startingAtIndex:0];
    NSDictionary *document=@{@"schema":@1,@"mode":@"advanced",@"revision":revision,
        @"nodes":@[@{@"id":@"sample-temporal",@"kind":@"temporal",@"enabled":@YES,@"method":@"metalfx",@"settings":@{}}]};
    if(!replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],plan))return fail("Cannot publish the plan");
    std::this_thread::sleep_for(std::chrono::milliseconds(110));

    id<MTLDevice> device=MTLCreateSystemDefaultDevice();if(!device)return fail("No Metal device");
    id<MTLCommandQueue> queue=[device newCommandQueue];
    const MTLTextureUsage colour=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto color=image(device,MTLPixelFormatRG11B10Float,1280,720,colour),output=image(device,MTLPixelFormatRG11B10Float,1280,720,colour);
    auto depth=image(device,MTLPixelFormatDepth32Float,1280,720,MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget);
    auto motion=image(device,MTLPixelFormatRG16Float,1280,720,colour);
    auto reactive=image(device,MTLPixelFormatR8Unorm,1280,720,colour),transparency=image(device,MTLPixelFormatR8Unorm,1280,720,colour);
    if(!color||!output||!depth||!motion||!reactive||!transparency)return fail("Cannot create the intake textures");

    static int owner;std::deque<id<MTLCommandBuffer>> flight;std::string last;unsigned encodedAt=0;
    const unsigned limit=argc>1?unsigned(std::strtoul(argv[1],nullptr,10)):480;
    const float jitter[][2]={{.25f,-.1667f},{-.25f,.3889f},{.375f,-.3889f},{-.375f,.0556f}};
    // Frames after the first 30 encoded ones wait on this event until two later
    // frames have been submitted, as a GPU-bound game's frames do.
    id<MTLSharedEvent> gate=[device newSharedEvent];unsigned gatedFrom=0,refused=0,refusedLast=0;std::string refusal;
    const auto sceneFrame=[&](id<MTLCommandBuffer> commands,unsigned frame){
        RSTemporalFrame f{};f.size=sizeof(f);f.version=1;f.owner=&owner;f.commandBuffer=(__bridge void*)commands;
        f.color=(__bridge void*)color;f.depth=(__bridge void*)depth;f.motion=(__bridge void*)motion;f.output=(__bridge void*)output;
        f.reactive=(__bridge void*)reactive;f.transparency=(__bridge void*)transparency;f.frameId=frame;f.method=RS_TEMPORAL_METALFX;
        f.flags=RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE|RS_TEMPORAL_HDR|RS_TEMPORAL_AUTO_EXPOSURE|RS_TEMPORAL_CAMERA_VALID|(frame==1?RS_TEMPORAL_RESET:0);
        f.renderWidth=853;f.renderHeight=480;f.outputWidth=1280;f.outputHeight=720;f.maxRenderWidth=1280;f.maxRenderHeight=720;
        f.jitterX=jitter[frame%4][0];f.jitterY=jitter[frame%4][1];f.motionScaleX=853;f.motionScaleY=480;
        f.preExposure=1.355f;f.sharpness=.8f;f.frameTimeMs=16.6f;f.nearPlane=.1f;f.farPlane=0;f.verticalFov=.8836f;return f;
    };
    for(unsigned frame=1;frame<=limit;++frame){@autoreleasepool{
        id<MTLCommandBuffer> commands=[queue commandBuffer];
        // The preparation worker waits until this frame's oldest predecessor is done.
        dispatch_semaphore_t worker=nil;
        if(gatedFrom){[commands encodeWaitForEvent:gate value:frame];worker=dispatch_semaphore_create(0);
            dispatch_async(macfx::effectPreparationQueue(),^{dispatch_semaphore_wait(worker,DISPATCH_TIME_FOREVER);});}
        RSTemporalFrame f=sceneFrame(commands,frame);RSTemporalResult r{};r.size=sizeof(r);r.version=1;
        const int code=rsProcessTemporalFrame(&f,&r);
        const std::string reason=std::to_string(code)+" encoded="+std::to_string(r.encoded)+" "+r.reason;
        if(reason!=last){std::printf("frame %u: %s\n",frame,reason.c_str());last=reason;}
        if(gatedFrom&&frame>=gatedFrom+90&&!(code==RS_TEMPORAL_OK&&r.encoded)){++refused;refusedLast=frame;refusal=reason;}
        [commands commit];flight.push_back(commands);
        if(gatedFrom){if(frame>=2)gate.signaledValue=frame-2;}
        while(flight.size()>2){[flight.front() waitUntilCompleted];flight.pop_front();}
        if(worker)dispatch_semaphore_signal(worker);
        if(code==RS_TEMPORAL_OK&&r.encoded&&!encodedAt)encodedAt=frame;
        if(encodedAt&&!gatedFrom&&frame>=encodedAt+30){for(id<MTLCommandBuffer> earlier:flight)[earlier waitUntilCompleted];flight.clear();gatedFrom=frame+1;gate.signaledValue=frame;}
        if(gatedFrom&&frame>=gatedFrom+179)break;
        std::this_thread::sleep_for(std::chrono::microseconds(16600));
    }}
    gate.signaledValue=limit+1;for(id<MTLCommandBuffer> commands:flight)[commands waitUntilCompleted];
    if(!gatedFrom)return fail("The ordered MetalFX scene did not reach the frames-in-flight segment");
    if(refused)return fail("With two earlier frames on the GPU, "+std::to_string(refused)+" of the 90 frames after 1.5 s were refused, the last at frame "+std::to_string(refusedLast)+": "+refusal);
    if(!encodedAt)return fail("The ordered MetalFX scene never encoded: "+last);

    // Receipts in the presenting window. No frame here completes on the GPU
    // until the end, so the scene's prepared images run out.
    [NSApplication sharedApplication];
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,1280,720) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    const auto authority=macfx::temporalSceneWindow((__bridge void*)window);if(!authority)return fail("The window has no scene authority");
    const auto presenter=std::make_shared<int>(0);macfx::noteSceneWindowPresenter(presenter,authority,device);
    auto finalImage=image(device,MTLPixelFormatBGRA8Unorm,1280,720,colour);id<MTLSharedEvent> hold=[device newSharedEvent];
    std::vector<id<MTLCommandBuffer>> held;unsigned scene=0,scenes=0,reuses=0;std::string outcome;
    for(unsigned frame=limit+1;frame<=limit+48&&reuses<4;++frame){@autoreleasepool{
        id<MTLCommandBuffer> commands=[queue commandBuffer];[commands encodeWaitForEvent:hold value:1];
        RSTemporalFrame f=sceneFrame(commands,frame);RSTemporalResult r{};r.size=sizeof(r);r.version=1;
        const int code=rsProcessTemporalFrame(&f,&r);[commands commit];held.push_back(commands);
        const std::string reason=std::to_string(code)+" encoded="+std::to_string(r.encoded)+" "+r.reason;if(reason!=outcome){std::printf("receipt frame %u: %s\n",frame,reason.c_str());outcome=reason;}
        const auto receipt=macfx::temporalSceneContinuation(authority,finalImage);
        if(code==RS_TEMPORAL_OK&&r.encoded){
            if(!receipt||receipt->frameId()!=frame)return fail("The final image after encoded scene "+std::to_string(frame)+" lacks its receipt");scene=frame;++scenes;
        }else if(!scene){
            if(receipt)return fail("A refused frame before any scene in this window has a receipt");
        }else{
            if(!receipt)return fail("The image reused at frame "+std::to_string(frame)+" lacks the receipt of scene "+std::to_string(scene)+": "+reason);
            if(receipt->frameId()!=scene)return fail("The image reused at frame "+std::to_string(frame)+" carries receipt "+std::to_string(receipt->frameId())+", not scene "+std::to_string(scene));
            ++reuses;
        }
        if(receipt&&!receipt->claim([queue commandBuffer],finalImage))return fail("The final image cannot claim its receipt");
        if(macfx::temporalSceneContinuation(authority,finalImage))return fail("A claimed receipt serves a second final image");
        std::this_thread::sleep_for(std::chrono::microseconds(16600));
    }}
    hold.signaledValue=1;for(id<MTLCommandBuffer> commands:held)[commands waitUntilCompleted];
    if(!scenes||!reuses)return fail("With every prepared image held, "+std::to_string(scenes)+" scenes encoded and "+std::to_string(reuses)+" were refused: "+outcome);
    if(macfx::temporalSceneContinuation(authority,finalImage))return fail("The final image after the scene stopped has a receipt");
    [window close];
    std::printf("Receipts: %u scenes each with its own, %u refused frames each with the receipt of scene %u, none after the scene stopped\n",scenes,reuses,scene);
    std::printf("Ordered MetalFX scene intake (RG11B10Float 853x480 in 1280x720): encoded from frame %u, and with two earlier frames on the GPU: pass\n",encodedAt);
    return 0;
}}
