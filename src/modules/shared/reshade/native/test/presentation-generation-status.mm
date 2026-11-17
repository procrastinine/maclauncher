// Copyright (c) MacLauncher contributors. MIT license.
// A frame-generation stage reports Completed for a frame whose command buffer
// completed. Generation completions settle in completed handlers that their
// providers and the image-pair analysis add while encoding; the presenter reads
// them from a handler it adds after every generator has encoded.
#include "presentation.hpp"
#include "fixture-files.hpp"
#include "fixture-colour-shaders.hpp"
#include "effects-execution.hpp"
#include "process-phase.hpp"
#include "runtime-status.hpp"
#import <Cocoa/Cocoa.h>
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <sys/mman.h>
#include <unistd.h>
#include <vector>

namespace {
using namespace macfx::runtime_status;
NSString *shaderRoot;
NSString *hex(NSString *value){return [@"" stringByPaddingToLength:64 withString:value startingAtIndex:0];}
NSDictionary *shader(NSString *name){return @{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":fixture::colourShaderPath(shaderRoot,[name isEqual:@"prefix"]),@"parameters":@{@"Gain":@[[name isEqual:@"prefix"]?@0.3:@0.8]},@"key":hex(@"a"),@"revision":hex(@"b"),@"preservesCoordinates":@YES};}
uint64_t milliseconds(){return uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());}
void idle(double seconds){const auto end=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);}
// The inspector holds the page's lease for at most ten seconds at a time.
void lease(unsigned char *page){__atomic_store_n(&reinterpret_cast<Header*>(page)->leaseUntil,milliseconds()+8000,__ATOMIC_RELEASE);}
const Stage *generationRow(const unsigned char *page){
    for(unsigned slot=0;slot<slotCount;++slot){
        const auto context=reinterpret_cast<const Context*>(page+headerSize+size_t(slot)*slotSize);
        const unsigned stages=std::min<uint32_t>(context->stages,stageCount);
        for(unsigned index=0;index<stages;++index)if(!strncmp(context->rows[index].id,"generation",sizeof(context->rows[index].id)))return &context->rows[index];
    }
    return nullptr;
}
void paint(id<MTLTexture>source,unsigned frame){
    std::vector<unsigned char>pixels(256*192*4);
    for(unsigned y=0;y<192;++y)for(unsigned x=0;x<256;++x){const auto at=(y*256+x)*4;const bool bar=(x+frame*6)%256<24;pixels[at]=bar?250:x;pixels[at+1]=bar?250:y;pixels[at+2]=120;pixels[at+3]=255;}
    [source replaceRegion:MTLRegionMake2D(0,0,256,192)mipmapLevel:0 withBytes:pixels.data()bytesPerRow:256*4];
}
}
int main(int argc,char **argv){@autoreleasepool{
    // The explicit host, plan file and inspector page are launch settings, so
    // the check runs as a phase launched with them.
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        char temporary[1024];temporaryPath(temporary,"maclauncher-generation-status-XXXXXX");assert(mkdtemp(temporary));NSString *directory=@(temporary);fixture::writeColourShaders(directory);
        NSString *status=[directory stringByAppendingPathComponent:@"status.bin"];
        auto bytes=[NSMutableData dataWithLength:pageSize];auto header=static_cast<Header*>(bytes.mutableBytes);
        memcpy(header->magic,"MLFXSTS1",8);header->version=schema;header->bytes=pageSize;header->leaseUntil=milliseconds()+8000;memset(header->token,'a',64);memcpy(header->launchId,"generation",10);header->launchIdLength=10;
        assert([bytes writeToFile:status options:0 error:nil]);
        const std::string token(64,'a');
        const int result=fixture::runPhase("status",{{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation},
            {"RESHADE_RUNTIME_STATUS_FILE",status.fileSystemRepresentation},{"RESHADE_RUNTIME_STATUS_TOKEN",token.c_str()},{"RESHADE_RUNTIME_STATUS_LAUNCH_ID","generation"}},{temporary});
        [NSFileManager.defaultManager removeItemAtPath:directory error:nil];return result;
    }
    assert(phase.argc==2);NSString *directory=@(phase.argv[1]);shaderRoot=directory;
    const int descriptor=open([directory stringByAppendingPathComponent:@"status.bin"].fileSystemRepresentation,O_RDWR|O_CLOEXEC);assert(descriptor>=0);
    auto page=static_cast<unsigned char*>(mmap(nullptr,pageSize,PROT_READ|PROT_WRITE,MAP_SHARED,descriptor,0));close(descriptor);assert(page!=MAP_FAILED);
    // An image-pair provider with static-content blending: the stage's
    // completion also waits for the image-pair analysis of the same frame.
    auto generation=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"vision-flow",@"settings":@{@"frameMultiplier":@2,@"framePacing":@"fixed",@"targetFps":@60,@"keepStaticContent":@YES}};
    auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(@"c"),@"nodes":@[shader(@"prefix"),generation,shader(@"suffix")]};
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],[directory stringByAppendingPathComponent:@"plan.json"]));macfx::refreshEffectPlan();
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(-4000,-4000,256,192)styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    auto layer=[CAMetalLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.opaque=YES;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(256,192);
    auto texture=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:256 height:192 mipmapped:NO];texture.storageMode=MTLStorageModeShared;texture.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto source=[device newTextureWithDescriptor:texture];assert(source);
    int owner=0;macfx::FramePresenter presenter(layer,&owner);uint64_t frame=0;const Stage *row=nullptr;std::string reason;
    for(const auto deadline=CACurrentMediaTime()+20;CACurrentMediaTime()<deadline;){
        lease(page);paint(source,unsigned(frame));
        auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,source,++frame,CACurrentMediaTime());[commands commit];[commands waitUntilCompleted];idle(.03);
        if(!result.encoded&&!result.busy)reason=result.reason;
        row=generationRow(page);if(row&&row->completed)break;
    }
    if(!row||!row->completed){
        if(row)std::fprintf(stderr,"Generation stage: phase=%u encoded=%llu completed=%llu reason=%.*s\n",row->phase,(unsigned long long)row->encoded,(unsigned long long)row->completed,int(strnlen(row->reason,sizeof(row->reason))),row->reason);
        else std::fprintf(stderr,"Generation stage: no status row after %llu frames; presenter=%s status=%s\n",(unsigned long long)frame,reason.c_str(),presenter.snapshot().reason.c_str());
    }
    assert(row&&row->completed>0);
    presenter.stop();idle(.05);[window close];munmap(page,pageSize);
    std::puts("Generation stage status: Completed after its command buffer completed, with image-pair analysis");
}}
