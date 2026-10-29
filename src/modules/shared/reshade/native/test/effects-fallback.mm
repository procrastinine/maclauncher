// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#include "fixture-files.hpp"
#include "view-presentation.hpp"
#include "frame.h"
#include "image-admission.hpp"
#include "temporal-provider.hpp"
#include "process-phase.hpp"
#include "runtime-status.hpp"
#include "fsr1.hpp"
#include "fsr1-budget.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <optional>
#include <thread>
#include <unistd.h>
#include <vector>
namespace {
unsigned partialCalls=0;
unsigned brightWidth=0,partialWidth=0;
uint64_t expectedFrameId=0;
// prepare() declares LegacySDR (sRGB), so its provider envelope is perceptual.
macfx::SpatialColor expectedColor=macfx::SpatialColor::Perceptual;
macfx::FrameOrigin expectedOrigin=macfx::FrameOrigin::BottomLeft;
bool expectedOpaque=false;
bool temporalFixture=false;
unsigned temporalCalls=0,temporalProbeCalls=0,temporalReleases=0;
bool shaderBusy=false;unsigned afterBusyCalls=0;
void *lastShaderTarget=nullptr;
std::atomic<bool> delayedPrepareStarted=false,releaseDelayedPrepare=false,delayedPrepareFinished=false;
uint32_t temporalProbeStatus=RS_TEMPORAL_OK,temporalEncodeStatus=RS_TEMPORAL_FAILED;
void stamp(macfx::ShaderFrame &frame,uint64_t id){
    expectedFrameId=frame.frameId=id;frame.timeMs=id*12.5;frame.frameTimeMs=12.5f;
    frame.origin=expectedOrigin;frame.color=expectedColor;frame.opaqueDisplay=expectedOpaque;
}
void metadata(const macfx::ShaderFrame &frame){
    assert(frame.frameId==expectedFrameId&&frame.timeMs==expectedFrameId*12.5&&frame.frameTimeMs==12.5f);
    assert(frame.origin==expectedOrigin&&frame.color==expectedColor&&frame.opaqueDisplay==expectedOpaque);
    assert(frame.source&&frame.target&&frame.source.width&&frame.source.height&&frame.target.width&&frame.target.height);
}
struct Shader final:macfx::ShaderNode {
    std::string file;id<MTLComputePipelineState> kernel;
    macfx::ShaderParameters parameters;
    unsigned preparedSourceWidth=0,preparedSourceHeight=0,preparedTargetWidth=0,preparedTargetHeight=0;
    macfx::FrameOrigin preparedOrigin=macfx::FrameOrigin::BottomLeft;
    explicit Shader(const std::string &value):file(value){}
    void setParameters(const macfx::ShaderParameters &value)override{
        const auto reject=value.find("Reject");
        if(reject!=value.end()&&reject->second[0]<0)throw std::runtime_error("Shader parameter unavailable");
        parameters=value;
    }
    macfx::ShaderResult prepare(const macfx::ShaderFrame &frame)override{
        metadata(frame);
        preparedSourceWidth=frame.source.width;preparedSourceHeight=frame.source.height;
        preparedTargetWidth=frame.target.width;preparedTargetHeight=frame.target.height;
        preparedOrigin=frame.origin;
        if(file=="/proof/prepare-fails")throw std::runtime_error("Prepared shader unavailable");
        if(file=="/proof/prepare-delayed"){
            delayedPrepareStarted.store(true,std::memory_order_release);
            const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
            while(!releaseDelayedPrepare.load(std::memory_order_acquire)){
                assert(std::chrono::steady_clock::now()<deadline);
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        }
        if(!kernel){NSError *error=nil;auto library=[frame.commands.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void proof(texture2d<float,access::read> a [[texture(0)]],texture2d<float,access::write> b [[texture(1)]],constant uint &mode [[buffer(0)]],uint2 q [[thread_position_in_grid]]){if(q.x>=b.get_width()||q.y>=b.get_height())return;uint2 p=uint2(float2(q)*float2(a.get_width(),a.get_height())/float2(b.get_width(),b.get_height()));float4 v=a.read(p);v.g=1;if(mode==2)v.r=200.0/255.0;b.write(mode==1?float4(0):v,q);}" options:nil error:&error];kernel=[frame.commands.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"proof"] error:&error];assert(kernel);}
        if(file=="/proof/prepare-delayed")delayedPrepareFinished.store(true,std::memory_order_release);
        return {true,{}};
    }
    macfx::ShaderResult encode(const macfx::ShaderFrame &frame)override{
        metadata(frame);
        const bool partial=file=="/proof/encode-fails",busy=shaderBusy&&file=="/proof/encode-busy";
        if(file=="/proof/after-busy")++afterBusyCalls;
        lastShaderTarget=(__bridge void*)frame.target;
        auto encoder=[frame.commands computeCommandEncoder];unsigned clear=partial||busy?1:file=="/proof/generation-suffix"?2:0;
        if(partial)partialWidth=frame.source.width;else brightWidth=frame.target.width;
        [encoder setComputePipelineState:kernel];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.target atIndex:1];[encoder setBytes:&clear length:sizeof(clear) atIndex:0];
        [encoder dispatchThreads:MTLSizeMake(frame.target.width,frame.target.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        if(partial){++partialCalls;throw std::runtime_error("Shader stopped after a partial write");}
        if(busy)return {false,"Controlled shader resources busy",true};
        return {true,{}};
    }
};
std::map<std::string,std::weak_ptr<Shader>> lastShader;
std::map<std::string,unsigned> shaderCreates;
std::vector<std::shared_ptr<Shader>> *capturedShaders=nullptr;
NSString *hex(NSString *c){return [@"" stringByPaddingToLength:64 withString:c startingAtIndex:0];}
NSDictionary *shader(NSString *name,NSString *file){return @{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":file,@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":@{},@"preservesCoordinates":@YES};}
void publishNodes(NSString *path,NSString *revision,NSArray *nodes){
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":nodes} options:0 error:nil];assert(replaceFile(bytes,path));
    std::this_thread::sleep_for(std::chrono::milliseconds(110));
}
void publish(NSString *path,NSString *revision,NSString *failing,NSDictionary *scale=nil,bool generation=false){
    NSMutableDictionary *first=[shader(@"first",@"/proof/bright")mutableCopy];if(scale)first[@"outputScale"]=scale;
    NSMutableArray *nodes=[@[first,shader(@"middle",failing),@{@"id":@"last",@"kind":@"spatial",@"enabled":@YES,@"method":@"bilinear",@"settings":@{@"spatialMultiplier":@2}}]mutableCopy];
    if(generation)[nodes insertObject:@{@"id":@"unavailable-generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/unavailable/model",@"settings":@{}} atIndex:1];
    publishNodes(path,revision,nodes);
}
std::vector<unsigned char> readPixels(id<MTLTexture> output){std::vector<unsigned char> pixels(output.width*output.height*4);[output getBytes:pixels.data() bytesPerRow:output.width*4 fromRegion:MTLRegionMake2D(0,0,output.width,output.height) mipmapLevel:0];return pixels;}
void verify(id<MTLTexture> output,unsigned alpha=64,unsigned red=140,bool gradient=true){const auto pixels=readPixels(output);for(unsigned i=0;i<pixels.size();i+=4)assert(pixels[i+1]==255&&pixels[i+2]==red&&pixels[i+3]==alpha);if(gradient)assert(pixels[0]<=20&&pixels[(output.height-1)*output.width*4]>=100);}
// Poll the production nonblocking preparation seam. Each observation owns a
// fresh unsubmitted buffer; no pending candidate is ever encoded or committed.
macfx::EffectExecutionSelection prepared(macfx::EffectPlanExecutor &executor,const macfx::ShaderFrame &frame,bool presentation=false,const RSTemporalFrame *temporal=nullptr,macfx::ImageColorSpace color=macfx::ImageColorSpace::LegacySDR){
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(8);
    for(;;){@autoreleasepool{
        auto observation=frame;observation.commands=[frame.commands.commandQueue commandBuffer];assert(observation.commands);
        auto scene=temporal?std::optional<RSTemporalFrame>(*temporal):std::nullopt;
        if(scene)scene->commandBuffer=(__bridge void*)observation.commands;
        auto selected=executor.prepareWithColor(observation,presentation,scene?&*scene:nullptr,color);
        assert(observation.commands.status<MTLCommandBufferStatusCommitted);
        if(!selected.preparing)return selected;
        if(std::chrono::steady_clock::now()>=deadline){std::fprintf(stderr,"Async preparation timed out: %s\n",selected.error.c_str());std::_Exit(1);}
    }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}
void candidateGeometry(NSString *path,id<MTLCommandQueue>queue,id<MTLTexture>input,id<MTLTexture>output){
    assert(input.width==32&&input.height==24&&output.width==64&&output.height==48);
    std::printf("candidate geometry device=%s source=32x24 target=64x48 offscreen; no window\n",queue.device.name.UTF8String);std::fflush(stdout);
    const auto sourcePixels=readPixels(input);
    std::vector<std::shared_ptr<Shader>> created;assert(!capturedShaders);capturedShaders=&created;
    struct ResetCapture {~ResetCapture(){capturedShaders=nullptr;}} resetCapture;
    const std::string prefixFile="/proof/candidate-geometry-prefix",sizingFile="/proof/candidate-geometry-sizing",historyFile="/proof/candidate-geometry-history";
    const auto newest=[&](const std::string &file){for(auto it=created.rbegin();it!=created.rend();++it)if((*it)->file==file)return *it;return std::shared_ptr<Shader>{};};
    const auto extent=[](const std::shared_ptr<Shader> &node,unsigned sw,unsigned sh,unsigned tw,unsigned th){assert(node&&node->preparedSourceWidth==sw&&node->preparedSourceHeight==sh&&node->preparedTargetWidth==tw&&node->preparedTargetHeight==th);};
    auto prefix=shader(@"geometry-prefix",@(prefixFile.c_str()));
    NSMutableDictionary *sizing=[shader(@"geometry-sizing",@(sizingFile.c_str()))mutableCopy];
    auto history=shader(@"geometry-history",@(historyFile.c_str()));
    NSMutableDictionary *tail=[shader(@"geometry-tail",@"/proof/candidate-geometry-tail")mutableCopy];tail[@"parameters"]=@{@"Gain":@[@0.5]};
    const auto nodes=@[prefix,sizing,history,tail];
    macfx::EffectPlanExecutor executor;uint64_t frameId=100;
    const auto prepare=[&](bool checkPending=false,bool holdPrevious=false){auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,++frameId);
        if(checkPending){const auto pending=executor.prepare(frame);assert(pending.preparing&&pending.holdPrevious==holdPrevious);assert(commands.status<MTLCommandBufferStatusCommitted);}
        return std::make_pair(prepared(executor,frame),frame);};
    const auto encode=[&](const std::shared_ptr<macfx::EffectExecution> &execution,macfx::ShaderFrame frame){assert(execution->encode(frame).encoded);[frame.commands commit];[frame.commands waitUntilCompleted];assert(frame.commands.status==MTLCommandBufferStatusCompleted);verify(frame.target);assert(readPixels(input)==sourcePixels);};
    publishNodes(path,@"7",nodes);auto initial=prepare(true,true);const auto accepted=initial.first.execution;assert(accepted&&initial.first.error.empty());
    const auto oldPrefix=newest(prefixFile),oldSizing=newest(sizingFile),oldHistory=newest(historyFile);
    extent(oldPrefix,32,24,32,24);extent(oldSizing,32,24,32,24);extent(oldHistory,32,24,32,24);encode(accepted,initial.second);
    // Candidate preparation must not resize an accepted node. A later row that
    // rejects its edit at a new extent is bypassed and the resize applies. The
    // prefix has the same true input contract.
    sizing[@"outputExtent"]=@"presentation";tail[@"parameters"]=@{@"Reject":@[@(-1)]};
    publishNodes(path,@"8",nodes);auto rejected=prepare(true,false);
    if(rejected.first.execution==accepted)std::fprintf(stderr,"rejected tail kept the accepted execution: %s\n",rejected.first.error.c_str());
    assert(rejected.first.execution&&rejected.first.execution!=accepted&&!rejected.first.holdPrevious);
    std::printf("rejected candidate accepted sizing target=%ux%u history source=%ux%u reason=%s\n",oldSizing->preparedTargetWidth,oldSizing->preparedTargetHeight,oldHistory->preparedSourceWidth,oldHistory->preparedSourceHeight,rejected.first.error.c_str());std::fflush(stdout);
    extent(oldSizing,32,24,32,24);extent(oldHistory,32,24,32,24);
    const auto rejectedSizing=newest(sizingFile),rejectedHistory=newest(historyFile);
    assert(rejectedSizing!=oldSizing&&rejectedHistory!=oldHistory);
    extent(rejectedSizing,32,24,64,48);extent(rejectedHistory,64,48,64,48);
    assert(shaderCreates[prefixFile]==1&&newest(prefixFile)==oldPrefix&&shaderCreates[sizingFile]==2&&shaderCreates[historyFile]==2);encode(accepted,rejected.second);
    tail[@"parameters"]=@{@"Gain":@[@0.5]};publishNodes(path,@"9",nodes);auto recovered=prepare();assert(recovered.first.execution&&recovered.first.execution!=accepted&&recovered.first.error.empty());
    // The adopted presentation-sized nodes are reused; only the tail is new.
    const auto newSizing=newest(sizingFile),newHistory=newest(historyFile);
    assert(newSizing==rejectedSizing&&newHistory==rejectedHistory&&shaderCreates[sizingFile]==2&&shaderCreates[historyFile]==2);
    extent(newSizing,32,24,64,48);extent(newHistory,64,48,64,48);extent(oldSizing,32,24,32,24);extent(oldHistory,32,24,32,24);
    assert(shaderCreates[prefixFile]==1&&newest(prefixFile)==oldPrefix);encode(recovered.first.execution,recovered.second);
    // A retained older execution still encodes its original 32x24 rows after
    // replacement. Restoring local sizing creates another isolated suffix.
    auto late=[queue commandBuffer];macfx::ShaderFrame oldFrame{late,input,output};stamp(oldFrame,++frameId);encode(accepted,oldFrame);
    [sizing removeObjectForKey:@"outputExtent"];publishNodes(path,@"a",nodes);auto restored=prepare();assert(restored.first.execution&&restored.first.execution!=recovered.first.execution&&restored.first.error.empty());
    const auto restoredSizing=newest(sizingFile),restoredHistory=newest(historyFile);
    assert(restoredSizing!=oldSizing&&restoredSizing!=newSizing&&restoredHistory!=oldHistory&&restoredHistory!=newHistory);
    extent(restoredSizing,32,24,32,24);extent(restoredHistory,32,24,32,24);extent(newSizing,32,24,64,48);extent(newHistory,64,48,64,48);
    extent(oldSizing,32,24,32,24);extent(oldHistory,32,24,32,24);assert(shaderCreates[prefixFile]==1&&newest(prefixFile)==oldPrefix);encode(restored.first.execution,restored.second);
    // A drawable-only resize must preserve fixed-size source stages and their
    // histories. Presentation-relative stages still get isolated resources.
    const auto resizeOutput=[&](unsigned width,unsigned height){
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:output.pixelFormat width:width height:height mipmapped:NO];
        descriptor.storageMode=MTLStorageModeShared;descriptor.usage=output.usage;
        output=[queue.device newTextureWithDescriptor:descriptor];assert(output);
    };
    const auto fixedCounts=shaderCreates;resizeOutput(96,72);auto fixedResize=prepare(true,true);
    assert(fixedResize.first.execution&&fixedResize.first.error.empty());
    assert(shaderCreates==fixedCounts&&newest(prefixFile)==oldPrefix&&newest(sizingFile)==restoredSizing&&newest(historyFile)==restoredHistory);
    extent(restoredSizing,32,24,32,24);extent(restoredHistory,32,24,32,24);encode(fixedResize.first.execution,fixedResize.second);
    sizing[@"outputExtent"]=@"presentation";publishNodes(path,@"b",nodes);auto presented=prepare();
    assert(presented.first.execution&&presented.first.error.empty());
    const auto presentedSizing=newest(sizingFile),presentedHistory=newest(historyFile);
    extent(presentedSizing,32,24,96,72);extent(presentedHistory,96,72,96,72);encode(presented.first.execution,presented.second);
    const auto retainedTarget=output;
    resizeOutput(128,96);const std::vector<unsigned char> sentinel(output.width*output.height*4,0x7d);
    [output replaceRegion:MTLRegionMake2D(0,0,output.width,output.height)mipmapLevel:0 withBytes:sentinel.data()bytesPerRow:output.width*4];
    tail[@"parameters"]=@{@"Reject":@[@(-1)]};publishNodes(path,@"c",nodes);auto rejectedResize=prepare(true,true);
    if(rejectedResize.first.execution==presented.first.execution)std::fprintf(stderr,"rejected resized tail kept the presented execution: %s\n",rejectedResize.first.error.c_str());
    assert(rejectedResize.first.execution&&rejectedResize.first.execution!=presented.first.execution);
    extent(presentedSizing,32,24,96,72);extent(presentedHistory,96,72,96,72);
    extent(newest(sizingFile),32,24,128,96);extent(newest(historyFile),128,96,128,96);
    assert(newest(sizingFile)!=presentedSizing&&newest(historyFile)!=presentedHistory&&newest(prefixFile)==oldPrefix&&shaderCreates[prefixFile]==1);
    assert(readPixels(output)==sentinel);
    auto retainedFrame=rejectedResize.second;retainedFrame.target=retainedTarget;encode(presented.first.execution,retainedFrame);
    assert(readPixels(output)==sentinel);
    tail[@"parameters"]=@{@"Gain":@[@0.5]};publishNodes(path,@"d",nodes);auto recoveredResize=prepare();
    assert(recoveredResize.first.execution&&recoveredResize.first.error.empty());
    extent(newest(sizingFile),32,24,128,96);extent(newest(historyFile),128,96,128,96);
    extent(presentedSizing,32,24,96,72);extent(presentedHistory,96,72,96,72);
    assert(newest(prefixFile)==oldPrefix&&shaderCreates[prefixFile]==1);encode(recoveredResize.first.execution,recoveredResize.second);
    std::puts("ordered candidate geometry: presentation sizing with a rejected tail preserved accepted shader/history extents and applied without the tail, stable prefix reused, recovery and reverse toggle isolated retained nodes, completed pixels/source preserved");
    std::puts("drawable-only resize retained fixed source history; presentation-sized replacement isolated changed extents and failed suffix, then recovered");
}
// A final FX row renders straight into a target that can serve as a working
// image; any other target receives the row's working image by the final fit.
void directFinal(NSString *path,id<MTLDevice> device,id<MTLCommandQueue> queue,id<MTLTexture> input){
    publishNodes(path,@"7",@[shader(@"direct",@"/proof/bright")]);std::vector<unsigned char> expected;
    for(const bool working:{false,true}){
        auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];d.storageMode=MTLStorageModeShared;
        MTLTextureUsage usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;if(working)usage|=MTLTextureUsagePixelFormatView;d.usage=usage;
        auto output=[device newTextureWithDescriptor:d];macfx::EffectPlanExecutor executor;auto commands=[queue commandBuffer];macfx::ShaderFrame context{commands,input,output};stamp(context,20+working);
        auto selected=prepared(executor,context);assert(selected.execution&&selected.error.empty());lastShaderTarget=nullptr;assert(selected.execution->encode(context).encoded);
        [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);
        assert((lastShaderTarget==(__bridge void*)output)==working);
        if(working)assert(readPixels(output)==expected);else expected=readPixels(output);
    }
}
void pendingOff(NSString *path,id<MTLCommandQueue>queue,id<MTLTexture>input,id<MTLTexture>output){
    macfx::EffectPlanExecutor executor;auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,200);
    publishNodes(path,@"1",@[shader(@"accepted",@"/proof/off-accepted")]);const auto accepted=prepared(executor,frame);assert(accepted.execution&&accepted.error.empty());
    assert(accepted.execution->encode(frame).encoded);[commands commit];[commands waitUntilCompleted];verify(output);const auto pixels=readPixels(output);
    publishNodes(path,@"2",@[shader(@"pending",@"/proof/prepare-delayed")]);commands=[queue commandBuffer];frame.commands=commands;stamp(frame,201);
    const auto pending=executor.prepare(frame);assert(pending.preparing&&!pending.holdPrevious&&pending.execution==accepted.execution);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
    while(!delayedPrepareStarted.load(std::memory_order_acquire)){assert(std::chrono::steady_clock::now()<deadline);std::this_thread::sleep_for(std::chrono::milliseconds(1));}
    // The provider is deliberately held on its worker. Off must still return,
    // and a late completion must never re-enable the cancelled candidate.
    publishNodes(path,@"3",@[]);const auto off=executor.prepare(frame);assert(!off.active&&!off.execution&&!off.preparing);
    assert(!releaseDelayedPrepare.load()&&commands.status<MTLCommandBufferStatusCommitted&&readPixels(output)==pixels);
    releaseDelayedPrepare.store(true,std::memory_order_release);
    while(!delayedPrepareFinished.load(std::memory_order_acquire)){
        const auto stillOff=executor.prepare(frame);assert(!stillOff.active&&!stillOff.execution&&!stillOff.preparing);
        assert(std::chrono::steady_clock::now()<deadline);std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const auto stale=executor.prepare(frame);assert(!stale.active&&!stale.execution&&!stale.preparing&&readPixels(output)==pixels);
    publishNodes(path,@"4",@[shader(@"restored",@"/proof/off-restored")]);const auto restored=prepared(executor,frame);
    assert(restored.active&&restored.execution&&restored.execution->revision()==hex(@"4").UTF8String&&restored.error.empty());
    assert(restored.execution->encode(frame).encoded);[commands commit];[commands waitUntilCompleted];verify(output);
    std::puts("async live switching: accepted image retained during preparation, Off returned while provider was held, stale candidate stayed cancelled, On accepted exact new revision");
}
void originContract(NSString *path,id<MTLCommandQueue>queue,id<MTLTexture>input,id<MTLTexture>output){
    const auto original=readPixels(input);const std::string file="/proof/origin-contract";
    macfx::EffectPlanExecutor executor;publishNodes(path,@"1",@[shader(@"origin",@(file.c_str()))]);
    expectedOrigin=macfx::FrameOrigin::TopLeft;auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,300);
    const auto accepted=prepared(executor,frame);assert(accepted.execution&&accepted.error.empty());
    const auto top=lastShader[file].lock();assert(top&&top->preparedOrigin==macfx::FrameOrigin::TopLeft&&shaderCreates[file]==1);
    assert(accepted.execution->encode(frame).encoded);[commands commit];[commands waitUntilCompleted];verify(output);const auto held=readPixels(output);
    expectedOrigin=macfx::FrameOrigin::BottomLeft;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,301);
    const auto pending=executor.prepare(frame);assert(pending.preparing&&pending.holdPrevious&&pending.execution==accepted.execution);
    assert(commands.status<MTLCommandBufferStatusCommitted&&readPixels(output)==held);
    const auto replaced=prepared(executor,frame);assert(replaced.execution&&replaced.execution!=accepted.execution&&replaced.error.empty());
    const auto bottom=lastShader[file].lock();assert(bottom&&bottom!=top&&bottom->preparedOrigin==macfx::FrameOrigin::BottomLeft&&shaderCreates[file]==2);
    assert(top->preparedOrigin==macfx::FrameOrigin::TopLeft);
    assert(replaced.execution->encode(frame).encoded);[commands commit];[commands waitUntilCompleted];verify(output);assert(readPixels(input)==original);
    std::puts("typed origin contract: TopLeft-to-BottomLeft held accepted image, re-prepared isolated shader/history with exact new origin, completed expected pixels and preserved source");
}
int generationGeometry(NSString *directory,NSString *path,id<MTLDevice>device,id<MTLCommandQueue>queue,NSString *model){
    assert([NSFileManager.defaultManager fileExistsAtPath:model]);expectedColor=macfx::SpatialColor::Perceptual;expectedOpaque=true;
    const auto texture=[&](unsigned w,unsigned h){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto image=[device newTextureWithDescriptor:descriptor];assert(image);return image;};
    auto fg=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":model,@"settings":@{@"frameMultiplier":@2,@"lsfgMode":@"performance",@"lsfgFp16":@YES,@"lsfgFlowScale":@0.5}};
    auto fit=@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"bilinear",@"settings":@{}};
    macfx::EffectPlanExecutor executor;uint64_t sequence=0;std::string modelHash;
    const auto exercise=[&](unsigned sw,unsigned sh,unsigned ow,unsigned oh,bool scaleBefore,bool includeScale){
        auto source=texture(sw,sh),output=texture(ow,oh),generatedOutput=texture(ow,oh);
        std::vector<unsigned char> original(sw*sh*4);for(unsigned y=0;y<sh;++y)for(unsigned x=0;x<sw;++x){auto *p=&original[(y*sw+x)*4];p[0]=16+(y*92/(sh-1));p[1]=80;p[2]=140;p[3]=255;}
        [source replaceRegion:MTLRegionMake2D(0,0,sw,sh)mipmapLevel:0 withBytes:original.data()bytesPerRow:sw*4];
        const unsigned gw=scaleBefore?ow:sw,gh=scaleBefore?oh:sh;auto working=texture(gw,gh),generated=texture(gw,gh);
        for(unsigned i=0;i<3;++i){auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,source,output};stamp(frame,++sequence);
            const auto selected=prepared(executor,frame,true);
            if(!selected.execution||!selected.error.empty()||!selected.execution->generator())std::fprintf(stderr,"generation selection %ux%u->%ux%u: execution=%d generator=%d error=%s\n",sw,sh,ow,oh,int(bool(selected.execution)),int(selected.execution&&selected.execution->generator()),selected.error.c_str());
            assert(selected.execution&&selected.error.empty()&&selected.execution->generator());
            assert(selected.execution->generationWidth()==gw&&selected.execution->generationHeight()==gh);
            auto prefix=frame;prefix.target=working;assert(selected.execution->encode(prefix).encoded);
            macfx::InterpolationPlan phases;phases.count=1;phases.timestamps[0]=0.5f;
            const auto result=selected.execution->generator()->encode(commands,working,{generated},sequence,phases);assert(result.encoded&&!result.busy&&result.dispatches&&result.historyFrames==i+1);
            if(modelHash.empty())modelHash=result.modelHash;assert(!modelHash.empty()&&modelHash==result.modelHash);
            auto suffix=frame;suffix.source=working;assert(selected.execution->encode(suffix,true,false).encoded);
            if(i==2){assert(result.ready&&result.generated==1);suffix.source=generated;suffix.target=generatedOutput;assert(selected.execution->encode(suffix,true,true).encoded);}
            [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(working,255,140);verify(output,255,200);
            if(i==2)verify(generatedOutput,255,200,false);assert(readPixels(source)==original);
        }
        std::printf("literal Advanced %s source=%ux%u generation=%ux%u output=%ux%u real/generated suffix=200 opaque source-unchanged model=%s\n",includeScale?(scaleBefore?"fit->FG":"FG->fit"):"FG->final-fit",sw,sh,gw,gh,ow,oh,modelHash.c_str());
    };
    publishNodes(path,@"1",@[shader(@"prefix",@"/proof/generation-prefix"),fg,fit,shader(@"suffix",@"/proof/generation-suffix")]);
    exercise(128,96,256,192,false,true);exercise(160,120,320,240,false,true);
    publishNodes(path,@"2",@[shader(@"prefix",@"/proof/generation-prefix"),fit,fg,shader(@"suffix",@"/proof/generation-suffix")]);exercise(160,120,320,240,true,true);
    publishNodes(path,@"3",@[shader(@"prefix",@"/proof/generation-prefix"),fg,shader(@"suffix",@"/proof/generation-suffix")]);exercise(128,96,256,192,false,false);
    assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);std::puts("Actual offscreen ordered executor/LSFG: literal FG geometry, source/output resize, explicit scaler placement, automatic final fitting, real/generated suffix pixels and source immutability passed; controlled shader provider, no presenter/window/game-quality claim");return 0;
}
int memoryColorFallback(NSString *directory,NSString *path,id<MTLDevice> device,id<MTLCommandQueue> queue,id<MTLTexture>input,id<MTLTexture>output){
    const auto complete=[](id<MTLCommandBuffer>cb){[cb commit];[cb waitUntilCompleted];assert(cb.status==MTLCommandBufferStatusCompleted);};
    const uint64_t working=device.recommendedMaxWorkingSetSize,used=device.currentAllocatedSize;
    assert(working>used+(8ull<<20));const auto limit=working-working/16;
    auto pressure=macfx::reserveImageBytes(device,limit-used-(2ull<<20));
    std::printf("Controlled ledger reservation initial workingSet=%llu limit=%llu allocated=%llu reserved=%llu remaining=2097152; no physical pressure allocation\n",(unsigned long long)working,(unsigned long long)limit,(unsigned long long)used,(unsigned long long)pressure->bytes());
    NSDictionary *oversized=@{@"id":@"oversized",@"kind":@"spatial",@"method":@"bilinear",@"enabled":@YES,@"outputSize":@{@"width":@1024,@"height":@768},@"settings":@{}};
    publishNodes(path,@"a",@[oversized,shader(@"color",@"/proof/memory-color"),@{@"id":@"fit",@"kind":@"spatial",@"method":@"bilinear",@"enabled":@YES,@"settings":@{}}]);
    macfx::EffectPlanExecutor memory;auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,1);
    auto first=prepared(memory,frame);assert(first.execution);auto result=first.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);verify(output);assert(brightWidth==32);
    // Persistent denial retains compatible rows and the accepted output; it
    // must not turn into an unbounded BUSY/last-image freeze.
    std::this_thread::sleep_for(std::chrono::milliseconds(270));commands=[queue commandBuffer];frame.commands=commands;stamp(frame,2);
    // A retry under the same denial may rebuild the chain with that row still
    // pending; it never holds the previous image.
    auto denied=prepared(memory,frame);std::printf("denied retry: same=%d error=%s\n",int(denied.execution==first.execution),denied.error.c_str());
    assert(denied.execution&&!denied.holdPrevious);result=denied.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);verify(output);
    pressure.reset();std::this_thread::sleep_for(std::chrono::milliseconds(270));commands=[queue commandBuffer];frame.commands=commands;stamp(frame,3);
    auto recovered=prepared(memory,frame);assert(recovered.execution&&recovered.execution!=first.execution&&recovered.error.empty());result=recovered.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);verify(output);assert(brightWidth==1024);
    // Keep an actual old-target batch uncommitted while replacing the final
    // output extent. Deliberate ledger reservation denies the candidate; this
    // is controlled admission pressure, not global physical-memory exhaustion.
    const auto accepted=recovered.execution;const auto oldPixels=readPixels(output);
    auto late=[queue commandBuffer];auto lateFrame=frame;lateFrame.commands=late;stamp(lateFrame,6);
    assert(accepted->encode(lateFrame).encoded&&late.status<MTLCommandBufferStatusCommitted);
    auto resizedDescriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:output.pixelFormat width:96 height:72 mipmapped:NO];
    resizedDescriptor.storageMode=MTLStorageModeShared;resizedDescriptor.usage=output.usage;
    auto larger=[device newTextureWithDescriptor:resizedDescriptor];assert(larger);
    const std::vector<unsigned char> sentinel(larger.width*larger.height*4,0x7d);
    [larger replaceRegion:MTLRegionMake2D(0,0,larger.width,larger.height) mipmapLevel:0 withBytes:sentinel.data() bytesPerRow:larger.width*4];
    const auto resizedUsed=device.currentAllocatedSize;assert(limit>resizedUsed+(8ull<<20));
    pressure=macfx::reserveImageBytes(device,limit-resizedUsed-(1ull<<20));
    std::printf("Controlled ledger reservation resize workingSet=%llu limit=%llu allocated=%llu reserved=%llu remaining=1048576; no physical pressure allocation\n",(unsigned long long)working,(unsigned long long)limit,(unsigned long long)resizedUsed,(unsigned long long)pressure->bytes());
    commands=[queue commandBuffer];auto largerFrame=frame;largerFrame.commands=commands;largerFrame.target=larger;stamp(largerFrame,7);
    // As with the denied retry above, the candidate replaces the accepted
    // execution with its denied rows pending instead of holding it.
    // Preparation alone writes neither target.
    auto deniedResize=prepared(memory,largerFrame);std::printf("denied resize: same=%d hold=%d error=%s\n",int(deniedResize.execution==accepted),int(deniedResize.holdPrevious),deniedResize.error.c_str());
    assert(deniedResize.execution&&deniedResize.execution!=accepted&&!deniedResize.holdPrevious);
    assert(commands.status<MTLCommandBufferStatusCommitted&&readPixels(output)==oldPixels&&readPixels(larger)==sentinel);
    pressure.reset();std::this_thread::sleep_for(std::chrono::milliseconds(270));
    commands=[queue commandBuffer];largerFrame.commands=commands;stamp(largerFrame,8);
    auto recoveredResize=prepared(memory,largerFrame);assert(recoveredResize.execution&&recoveredResize.execution!=accepted&&recoveredResize.error.empty());
    result=recoveredResize.execution->encode(largerFrame);assert(result.encoded&&!result.busy);complete(commands);verify(larger);
    // The old lease completes only now. Its retired extent must not alias or
    // overwrite the newly accepted 96x72 target or alter the original source.
    const auto largerPixels=readPixels(larger);complete(late);verify(output);
    assert(readPixels(larger)==largerPixels&&readPixels(output)==oldPixels);
    // P3 rows are rejected before model acquisition. Compatible color/fit rows
    // still receive the exact source orientation and alpha.
    publishNodes(path,@"b",@[@{@"id":@"nn",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/not-opened/p3-model",@"settings":@{}},
        @{@"id":@"fg",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/not-opened/p3-model",@"settings":@{}},shader(@"p3-color",@"/proof/p3-color")]);
    macfx::EffectPlanExecutor p3;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,4);auto color=prepared(p3,frame,true,nullptr,macfx::ImageColorSpace::DisplayP3);
    assert(color.execution&&!color.execution->generator());assert(color.execution->encode(frame).encoded);complete(commands);verify(output);
    // An invalid generation row between a scaler and a suffix leaves the other rows running.
    auto scale=@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"bilinear",@"settings":@{}};
    auto invalidFg=@{@"id":@"invalid-generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/not-opened/invalid-model",@"settings":@{@"frameMultiplier":@1}};
    publishNodes(path,@"c",@[shader(@"prefix",@"/proof/invalid-generation-prefix"),scale,invalidFg,shader(@"suffix",@"/proof/invalid-generation-suffix")]);
    macfx::EffectPlanExecutor invalid;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,5);auto independent=prepared(invalid,frame,true);
    assert(independent.execution&&!independent.execution->generator());assert(independent.execution->encode(frame).encoded);complete(commands);verify(output);
    assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);puts("Actual executor GPU: controlled admission denial continued compatible effects; denied 64x48-to-96x72 replacement adopted with its denied rows pending and wrote no pixels during preparation, release recovered, late old-target completion preserved new pixels; P3 NN/FG bypass before model open, orientation/alpha preserved by controlled shader provider");return 0;
}
// A scene frame-generation row without a scene stays in the execution as a
// bypassed row: each encoded frame reports it with its missing inputs while
// the color stage runs, and it asks no image depth.
void sceneGeneration(NSString *path,id<MTLCommandQueue>queue,id<MTLTexture>input,id<MTLTexture>output){
    publishNodes(path,@"d",@[@{@"id":@"scene-generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"metalfx",@"settings":@{},@"requirements":@{@"depth":@YES,@"motion":@YES,@"camera":@YES}},
        shader(@"color",@"/proof/scene-generation-color")]);
    macfx::EffectPlanExecutor executor;
    for(uint64_t frameId=1;frameId<=2;++frameId){
        auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,frameId);
        const auto selected=prepared(executor,frame,true);
        if(!selected.execution||!selected.error.empty())std::fprintf(stderr,"scene generation: execution=%d error=%s\n",int(bool(selected.execution)),selected.error.c_str());
        assert(selected.execution&&selected.error.empty()&&!selected.execution->hasTemporal()&&!selected.execution->requiresDepth()&&!executor.requiresDepth());
        const auto result=selected.execution->encode(frame);
        if(!result.encoded||result.reason!="Needs matching renderer depth, motion and camera inputs")std::fprintf(stderr,"scene generation: encoded=%d reason=%s\n",int(result.encoded),result.reason.c_str());
        assert(result.encoded&&result.reason=="Needs matching renderer depth, motion and camera inputs");
        [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);
    }
    std::puts("scene frame generation without a scene: bypassed row reported on every encoded frame with its missing inputs, color stage ran, no image depth");
}
int temporalFallback(NSString *directory,NSString *path,id<MTLDevice> device,id<MTLCommandQueue> queue){
    temporalFixture=true;
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:8 height:8 mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto input=[device newTextureWithDescriptor:descriptor];descriptor.width=descriptor.height=16;auto output=[device newTextureWithDescriptor:descriptor];assert(input&&output);
    std::array<unsigned char,8*8*4> source{};for(unsigned i=0;i<source.size();i+=4){source[i]=16+16*(i/32);source[i+1]=80;source[i+2]=140;source[i+3]=64;}
    [input replaceRegion:MTLRegionMake2D(0,0,8,8) mipmapLevel:0 withBytes:source.data() bytesPerRow:32];
    const auto check=[&](unsigned shaderWidth=16){std::array<unsigned char,16*16*4> bytes{};[output getBytes:bytes.data() bytesPerRow:64 fromRegion:MTLRegionMake2D(0,0,16,16) mipmapLevel:0];for(unsigned i=0;i<bytes.size();i+=4)assert(bytes[i+1]==255&&bytes[i+2]==140&&bytes[i+3]==64);assert(bytes[0]<=20&&bytes[15*64]>=120);assert(brightWidth==shaderWidth);return bytes;};
    const auto complete=[](id<MTLCommandBuffer> commands){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);};
    const auto sceneFor=[&](const macfx::ShaderFrame &frame){RSTemporalFrame scene{};scene.size=sizeof(scene);scene.version=1;scene.commandBuffer=(__bridge void*)frame.commands;scene.color=(__bridge void*)input;scene.output=(__bridge void*)output;scene.frameId=frame.frameId;scene.frameTimeMs=frame.frameTimeMs;scene.renderWidth=scene.renderHeight=8;scene.outputWidth=scene.outputHeight=16;return scene;};
    const auto after=[&](const std::shared_ptr<macfx::EffectExecution> &execution,macfx::ShaderFrame frame){frame.source=output;frame.depth=nullptr;const auto result=execution->encodeAfterScene(frame);assert(result.encoded);};
    NSDictionary *temporal=@{@"id":@"scene",@"kind":@"temporal",@"enabled":@YES,@"method":@"fsr2",@"settings":@{}};
    publishNodes(path,@"a",@[temporal,shader(@"color",@"/proof/temporal-color")]);
    auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,1);
    // No fabricated scene receipt: unavailable scene inputs bypass this row
    // at its input extent without calling a provider, then the ordinary color
    // stage still runs.
    macfx::EffectPlanExecutor absent;auto selected=prepared(absent,frame,true);assert(selected.execution&&selected.error.empty()&&!selected.execution->hasTemporal());
    assert(!temporalCalls&&!temporalProbeCalls);auto result=selected.execution->encode(frame);assert(result.encoded&&!result.reason.empty());complete(commands);check(8);
    // A provider initialization failure is stage-local at first launch, with
    // the declared 16x16 scene output preserved for the later shader.
    temporalProbeStatus=RS_TEMPORAL_UNAVAILABLE;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,2);auto scene=sceneFor(frame);
    macfx::EffectPlanExecutor unavailable;selected=prepared(unavailable,frame,true,&scene);assert(selected.execution&&selected.error.empty()&&!selected.execution->hasTemporal()&&temporalProbeCalls==1);
    result=selected.execution->encode(frame);assert(result.encoded&&!result.reason.empty());complete(commands);check();
    // A live replacement follows the launch contract: the candidate whose
    // temporal provider is unavailable replaces the accepted color-only chain
    // with that row bypassed, and its color stage runs.
    publishNodes(path,@"b",@[shader(@"original",@"/proof/accepted-color")]);macfx::EffectPlanExecutor live;
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,3);auto original=prepared(live,frame,true);assert(original.execution&&original.error.empty());
    publishNodes(path,@"c",@[temporal,shader(@"color",@"/proof/temporal-color")]);commands=[queue commandBuffer];frame.commands=commands;stamp(frame,4);scene=sceneFor(frame);
    auto adopted=prepared(live,frame,true,&scene);
    if(!adopted.execution||adopted.execution==original.execution||!adopted.error.empty())std::fprintf(stderr,"temporal candidate: same=%d error=%s\n",int(adopted.execution==original.execution),adopted.error.c_str());
    assert(adopted.execution&&adopted.execution!=original.execution&&adopted.error.empty()&&!adopted.execution->hasTemporal());
    result=adopted.execution->encode(frame);assert(result.encoded&&!result.reason.empty());complete(commands);
    if(brightWidth!=16)std::fprintf(stderr,"temporal candidate: shader input width=%u\n",brightWidth);
    check();
    // A mismatched receipt never reaches the backend and remains transient.
    // A later valid receipt is retried; its partial failing write is fully
    // overwritten before the independent shader consumes that scene output.
    temporalProbeStatus=RS_TEMPORAL_OK;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,5);scene=sceneFor(frame);macfx::EffectPlanExecutor processing;
    selected=prepared(processing,frame,true,&scene);assert(selected.execution&&selected.execution->hasTemporal());const auto before=temporalCalls,releases=temporalReleases;
    auto mismatch=scene;mismatch.commandBuffer=nullptr;result=selected.execution->encodeScene(frame,mismatch);assert(result.encoded&&!result.reason.empty()&&temporalCalls==before&&temporalReleases>releases);after(selected.execution,frame);complete(commands);check();
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,6);scene=sceneFor(frame);temporalEncodeStatus=RS_TEMPORAL_FAILED;
    result=selected.execution->encodeScene(frame,scene);assert(result.encoded&&!result.reason.empty()&&temporalCalls==before+1);after(selected.execution,frame);complete(commands);check();
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,7);scene=sceneFor(frame);result=selected.execution->encodeScene(frame,scene);assert(result.encoded&&!result.reason.empty()&&temporalCalls==before+1);after(selected.execution,frame);complete(commands);check();
    // Busy is different from rejection: retain the last complete presentation
    // without fitting raw input or running the later shader on this attempt.
    publishNodes(path,@"d",@[temporal,shader(@"color",@"/proof/temporal-color")]);commands=[queue commandBuffer];frame.commands=commands;stamp(frame,8);scene=sceneFor(frame);macfx::EffectPlanExecutor busy;
    selected=prepared(busy,frame,true,&scene);assert(selected.execution&&selected.execution->hasTemporal());const auto previous=check();temporalEncodeStatus=RS_TEMPORAL_BUSY;
    result=selected.execution->encodeScene(frame,scene);assert(!result.encoded&&result.busy);complete(commands);assert(check()==previous);
    // Typed shader resource pressure uses the same coherent hold as neural and
    // temporal work, even if the provider wrote its private scratch first.
    publishNodes(path,@"e",@[shader(@"busy-shader",@"/proof/encode-busy"),shader(@"later-shader",@"/proof/after-busy")]);
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,9);macfx::EffectPlanExecutor shaderOwner;
    auto ready=prepared(shaderOwner,frame,true);assert(ready.execution&&ready.error.empty());
    result=ready.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);check(8);assert(afterBusyCalls==1);
    std::array<unsigned char,16*16*4> heldPixels{};
    [output replaceRegion:MTLRegionMake2D(0,0,16,16) mipmapLevel:0 withBytes:heldPixels.data() bytesPerRow:64];
    shaderBusy=true;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,10);
    result=ready.execution->encode(frame);assert(!result.encoded&&result.busy);complete(commands);
    assert(afterBusyCalls==1&&readPixels(output)==std::vector<unsigned char>(heldPixels.begin(),heldPixels.end()));
    shaderBusy=false;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,11);
    result=ready.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);check(8);assert(afterBusyCalls==2);
    // A scene frame-generation row without a scene receipt is bypassed like the
    // temporal row: hosts that call encode() still run the ordinary color stage,
    // and every encoded frame reports the row with its missing inputs.
    publishNodes(path,@"f",@[@{@"id":@"scene-generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"metalfx",@"settings":@{}},shader(@"color",@"/proof/temporal-color")]);
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,12);macfx::EffectPlanExecutor sceneless;
    selected=prepared(sceneless,frame,true);assert(selected.execution&&selected.error.empty()&&!selected.execution->hasTemporal()&&!selected.execution->requiresDepth());
    result=selected.execution->encode(frame);assert(result.encoded&&result.reason=="Needs matching renderer depth, motion and camera inputs");complete(commands);check(8);
    std::array<unsigned char,8*8*4> unchanged{};[input getBytes:unchanged.data() bytesPerRow:32 fromRegion:MTLRegionMake2D(0,0,8,8) mipmapLevel:0];assert(unchanged==source);
    assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);std::puts("ordered temporal fallback: missing/unavailable scene row isolated, live replacement adopted with that row bypassed, partial failure overwritten, downstream pixels/extent/frame metadata preserved, typed shader/temporal busy kept previous image and recovered");return 0;
}
}
namespace macfx {std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &spec){auto value=std::make_shared<Shader>(spec.selection.file);lastShader[spec.selection.file]=value;++shaderCreates[spec.selection.file];if(capturedShaders)capturedShaders->push_back(value);return value;}}
// The executor reaches providers through macfx::prepareTemporalProvider (the
// resource-only probe) and macfx::encodeTemporalProvider; these definitions
// take precedence over the library's for the linked executor unit.
// A 4K chain ending in FSR1. Live extent edits validate against the shared
// scratch pool while the retained chain's images sit idle in it, and apply.
// Pressure is retriable for the same revision even after the soft grace.
// Independent color work remains usable while its FSR row is pending; a real
// shader parameter error stays a hard per-row failure with its exact reason.
int fsrScratch(NSString *directory,NSString *path,id<MTLDevice>device,id<MTLCommandQueue>queue){
    using namespace macfx::runtime_status;using clock=std::chrono::steady_clock;
    const std::string busyReason="FSR scratch memory budget is full";
    // The launcher's status page and lease for this process.
    NSString *statusFile=[directory stringByAppendingPathComponent:@"status.bin"];
    const int fd=open(statusFile.fileSystemRepresentation,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);assert(fd>=0&&ftruncate(fd,pageSize)==0);
    auto *page=static_cast<char*>(mmap(nullptr,pageSize,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0));close(fd);assert(page!=MAP_FAILED);
    auto *header=reinterpret_cast<Header*>(page);std::memcpy(header->magic,"MLFXSTS1",8);header->version=schema;header->bytes=pageSize;
    std::memset(header->token,'a',64);std::memcpy(header->launchId,"fsr",3);header->launchIdLength=3;
    const std::string token(64,'a');setenv("RESHADE_RUNTIME_STATUS_FILE",statusFile.fileSystemRepresentation,1);
    setenv("RESHADE_RUNTIME_STATUS_TOKEN",token.c_str(),1);setenv("RESHADE_RUNTIME_STATUS_LAUNCH_ID","fsr",1);
    const auto lease=[&]{
        const auto now=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
        __atomic_store_n(&header->leaseUntil,now+8000,__ATOMIC_RELEASE);macfx::pollRuntimeStatus(true);
    };
    // An open attempt is throttled to one per second.
    for(unsigned i=0;i<1500&&!macfx::runtimeStatusLeased();++i){lease();usleep(1000);}assert(macfx::runtimeStatusLeased());
    const auto failedRow=[&](NSString *revision)->const Context*{
        const std::string expected=hex(revision).UTF8String;
        for(unsigned i=0;i<slotCount;++i){const auto *row=reinterpret_cast<const Context*>(page+headerSize+i*slotSize);
            if(row->pid==uint32_t(getpid())&&row->phase==uint32_t(macfx::RuntimeStatusPhase::Failed)&&expected==row->planRevision)return row;}
        return nullptr;
    };
    const auto texture=[&](NSUInteger width,NSUInteger height){
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
        descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
        auto image=[device newTextureWithDescriptor:descriptor];assert(image);return image;
    };
    auto input=texture(3840,2160),output=texture(3840,2160);uint64_t frameId=400;
    auto readable=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:output.pixelFormat width:output.width height:output.height mipmapped:NO];
    readable.storageMode=MTLStorageModeShared;auto readback=[device newTextureWithDescriptor:readable];assert(readback);
    {auto commands=[queue commandBuffer];auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=input;
     pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(.5,.25,.125,1);
     auto clear=[commands renderCommandEncoderWithDescriptor:pass];assert(clear);[clear endEncoding];[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}
    const auto nodes=[&](unsigned height){return @[
        @{@"id":@"down",@"kind":@"spatial",@"enabled":@YES,@"method":@"downsample",@"outputSize":@{@"height":@(height)},@"settings":@{}},
        @{@"id":@"up",@"kind":@"spatial",@"enabled":@YES,@"method":@"fsr1",@"settings":@{}},shader(@"healthy",@"/proof/after-busy")];};
    const auto plan=[&](NSString *revision,unsigned height){publishNodes(path,revision,nodes(height));};
    const auto frameFor=[&](uint64_t observation=0){macfx::ShaderFrame frame{[queue commandBuffer],input,output};assert(frame.commands);stamp(frame,observation?:++frameId);return frame;};
    macfx::EffectPlanExecutor executor;executor.setStatusContext(reinterpret_cast<uintptr_t>(&executor));
    const auto stage=[&](NSString *revision,const char *id)->const Stage*{
        const std::string expected=hex(revision).UTF8String;
        for(unsigned i=0;i<slotCount;++i){const auto *row=reinterpret_cast<const Context*>(page+headerSize+i*slotSize);
            if(row->pid!=uint32_t(getpid())||row->id!=reinterpret_cast<uintptr_t>(&executor)||expected!=row->planRevision)continue;
            for(unsigned n=0;n<std::min(row->stages,stageCount);++n)if(!std::strcmp(row->rows[n].id,id))return &row->rows[n];}
        return nullptr;
    };
    // One observation per call, on a fresh buffer that is never submitted.
    const auto until=[&](const auto &done,double seconds,const char *what){
        const auto deadline=clock::now()+std::chrono::duration_cast<clock::duration>(std::chrono::duration<double>(seconds));
        const auto observation=++frameId;
        for(;;){
            lease();auto frame=frameFor(observation);auto selected=executor.prepare(frame);assert(frame.commands.status<MTLCommandBufferStatusCommitted);
            if(done(selected))return selected;
            if(clock::now()>=deadline){std::fprintf(stderr,"%s: preparing=%d error=%s\n",what,int(selected.preparing),selected.error.c_str());assert(!"FSR scratch observation timed out");}
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    };
    const auto run=[&](const std::shared_ptr<macfx::EffectExecution> &execution){
        const auto before=afterBusyCalls;auto frame=frameFor();const auto result=execution->encode(frame);if(!result.encoded)std::fprintf(stderr,"FSR chain frame: %s\n",result.reason.c_str());assert(result.encoded&&!result.busy&&afterBusyCalls==before+1);
        auto copy=[frame.commands blitCommandEncoder];assert(copy);[copy copyFromTexture:output toTexture:readback];[copy endEncoding];
        [frame.commands commit];[frame.commands waitUntilCompleted];assert(frame.commands.status==MTLCommandBufferStatusCompleted);
        const auto pixels=readPixels(readback);for(size_t i=0;i<pixels.size();i+=4){assert(pixels[i+1]==255&&pixels[i+3]==255);assert(pixels[i+2]>=126&&pixels[i+2]<=129);}
        return result;
    };
    const auto revision=[](const macfx::EffectExecutionSelection &selected,NSString *value){return selected.execution&&selected.execution->revision()==std::string(hex(value).UTF8String);};
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:3840 height:2160 mipmapped:NO];
    descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    const size_t large=[device heapTextureSizeAndAlignWithDescriptor:descriptor].size;const unsigned capacity=unsigned(macfx::fsr1::ScratchBudget::maximum/large);
    std::printf("FSR scratch device=%s 4K images within the budget=%u slotBytes=%zu budgetBytes=%zu\n",device.name.UTF8String,capacity,large,macfx::fsr1::ScratchBudget::maximum);std::fflush(stdout);assert(capacity>=3);

    // Fill the actual FSR scratch budget directly, independently of the
    // executor's lazily warmed per-command color slots. The retained chain
    // and candidate must then reuse these same idle FSR images without charge.
    macfx::Fsr1Encoder prefill(device);
    std::vector<id<MTLCommandBuffer>> flight;
    for(unsigned i=0;i<std::min(capacity,4u);++i){auto commands=[queue commandBuffer];std::string reason;bool busy=false;
        assert(prefill.encode(commands,{input,output,++frameId},.5f,reason,&busy)&&!busy&&reason.empty());flight.push_back(commands);}
    for(auto commands:flight){[commands commit];[commands waitUntilCompleted];}flight.clear();
    const auto filled=macfx::fsr1::ScratchBudget::retainedBytes();assert(filled>=std::min(capacity,4u)*large);
    std::printf("FSR scratch retainedBytes=%zu after %u completed 4K leases\n",filled,std::min(capacity,4u));std::fflush(stdout);
    plan(@"1",1080);auto first=until([](const auto &s){return !s.preparing&&s.execution;},8,"first chain");assert(first.error.empty()&&revision(first,@"1"));
    assert(run(first.execution).reason.empty()&&macfx::fsr1::ScratchBudget::retainedBytes()<=filled);
    // A 1440p extent edit validates on an idle image and applies without new charge.
    plan(@"2",1440);auto second=until([&](const auto &s){return !s.preparing&&s.execution&&s.execution!=first.execution;},8,"extent edit");
    if(!second.error.empty())std::fprintf(stderr,"Extent edit: %s\n",second.error.c_str());assert(second.error.empty()&&revision(second,@"2"));
    first={};assert(run(second.execution).reason.empty());assert(macfx::fsr1::ScratchBudget::retainedBytes()<=filled);

    // Other work holds the whole budget with 4K images in flight.
    macfx::Fsr1Encoder holder(device);auto holderSource=texture(1920,1080),holderOutput=texture(3840,2160);
    const auto hold=[&]{
        std::vector<id<MTLCommandBuffer>> held;
        for(;;){auto commands=[queue commandBuffer];std::string reason;bool busy=false;
            if(!holder.encode(commands,{holderSource,holderOutput,++frameId},.5f,reason,&busy)){assert(busy&&reason==busyReason);return held;}
            held.push_back(commands);}
    };
    const auto release=[](std::vector<id<MTLCommandBuffer>> &held){for(auto commands:held){[commands commit];[commands waitUntilCompleted];}held.clear();};
    // Sustained pressure may adopt healthy rows with FSR pending, but elapsed
    // time must not turn the key into a permanently failed candidate. The
    // retry probe may report its generic waiting reason before partial
    // adoption; the execution's row receipt is the exact provider authority.
    auto held=hold();assert(!held.empty());plan(@"3",1620);const auto start=clock::now();unsigned preparingObservations=0,partialObservations=0;
    auto partial=until([&](const auto &s){assert(!failedRow(@"3"));if(s.preparing){assert(!s.error.empty());++preparingObservations;return false;}
        if(!revision(s,@"3"))return false;++partialObservations;return clock::now()-start>=std::chrono::milliseconds(2500);},8,"healthy rows during sustained pressure");
    const auto elapsed=clock::now()-start;assert(elapsed>=std::chrono::seconds(2));
    assert(partial.execution!=second.execution&&run(partial.execution).reason==busyReason);
    assert(!failedRow(@"3"));const auto pending=stage(@"3","up"),healthy=stage(@"3","healthy");
    assert(pending&&pending->phase==uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&busyReason==pending->reason);
    assert(healthy&&healthy->completed>0&&healthy->phase==uint32_t(macfx::RuntimeStatusPhase::Completed));
    release(held);
    auto recovered=until([&](const auto &s){assert(!failedRow(@"3"));if(s.preparing||!revision(s,@"3")||s.execution==partial.execution)return false;
        const auto result=run(s.execution);assert(result.reason.empty()||result.reason==busyReason);return result.reason.empty();},8,"same revision after late release");
    assert(recovered.error.empty()&&revision(recovered,@"3"));const auto resumed=stage(@"3","up");
    assert(resumed&&resumed->phase==uint32_t(macfx::RuntimeStatusPhase::Completed)&&resumed->completed>0&&!*resumed->reason);
    // A genuine error remains an exact non-Busy per-row failure; it is not
    // silently retried or allowed to stop the independent healthy color row.
    const std::string hardReason="Shader parameter unavailable";
    NSMutableDictionary *bad=[shader(@"hard-error",@"/proof/scratch-hard")mutableCopy];bad[@"parameters"]=@{@"Reject":@[@(-1)]};
    NSMutableArray *hardNodes=[nodes(1080)mutableCopy];[hardNodes insertObject:bad atIndex:2];publishNodes(path,@"4",hardNodes);
    auto hard=until([&](const auto &s){return !s.preparing&&revision(s,@"4");},8,"real shader error");
    assert(run(hard.execution).reason==hardReason);const auto hardCreates=shaderCreates["/proof/scratch-hard"];
    assert(hardCreates>0);auto again=until([&](const auto &s){return !s.preparing&&s.execution==hard.execution;},2,"stable hard row failure");
    assert(run(again.execution).reason==hardReason&&shaderCreates["/proof/scratch-hard"]==hardCreates);
    const auto failedStage=stage(@"4","hard-error");assert(failedStage&&failedStage->phase==uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&hardReason==failedStage->reason&&!failedStage->encoded);
    // A live edit that breaks the working healthy row keeps its previous
    // version running with the edit's reason; other rows apply the edit.
    NSMutableArray *brokenNodes=[hardNodes mutableCopy];NSMutableDictionary *broken=[brokenNodes.lastObject mutableCopy];
    broken[@"parameters"]=@{@"Reject":@[@(-1)]};brokenNodes[brokenNodes.count-1]=broken;publishNodes(path,@"5",brokenNodes);
    auto kept=until([&](const auto &s){return !s.preparing&&revision(s,@"5");},8,"retained working row");
    assert(kept.execution!=again.execution&&run(kept.execution).reason==hardReason);
    const auto retained=stage(@"5","healthy");
    assert(retained&&retained->phase!=uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&!std::strcmp(retained->active,"retained")&&hardReason==retained->reason&&retained->encoded>0);
    publishNodes(path,@"6",hardNodes);auto fixed=until([&](const auto &s){return !s.preparing&&revision(s,@"6");},8,"repaired row");
    run(fixed.execution);const auto repaired=stage(@"6","healthy");assert(repaired&&std::strcmp(repaired->active,"retained")&&!*repaired->reason&&repaired->encoded>0);
    munmap(page,pageSize);
    std::printf("FSR scratch: extent edits reuse idle images; healthy completed pixels continue past %.1f s soft grace (%u preparing/%u partial observations); late pressure release recovers the same revision; exact hard shader failure stays isolated; a broken working row keeps its previous version\n",std::chrono::duration<double>(elapsed).count(),preparingObservations,partialObservations);
    return 0;
}
static int controlledTemporal(const RSTemporalFrame *frame,RSTemporalResult *result,bool probe){
    assert(frame&&result&&frame->owner&&frame->commandBuffer&&frame->color&&frame->output);assert(frame->frameId==expectedFrameId&&frame->frameTimeMs==12.5f);
    assert(frame->renderWidth==8&&frame->renderHeight==8&&frame->outputWidth==16&&frame->outputHeight==16&&!frame->depth&&!frame->motion);
    const auto status=probe?temporalProbeStatus:temporalEncodeStatus;if(probe)++temporalProbeCalls;else ++temporalCalls;
    result->status=status;result->encoded=status==RS_TEMPORAL_OK;
    std::snprintf(result->reason,sizeof(result->reason),"Controlled temporal %s",status==RS_TEMPORAL_BUSY?"busy":status==RS_TEMPORAL_UNAVAILABLE?"initialization failure":"encode failure");
    if(!probe&&status==RS_TEMPORAL_FAILED){auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=(__bridge id<MTLTexture>)frame->output;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,0);auto encoder=[(__bridge id<MTLCommandBuffer>)frame->commandBuffer renderCommandEncoderWithDescriptor:pass];assert(encoder);[encoder endEncoding];}
    return status;
}
namespace macfx {
int encodeTemporalProvider(const RSTemporalFrame *frame,RSTemporalResult *result){
    if(!temporalFixture){static const auto original=reinterpret_cast<int(*)(const RSTemporalFrame*,RSTemporalResult*)>(dlsym(RTLD_NEXT,"_ZN5macfx22encodeTemporalProviderEPK15RSTemporalFrameP16RSTemporalResult"));assert(original);return original(frame,result);}
    return controlledTemporal(frame,result,frame&&(frame->flags&RS_TEMPORAL_RESET));
}
bool prepareTemporalProvider(const RSTemporalFrame *frame,RSTemporalResult *result){
    if(!temporalFixture){static const auto original=reinterpret_cast<bool(*)(const RSTemporalFrame*,RSTemporalResult*)>(dlsym(RTLD_NEXT,"_ZN5macfx23prepareTemporalProviderEPK15RSTemporalFrameP16RSTemporalResult"));assert(original);return original(frame,result);}
    controlledTemporal(frame,result,true);return true;
}
}
extern "C" void rsReleaseTemporalOwner(void *owner){
    if(temporalFixture){if(owner)++temporalReleases;return;}
    static const auto original=reinterpret_cast<decltype(&rsReleaseTemporalOwner)>(dlsym(RTLD_NEXT,"rsReleaseTemporalOwner"));assert(original);original(owner);
}
// The plan, log and diagnostics are launch settings. The checks run as a phase
// launched with them, in a directory this process removes afterwards.
int main(int argc,char **argv){@autoreleasepool{
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        char temporary[1024];temporaryPath(temporary,"maclauncher-effects-fallback-XXXXXX");assert(mkdtemp(temporary));NSString *directory=[NSString stringWithUTF8String:temporary];
        NSString *log=std::getenv("RESHADE_LOG")?[NSString stringWithUTF8String:std::getenv("RESHADE_LOG")]:[directory stringByAppendingPathComponent:@"native.log"];
        std::vector<std::string> arguments{temporary};for(int i=1;i<argc;++i)arguments.emplace_back(argv[i]);
        const int status=fixture::runPhase("checks",{{"RESHADE_LOG",log.fileSystemRepresentation},{"RESHADE_DIAGNOSTICS","1"},
            {"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation}},arguments);
        [[NSFileManager defaultManager]removeItemAtPath:directory error:nil];return status;
    }
    assert(phase.argc>=2);NSString *directory=[NSString stringWithUTF8String:phase.argv[1]],*path=[directory stringByAppendingPathComponent:@"plan.json"];
    NSString *log=[NSString stringWithUTF8String:std::getenv("RESHADE_LOG")];
    phase.argv[1]=phase.argv[0];argc=phase.argc-1;argv=phase.argv+1;
    const bool generation=argc==3&&!std::strcmp(argv[1],"--generation-geometry");
    const bool fsr=argc==2&&!std::strcmp(argv[1],"--fsr-scratch");
    assert(argc==1||generation||fsr||(argc==2&&(!std::strcmp(argv[1],"--temporal-fallback")||!std::strcmp(argv[1],"--memory-color-fallback")||!std::strcmp(argv[1],"--candidate-geometry")||!std::strcmp(argv[1],"--origin-contract")||!std::strcmp(argv[1],"--scene-generation"))));
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(generation||fsr?30:10)*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Ordered fallback check timed out\n",stderr);std::_Exit(2);});
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    if(generation)return generationGeometry(directory,path,device,queue,@(argv[2]));
    if(argc==2&&!std::strcmp(argv[1],"--temporal-fallback"))return temporalFallback(directory,path,device,queue);
    if(fsr)return fsrScratch(directory,path,device,queue);
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto input=[device newTextureWithDescriptor:d];d.width=64;d.height=48;auto output=[device newTextureWithDescriptor:d];std::array<unsigned char,32*24*4> pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=16+4*(i/(32*4));pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=64;}
    [input replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    if(argc==2&&!std::strcmp(argv[1],"--origin-contract")){originContract(path,queue,input,output);assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);return 0;}
    if(argc==2&&!std::strcmp(argv[1],"--candidate-geometry")){candidateGeometry(path,queue,input,output);assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);return 0;}
    if(argc==2&&!std::strcmp(argv[1],"--scene-generation")){sceneGeneration(path,queue,input,output);assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);return 0;}
    if(argc==2)return memoryColorFallback(directory,path,device,queue,input,output);
    publish(path,@"a",@"/proof/encode-fails");macfx::EffectPlanExecutor executor;std::shared_ptr<macfx::EffectExecution> previous;
    // A generic frame owner is not necessarily an Objective-C object. Exercise
    // the actual ingress lookup while an advanced plan enables its depth path.
    int opaqueOwner=0;
    assert(!macfx::viewPresentationForOwner(nullptr)&&!macfx::viewPresentationForOwner(&opaqueOwner));
    assert(!macfx::frameRequiresDepth(&opaqueOwner,device,32,24));
    rsReleaseFrameOwner(&opaqueOwner);
    for(unsigned frame=1;frame<=2;++frame){auto commands=[queue commandBuffer];macfx::ShaderFrame context{commands,input,output};stamp(context,frame);auto selected=prepared(executor,context);assert(selected.execution&&selected.error.empty());previous=selected.execution;auto encoded=previous->encode(context);assert(encoded.encoded&&!encoded.reason.empty());[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);}
    assert(partialCalls==1);
    publish(path,@"c",@"/proof/prepare-fails");auto commands=[queue commandBuffer];macfx::ShaderFrame context{commands,input,output};stamp(context,3);auto partial=prepared(executor,context);
    // A row that fails to prepare is bypassed in the adopted edit; the other rows run.
    if(partial.execution==previous)std::fprintf(stderr,"prepare-fails kept the previous execution: %s\n",partial.error.c_str());
    assert(partial.execution&&partial.execution!=previous);assert(partial.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];verify(output);
    macfx::EffectPlanExecutor firstLaunch;commands=[queue commandBuffer];context.commands=commands;stamp(context,4);auto skipped=prepared(firstLaunch,context);assert(skipped.execution);assert(skipped.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);
    publish(path,@"d",@"/proof/encode-fails",@{@"x":@0.5,@"y":@0.5});commands=[queue commandBuffer];context.commands=commands;stamp(context,5);auto resized=prepared(executor,context);assert(resized.execution&&resized.error.empty());assert(resized.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);assert(brightWidth==16&&partialWidth==16&&partialCalls==2);
    publish(path,@"e",@"/proof/encode-fails",nil,true);macfx::EffectPlanExecutor unavailableGeneration;commands=[queue commandBuffer];context.commands=commands;stamp(context,6);auto realFrames=prepared(unavailableGeneration,context);assert(realFrames.execution&&!realFrames.execution->graphics().generation);assert(realFrames.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);
    // A parameter change that a working row rejects keeps that row's previous
    // version while the other edit applies; no accepted node is altered.
    // Unchanged rows stay shared.
    auto prefix=shader(@"prefix",@"/proof/immutable-prefix");
    auto first=[shader(@"first",@"/proof/immutable-first")mutableCopy],second=[shader(@"second",@"/proof/immutable-second")mutableCopy];
    first[@"parameters"]=@{@"Gain":@[@0.25]};second[@"parameters"]=@{@"Gain":@[@0.5]};
    publishNodes(path,@"f",@[prefix,first,second]);macfx::EffectPlanExecutor immutable;
    commands=[queue commandBuffer];context.commands=commands;stamp(context,7);auto original=prepared(immutable,context);assert(original.execution&&original.error.empty());
    const auto oldPrefix=lastShader["/proof/immutable-prefix"].lock(),oldFirst=lastShader["/proof/immutable-first"].lock(),oldSecond=lastShader["/proof/immutable-second"].lock();assert(oldPrefix&&oldFirst&&oldSecond);
    first[@"parameters"]=@{@"Gain":@[@0.75]};second[@"parameters"]=@{@"Reject":@[@(-1)]};
    publishNodes(path,@"1",@[prefix,first,second]);commands=[queue commandBuffer];context.commands=commands;stamp(context,8);auto invalid=prepared(immutable,context);
    if(invalid.execution==original.execution)std::fprintf(stderr,"rejected parameter kept the previous execution: %s\n",invalid.error.c_str());
    assert(invalid.execution&&invalid.execution!=original.execution);
    assert(oldFirst->parameters.at("Gain")[0]==.25f&&oldSecond->parameters.at("Gain")[0]==.5f);
    assert(shaderCreates["/proof/immutable-prefix"]==1&&lastShader["/proof/immutable-prefix"].lock()==oldPrefix);
    second[@"parameters"]=@{@"Gain":@[@0.5]};publishNodes(path,@"2",@[prefix,first,second]);
    commands=[queue commandBuffer];context.commands=commands;stamp(context,9);auto replaced=prepared(immutable,context);assert(replaced.execution&&replaced.execution!=original.execution&&replaced.error.empty());
    assert(lastShader["/proof/immutable-first"].lock()!=oldFirst&&lastShader["/proof/immutable-first"].lock()->parameters.at("Gain")[0]==.75f);
    assert(oldFirst->parameters.at("Gain")[0]==.25f&&oldSecond->parameters.at("Gain")[0]==.5f&&shaderCreates["/proof/immutable-prefix"]==1);
    candidateGeometry(path,queue,input,output);
    // Capture demand includes the accepted chain until replacement succeeds,
    // then releases depth instead of keeping a process-wide sticky demand.
    auto depthNode=[shader(@"depth",@"/proof/retained-depth")mutableCopy];depthNode[@"requirements"]=@{@"depth":@YES};
    publishNodes(path,@"3",@[depthNode]);macfx::EffectPlanExecutor depthPlan;macfx::DepthFrame depth{input,10,macfx::FrameOrigin::BottomLeft};
    commands=[queue commandBuffer];context.commands=commands;context.depth=&depth;stamp(context,10);auto withDepth=prepared(depthPlan,context);assert(withDepth.execution&&withDepth.error.empty()&&withDepth.execution->requiresDepth()&&depthPlan.requiresDepth());
    publishNodes(path,@"4",@[shader(@"invalid",@"/proof/prepare-fails")]);assert(depthPlan.requiresDepth());
    commands=[queue commandBuffer];context.commands=commands;stamp(context,11);auto invalidDepth=prepared(depthPlan,context);
    // The edit is adopted with its failed row bypassed, so the depth row's demand ends.
    if(invalidDepth.execution==withDepth.execution||depthPlan.requiresDepth())std::fprintf(stderr,"failed-only edit: same=%d requiresDepth=%d error=%s\n",int(invalidDepth.execution==withDepth.execution),int(depthPlan.requiresDepth()),invalidDepth.error.c_str());
    assert(invalidDepth.execution&&invalidDepth.execution!=withDepth.execution&&!invalidDepth.execution->requiresDepth()&&!depthPlan.requiresDepth());
    // Demand then follows the latest publish: a depth-free plan asks none.
    publishNodes(path,@"5",@[shader(@"color",@"/proof/depth-free")]);assert(!depthPlan.requiresDepth());
    commands=[queue commandBuffer];context.commands=commands;context.depth=nullptr;stamp(context,12);auto withoutDepth=prepared(depthPlan,context);assert(withoutDepth.execution&&withoutDepth.error.empty()&&!withoutDepth.execution->requiresDepth()&&!depthPlan.requiresDepth());
    // A native producer already at half the presentation needs no reduction
    // allocation/filter pass. Its color, orientation and alpha still reach the
    // remaining shader and final fit through an actual completed GPU buffer.
    publishNodes(path,@"6",@[@{@"id":@"allocation-guard",@"kind":@"spatial",@"enabled":@YES,
        @"method":@"downsample",@"presentationScale":@0.5,@"settings":@{@"spatialMultiplier":NSNull.null}},
        shader(@"guarded-color",@"/proof/bright")]);
    macfx::EffectPlanExecutor guarded;commands=[queue commandBuffer];context.commands=commands;stamp(context,13);
    auto ready=prepared(guarded,context);assert(ready.execution&&ready.error.empty());assert(ready.execution->encode(context).encoded);
    [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);
    NSString *reported=[NSString stringWithContentsOfFile:log encoding:NSUTF8StringEncoding error:nil];
    assert([reported containsString:@"allocation-guard requestedMethod=downsample active=bypass input=32x24 output=32x24"]);
    assert([reported containsString:@"keeps its previous working version"]);
    std::array<unsigned char,32*24*4> unchanged;[input getBytes:unchanged.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(unchanged==pixels);
    pendingOff(path,queue,input,output);directFinal(path,device,queue,input);
    assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);std::puts("ordered fallback: partial writes bypassed, order and resize preserved, immutable live parameters, unchanged node reuse, accepted depth demand, unavailable rows and the direct final row passed");return 0;
}}
