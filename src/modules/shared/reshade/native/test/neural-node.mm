// Copyright (c) MacLauncher contributors. MIT license.
#include "neural-node.hpp"
#include "effects-execution.hpp"
#import <Metal/Metal.h>
#include <array>
#include <cassert>
#include <chrono>
#include <thread>
#include <cstdio>
int main(int argc,char **argv){@autoreleasepool{
#if !defined(__arm64__)
    std::puts("Neural rendering requires Apple Silicon");return 77;
#endif
    if(@available(macOS 14.0,*)){}else {std::puts("Neural rendering requires macOS 14 or later");return 77;}
    assert(argc==2);setenv("RESHADE_NEURAL_LIBRARY",argv[1],1);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Neural node GPU ordering timed out\n",stderr);std::_Exit(2);});
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto source=[device newTextureWithDescriptor:d],target=[device newTextureWithDescriptor:d];
    std::array<unsigned char,32*24*4> pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=32;pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=64;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    auto node=macfx::makeNeuralNode({"/test/local-model",.25f,true});auto commands=[queue commandBuffer];
    macfx::ShaderFrame frame{commands,source,target,1};assert(node->prepare(frame).encoded&&commands.status<MTLCommandBufferStatusCommitted);
    assert(node->encode(frame).encoded&&commands.status<MTLCommandBufferStatusCommitted);
    auto busy=node->encode(frame);assert(!busy.encoded&&busy.busy);
    [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);
    std::array<unsigned char,32*24*4> output;[target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
    for(unsigned i=0;i<output.size();i+=4)assert(output[i]==32&&output[i+1]==191&&output[i+2]==64&&output[i+3]==64);
    [source getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
    NSString *planPath=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"neural-busy-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    NSDictionary *plan=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0],@"nodes":@[@{@"id":@"neural",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/test/local-model",@"settings":@{@"intensity":@0.25,@"temporal":@NO}}]};
    assert([[NSJSONSerialization dataWithJSONObject:plan options:0 error:nil] writeToFile:planPath atomically:YES]);setenv("RESHADE_EFFECT_PLAN",planPath.fileSystemRepresentation,1);
    macfx::EffectPlanExecutor executor;auto first=frame;first.commands=[queue commandBuffer];first.frameId=10;
    auto selected=executor.prepare(first);assert(selected.active&&selected.execution&&selected.error.empty());assert(selected.execution->encode(first).encoded);
    auto held=[device newTextureWithDescriptor:d];std::array<unsigned char,32*24*4> sentinel;sentinel.fill(37);[held replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:sentinel.data() bytesPerRow:128];
    auto second=first;second.commands=[queue commandBuffer];second.target=held;second.frameId=11;auto deferred=selected.execution->encode(second);assert(!deferred.encoded&&deferred.busy);
    [second.commands commit];[second.commands waitUntilCompleted];[held getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==sentinel);
    [first.commands commit];[first.commands waitUntilCompleted];assert(first.commands.status==MTLCommandBufferStatusCompleted);
    NSMutableDictionary *automatic=[@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"d" startingAtIndex:0],@"nodes":@[@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"ls1",@"settings":@{}}]} mutableCopy];
    assert([[NSJSONSerialization dataWithJSONObject:automatic options:0 error:nil] writeToFile:planPath atomically:YES]);
    macfx::EffectPlanExecutor fit;auto fitting=frame;fitting.commands=[queue commandBuffer];fitting.frameId=12;auto unchanged=fit.prepare(fitting);assert(unchanged.execution&&unchanged.error.empty());auto copied=unchanged.execution->encode(fitting);assert(copied.encoded&&copied.reason.empty());[fitting.commands commit];[fitting.commands waitUntilCompleted];
    [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
    automatic[@"revision"]=[@"" stringByPaddingToLength:64 withString:@"e" startingAtIndex:0];automatic[@"nodes"]=@[@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"ls1",@"settings":@{@"spatialMultiplier":@1}}];
    assert([[NSJSONSerialization dataWithJSONObject:automatic options:0 error:nil] writeToFile:planPath atomically:YES]);std::this_thread::sleep_for(std::chrono::milliseconds(110));fitting.commands=[queue commandBuffer];auto explicitFilter=fit.prepare(fitting);assert(!explicitFilter.error.empty()&&explicitFilter.execution==unchanged.execution);
    unsetenv("RESHADE_EFFECT_PLAN");assert([NSFileManager.defaultManager removeItemAtPath:planPath error:nil]);
    for(unsigned i=0;i<pixels.size();i+=4)pixels[i+3]=(i/4)%256;
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    auto opaque=macfx::makeNeuralNode({"/test/local-model",.5f,false});auto normalized=frame;normalized.commands=[queue commandBuffer];normalized.opaqueDisplay=true;
    assert(opaque->encode(normalized).encoded);[normalized.commands commit];[normalized.commands waitUntilCompleted];assert(normalized.commands.status==MTLCommandBufferStatusCompleted);
    [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
    // Proof provider returns input alpha in green: opaque frame processing
    // normalizes that model input, then restores every original alpha.
    for(unsigned i=0;i<output.size();i+=4)assert(output[i]==32&&output[i+1]==255&&output[i+2]==128&&output[i+3]==pixels[i+3]);
    [source getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
    assert(frame.opaqueDisplay); // Missing display metadata follows the opaque default.
    for(const auto format:{MTLPixelFormatBGRA8Unorm,MTLPixelFormatRGBA8Unorm})
    for(const auto origin:{macfx::FrameOrigin::TopLeft,macfx::FrameOrigin::BottomLeft})
    for(const bool opaqueInput:{false,true}){
        MTLTextureDescriptor *descriptor=[d copy];descriptor.pixelFormat=format;
        auto asymmetric=[device newTextureWithDescriptor:descriptor],result=[device newTextureWithDescriptor:descriptor];
        std::array<unsigned char,32*24*4> input,actual;
        const unsigned red=format==MTLPixelFormatBGRA8Unorm?2:0,blue=2-red;
        for(unsigned y=0;y<24;++y)for(unsigned x=0;x<32;++x){
            const unsigned uprightY=origin==macfx::FrameOrigin::BottomLeft?23-y:y,index=(y*32+x)*4;
            input[index+red]=10+uprightY*3+x;input[index+1]=70+uprightY;
            input[index+blue]=40+(x*3+uprightY*5)%127;input[index+3]=17+(x*13+uprightY*7)%220;
        }
        [asymmetric replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:input.data() bytesPerRow:128];
        auto oriented=macfx::makeNeuralNode({"/test/orientation",opaqueInput?1.f:.5f,false});
        auto work=[queue commandBuffer];macfx::ShaderFrame normalizedFrame{work,asymmetric,result,20};
        normalizedFrame.origin=origin;normalizedFrame.opaqueDisplay=opaqueInput;
        assert(oriented->encode(normalizedFrame).encoded);[work commit];[work waitUntilCompleted];
        assert(work.status==MTLCommandBufferStatusCompleted&&macfx::finishNeuralNode(oriented).encoded);
        [result getBytes:actual.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
        // The provider broadcasts model-top-left red/model-bottom-right blue,
        // writes its own upright row ramp and destroys alpha. A simple flipped
        // round trip cannot satisfy these independent model-input assertions.
        for(unsigned y=0;y<24;++y)for(unsigned x=0;x<32;++x){
            const unsigned uprightY=origin==macfx::FrameOrigin::BottomLeft?23-y:y,index=(y*32+x)*4;
            assert(actual[index+red]==10&&actual[index+1]==uprightY+1);
            assert(actual[index+blue]==(opaqueInput?40+(31*3+23*5)%127:input[index+3]));
            assert(actual[index+3]==input[index+3]);
        }
        [asymmetric getBytes:actual.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(actual==input);
    }
    auto unsupported=macfx::makeNeuralNode({"/test/local-model",.25f,false});auto transparent=frame;transparent.opaqueDisplay=false;transparent.commands=[queue commandBuffer];
    setenv("MACLAUNCHER_TEST_NEURAL_UNSUPPORTED","1",1);assert(unsupported->encode(transparent).encoded);[transparent.commands commit];[transparent.commands waitUntilCompleted];
    unsetenv("MACLAUNCHER_TEST_NEURAL_UNSUPPORTED");transparent.commands=[queue commandBuffer];for(unsigned i=0;i<100&&unsupported->prepare(transparent).encoded;++i)std::this_thread::sleep_for(std::chrono::milliseconds(1));auto stable=unsupported->encode(transparent);assert(!stable.encoded&&!stable.busy&&stable.reason=="Neural rendering requires an opaque SDR frame");
    transparent.opaqueDisplay=true;assert(unsupported->encode(transparent).encoded);[transparent.commands commit];[transparent.commands waitUntilCompleted];assert(transparent.commands.status==MTLCommandBufferStatusCompleted);
    auto hdr=frame;hdr.color=macfx::SpatialColor::Linear;hdr.commands=[queue commandBuffer];assert(!node->prepare(hdr).encoded);
    auto abandoned=macfx::makeNeuralNode({"/test/local-model",1,false});auto delayed=[queue commandBuffer];frame.commands=delayed;frame.frameId=2;assert(abandoned->encode(frame).encoded);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    auto unavailable=frame;unavailable.commands=[queue commandBuffer];assert(!abandoned->prepare(unavailable).encoded);
    [delayed commit];[delayed waitUntilCompleted];assert(delayed.status==MTLCommandBufferStatusCompleted);
    [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
    std::puts("neural node: borrowed submission, upright model input, declared output origin, exact alpha, busy admission, SDR guard and abandoned-frame fallback pass");return 0;
}}
