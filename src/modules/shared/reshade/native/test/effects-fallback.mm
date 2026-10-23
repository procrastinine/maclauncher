// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#include "view-presentation.hpp"
#include "frame.h"
#include "image-admission.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <thread>
#include <unistd.h>
#include <vector>
namespace {
unsigned partialCalls=0;
unsigned brightWidth=0,partialWidth=0;
uint64_t expectedFrameId=0;
macfx::SpatialColor expectedColor=macfx::SpatialColor::Linear;
bool expectedOpaque=false;
bool temporalFixture=false;
unsigned temporalCalls=0,temporalProbeCalls=0,temporalReleases=0;
bool shaderBusy=false;unsigned afterBusyCalls=0;
uint32_t temporalProbeStatus=RS_TEMPORAL_OK,temporalEncodeStatus=RS_TEMPORAL_FAILED;
void stamp(macfx::ShaderFrame &frame,uint64_t id){
    expectedFrameId=frame.frameId=id;frame.timeMs=id*12.5;frame.frameTimeMs=12.5f;
    frame.origin=macfx::FrameOrigin::BottomLeft;frame.color=expectedColor;frame.opaqueDisplay=expectedOpaque;
}
void metadata(const macfx::ShaderFrame &frame){
    assert(frame.frameId==expectedFrameId&&frame.timeMs==expectedFrameId*12.5&&frame.frameTimeMs==12.5f);
    assert(frame.origin==macfx::FrameOrigin::BottomLeft&&frame.color==expectedColor&&frame.opaqueDisplay==expectedOpaque);
    assert(frame.source&&frame.target&&frame.source.width&&frame.source.height&&frame.target.width&&frame.target.height);
}
struct Shader final:macfx::ShaderNode {
    std::string file;id<MTLComputePipelineState> kernel;
    macfx::ShaderParameters parameters;
    unsigned preparedSourceWidth=0,preparedSourceHeight=0,preparedTargetWidth=0,preparedTargetHeight=0;
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
        if(file=="/proof/prepare-fails")throw std::runtime_error("Prepared shader unavailable");
        if(!kernel){NSError *error=nil;auto library=[frame.commands.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void proof(texture2d<float,access::read> a [[texture(0)]],texture2d<float,access::write> b [[texture(1)]],constant uint &mode [[buffer(0)]],uint2 q [[thread_position_in_grid]]){if(q.x>=b.get_width()||q.y>=b.get_height())return;uint2 p=uint2(float2(q)*float2(a.get_width(),a.get_height())/float2(b.get_width(),b.get_height()));float4 v=a.read(p);v.g=1;if(mode==2)v.r=200.0/255.0;b.write(mode==1?float4(0):v,q);}" options:nil error:&error];kernel=[frame.commands.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"proof"] error:&error];assert(kernel);}
        return {true,{}};
    }
    macfx::ShaderResult encode(const macfx::ShaderFrame &frame)override{
        metadata(frame);
        const bool partial=file=="/proof/encode-fails",busy=shaderBusy&&file=="/proof/encode-busy";
        if(file=="/proof/after-busy")++afterBusyCalls;
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
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":nodes} options:0 error:nil];assert([bytes writeToFile:path atomically:YES]);
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
    const auto prepare=[&]{auto commands=[queue commandBuffer];macfx::ShaderFrame frame{commands,input,output};stamp(frame,++frameId);return std::make_pair(executor.prepare(frame),frame);};
    const auto encode=[&](const std::shared_ptr<macfx::EffectExecution> &execution,macfx::ShaderFrame frame){assert(execution->encode(frame).encoded);[frame.commands commit];[frame.commands waitUntilCompleted];assert(frame.commands.status==MTLCommandBufferStatusCompleted);verify(output);assert(readPixels(input)==sourcePixels);};
    publishNodes(path,@"7",nodes);auto initial=prepare();const auto accepted=initial.first.execution;assert(accepted&&initial.first.error.empty());
    const auto oldPrefix=newest(prefixFile),oldSizing=newest(sizingFile),oldHistory=newest(historyFile);
    extent(oldPrefix,32,24,32,24);extent(oldSizing,32,24,32,24);extent(oldHistory,32,24,32,24);encode(accepted,initial.second);
    // Candidate preparation must not resize an accepted node before a later
    // row rejects the candidate. The prefix has the same true input contract.
    sizing[@"outputExtent"]=@"presentation";tail[@"parameters"]=@{@"Reject":@[@(-1)]};
    publishNodes(path,@"8",nodes);auto rejected=prepare();assert(rejected.first.execution==accepted&&!rejected.first.error.empty());
    std::printf("rejected candidate accepted sizing target=%ux%u history source=%ux%u reason=%s\n",oldSizing->preparedTargetWidth,oldSizing->preparedTargetHeight,oldHistory->preparedSourceWidth,oldHistory->preparedSourceHeight,rejected.first.error.c_str());std::fflush(stdout);
    extent(oldSizing,32,24,32,24);extent(oldHistory,32,24,32,24);
    const auto rejectedSizing=newest(sizingFile),rejectedHistory=newest(historyFile);
    assert(rejectedSizing!=oldSizing&&rejectedHistory!=oldHistory);
    extent(rejectedSizing,32,24,64,48);extent(rejectedHistory,64,48,64,48);
    assert(shaderCreates[prefixFile]==1&&newest(prefixFile)==oldPrefix&&shaderCreates[sizingFile]==2&&shaderCreates[historyFile]==2);encode(accepted,rejected.second);
    tail[@"parameters"]=@{@"Gain":@[@0.5]};publishNodes(path,@"9",nodes);auto recovered=prepare();assert(recovered.first.execution&&recovered.first.execution!=accepted&&recovered.first.error.empty());
    const auto newSizing=newest(sizingFile),newHistory=newest(historyFile);
    assert(newSizing!=oldSizing&&newSizing!=rejectedSizing&&newHistory!=oldHistory&&newHistory!=rejectedHistory);
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
    const auto fixedCounts=shaderCreates;resizeOutput(96,72);auto fixedResize=prepare();
    assert(fixedResize.first.execution&&fixedResize.first.error.empty());
    assert(shaderCreates==fixedCounts&&newest(prefixFile)==oldPrefix&&newest(sizingFile)==restoredSizing&&newest(historyFile)==restoredHistory);
    extent(restoredSizing,32,24,32,24);extent(restoredHistory,32,24,32,24);encode(fixedResize.first.execution,fixedResize.second);
    sizing[@"outputExtent"]=@"presentation";publishNodes(path,@"b",nodes);auto presented=prepare();
    assert(presented.first.execution&&presented.first.error.empty());
    const auto presentedSizing=newest(sizingFile),presentedHistory=newest(historyFile);
    extent(presentedSizing,32,24,96,72);extent(presentedHistory,96,72,96,72);encode(presented.first.execution,presented.second);
    resizeOutput(128,96);tail[@"parameters"]=@{@"Reject":@[@(-1)]};publishNodes(path,@"c",nodes);auto rejectedResize=prepare();
    assert(rejectedResize.first.execution==presented.first.execution&&!rejectedResize.first.error.empty());
    extent(presentedSizing,32,24,96,72);extent(presentedHistory,96,72,96,72);
    extent(newest(sizingFile),32,24,128,96);extent(newest(historyFile),128,96,128,96);
    assert(newest(sizingFile)!=presentedSizing&&newest(historyFile)!=presentedHistory&&newest(prefixFile)==oldPrefix&&shaderCreates[prefixFile]==1);
    encode(presented.first.execution,rejectedResize.second);
    tail[@"parameters"]=@{@"Gain":@[@0.5]};publishNodes(path,@"d",nodes);auto recoveredResize=prepare();
    assert(recoveredResize.first.execution&&recoveredResize.first.error.empty());
    extent(newest(sizingFile),32,24,128,96);extent(newest(historyFile),128,96,128,96);
    extent(presentedSizing,32,24,96,72);extent(presentedHistory,96,72,96,72);
    assert(newest(prefixFile)==oldPrefix&&shaderCreates[prefixFile]==1);encode(recoveredResize.first.execution,recoveredResize.second);
    std::puts("ordered candidate geometry: rejected presentation sizing preserved accepted shader/history extents, stable prefix reused, recovery and reverse toggle isolated retained nodes, completed pixels/source preserved");
    std::puts("drawable-only resize retained fixed source history; presentation-sized replacement isolated changed extents and failed suffix, then recovered");
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
            const auto selected=executor.prepare(frame,true);assert(selected.execution&&selected.error.empty()&&selected.execution->generator());
            assert(selected.execution->generationWidth()==gw&&selected.execution->generationHeight()==gh);
            auto prefix=frame;prefix.target=working;assert(selected.execution->encode(prefix).encoded);
            const auto result=selected.execution->generator()->encode(commands,working,{generated},sequence);assert(result.encoded&&!result.busy&&result.dispatches&&result.historyFrames==i+1);
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
    auto first=memory.prepare(frame);assert(first.execution);auto result=first.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);verify(output);assert(brightWidth==32);
    // Persistent denial retains compatible rows and the accepted output; it
    // must not turn into an unbounded BUSY/last-image freeze.
    std::this_thread::sleep_for(std::chrono::milliseconds(270));commands=[queue commandBuffer];frame.commands=commands;stamp(frame,2);
    auto denied=memory.prepare(frame);assert(denied.execution==first.execution&&!denied.error.empty());result=denied.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);verify(output);
    pressure.reset();std::this_thread::sleep_for(std::chrono::milliseconds(270));commands=[queue commandBuffer];frame.commands=commands;stamp(frame,3);
    auto recovered=memory.prepare(frame);assert(recovered.execution&&recovered.execution!=first.execution&&recovered.error.empty());result=recovered.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);verify(output);assert(brightWidth==1024);
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
    auto deniedResize=memory.prepare(largerFrame);assert(deniedResize.execution==accepted&&!deniedResize.error.empty());
    assert(commands.status<MTLCommandBufferStatusCommitted&&readPixels(output)==oldPixels&&readPixels(larger)==sentinel);
    pressure.reset();std::this_thread::sleep_for(std::chrono::milliseconds(270));
    commands=[queue commandBuffer];largerFrame.commands=commands;stamp(largerFrame,8);
    auto recoveredResize=memory.prepare(largerFrame);assert(recoveredResize.execution&&recoveredResize.execution!=accepted&&recoveredResize.error.empty());
    result=recoveredResize.execution->encode(largerFrame);assert(result.encoded&&!result.busy);complete(commands);verify(larger);
    // The old lease completes only now. Its retired extent must not alias or
    // overwrite the newly accepted 96x72 target or alter the original source.
    const auto largerPixels=readPixels(larger);complete(late);verify(output);
    assert(readPixels(larger)==largerPixels&&readPixels(output)==oldPixels);
    // P3 rows are rejected before model acquisition. Compatible color/fit rows
    // still receive the exact source orientation and alpha.
    publishNodes(path,@"b",@[@{@"id":@"nn",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/not-opened/p3-model",@"settings":@{}},
        @{@"id":@"fg",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/not-opened/p3-model",@"settings":@{}},shader(@"p3-color",@"/proof/p3-color")]);
    macfx::EffectPlanExecutor p3;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,4);auto color=p3.prepareWithColor(frame,true,nullptr,macfx::ImageColorSpace::DisplayP3);
    assert(color.execution&&!color.execution->generator());assert(color.execution->encode(frame).encoded);complete(commands);verify(output);
    auto hintedScale=@{@"id":@"fit-hint",@"kind":@"spatial",@"enabled":@YES,@"method":@"bilinear",@"settings":@{}};
    auto invalidFg=@{@"id":@"invalid-hinted-generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":@"/not-opened/invalid-model",@"settings":@{@"frameMultiplier":@1,@"simpleGenerationPlacement":@"source-cost-v1",@"simpleSpatialNodeId":@"fit-hint"}};
    publishNodes(path,@"c",@[shader(@"prefix",@"/proof/hint-prefix"),hintedScale,invalidFg,shader(@"suffix",@"/proof/hint-suffix")]);
    macfx::EffectPlanExecutor hinted;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,5);auto independent=hinted.prepare(frame,true);
    assert(independent.execution&&!independent.execution->generator());assert(independent.execution->encode(frame).encoded);complete(commands);verify(output);
    assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);puts("Actual executor GPU: controlled admission denial continued compatible effects; denied 64x48-to-96x72 replacement retained accepted graph/pixels, release recovered, late old-target completion preserved new pixels; P3 NN/FG bypass before model open, orientation/alpha preserved by controlled shader provider");return 0;
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
    // without calling a provider, then the ordinary color stage still runs.
    macfx::EffectPlanExecutor absent;auto selected=absent.prepare(frame,true);assert(selected.execution&&selected.error.empty()&&!selected.execution->hasTemporal());
    assert(!temporalCalls&&!temporalProbeCalls);auto result=selected.execution->encode(frame);assert(result.encoded&&!result.reason.empty());complete(commands);check();
    // A provider initialization failure is stage-local at first launch, with
    // the declared 16x16 scene output preserved for the later shader.
    temporalProbeStatus=RS_TEMPORAL_UNAVAILABLE;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,2);auto scene=sceneFor(frame);
    macfx::EffectPlanExecutor unavailable;selected=unavailable.prepare(frame,true,&scene);assert(selected.execution&&selected.error.empty()&&!selected.execution->hasTemporal()&&temporalProbeCalls==1);
    result=selected.execution->encode(frame);assert(result.encoded&&!result.reason.empty());complete(commands);check();
    // Live replacements are strict: a rejected temporal candidate cannot
    // remove or mutate the previously accepted color-only chain.
    publishNodes(path,@"b",@[shader(@"original",@"/proof/accepted-color")]);macfx::EffectPlanExecutor live;
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,3);auto original=live.prepare(frame,true);assert(original.execution&&original.error.empty());
    publishNodes(path,@"c",@[temporal,shader(@"color",@"/proof/temporal-color")]);commands=[queue commandBuffer];frame.commands=commands;stamp(frame,4);scene=sceneFor(frame);
    auto rejected=live.prepare(frame,true,&scene);assert(rejected.execution==original.execution&&!rejected.error.empty());assert(rejected.execution->encode(frame).encoded);complete(commands);check(8);
    // A mismatched receipt never reaches the backend and remains transient.
    // A later valid receipt is retried; its partial failing write is fully
    // overwritten before the independent shader consumes that scene output.
    temporalProbeStatus=RS_TEMPORAL_OK;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,5);scene=sceneFor(frame);macfx::EffectPlanExecutor processing;
    selected=processing.prepare(frame,true,&scene);assert(selected.execution&&selected.execution->hasTemporal());const auto before=temporalCalls,releases=temporalReleases;
    auto mismatch=scene;mismatch.commandBuffer=nullptr;result=selected.execution->encodeScene(frame,mismatch);assert(result.encoded&&!result.reason.empty()&&temporalCalls==before&&temporalReleases>releases);after(selected.execution,frame);complete(commands);check();
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,6);scene=sceneFor(frame);temporalEncodeStatus=RS_TEMPORAL_FAILED;
    result=selected.execution->encodeScene(frame,scene);assert(result.encoded&&!result.reason.empty()&&temporalCalls==before+1);after(selected.execution,frame);complete(commands);check();
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,7);scene=sceneFor(frame);result=selected.execution->encodeScene(frame,scene);assert(result.encoded&&!result.reason.empty()&&temporalCalls==before+1);after(selected.execution,frame);complete(commands);check();
    // Busy is different from rejection: retain the last complete presentation
    // without fitting raw input or running the later shader on this attempt.
    publishNodes(path,@"d",@[temporal,shader(@"color",@"/proof/temporal-color")]);commands=[queue commandBuffer];frame.commands=commands;stamp(frame,8);scene=sceneFor(frame);macfx::EffectPlanExecutor busy;
    selected=busy.prepare(frame,true,&scene);assert(selected.execution&&selected.execution->hasTemporal());const auto previous=check();temporalEncodeStatus=RS_TEMPORAL_BUSY;
    result=selected.execution->encodeScene(frame,scene);assert(!result.encoded&&result.busy);complete(commands);assert(check()==previous);
    // Typed shader resource pressure uses the same coherent hold as neural and
    // temporal work, even if the provider wrote its private scratch first.
    publishNodes(path,@"e",@[shader(@"busy-shader",@"/proof/encode-busy"),shader(@"later-shader",@"/proof/after-busy")]);
    commands=[queue commandBuffer];frame.commands=commands;stamp(frame,9);macfx::EffectPlanExecutor shaderOwner;
    auto ready=shaderOwner.prepare(frame,true);assert(ready.execution&&ready.error.empty());
    result=ready.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);check(8);assert(afterBusyCalls==1);
    std::array<unsigned char,16*16*4> heldPixels{};
    [output replaceRegion:MTLRegionMake2D(0,0,16,16) mipmapLevel:0 withBytes:heldPixels.data() bytesPerRow:64];
    shaderBusy=true;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,10);
    result=ready.execution->encode(frame);assert(!result.encoded&&result.busy);complete(commands);
    assert(afterBusyCalls==1&&readPixels(output)==std::vector<unsigned char>(heldPixels.begin(),heldPixels.end()));
    shaderBusy=false;commands=[queue commandBuffer];frame.commands=commands;stamp(frame,11);
    result=ready.execution->encode(frame);assert(result.encoded&&!result.busy);complete(commands);check(8);assert(afterBusyCalls==2);
    std::array<unsigned char,8*8*4> unchanged{};[input getBytes:unchanged.data() bytesPerRow:32 fromRegion:MTLRegionMake2D(0,0,8,8) mipmapLevel:0];assert(unchanged==source);
    assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);std::puts("ordered temporal fallback: missing/unavailable scene row isolated, live replacement retained, partial failure overwritten, downstream pixels/extent/frame metadata preserved, typed shader/temporal busy kept previous image and recovered");return 0;
}
}
namespace macfx {std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &spec){auto value=std::make_shared<Shader>(spec.selection.file);lastShader[spec.selection.file]=value;++shaderCreates[spec.selection.file];if(capturedShaders)capturedShaders->push_back(value);return value;}}
extern "C" int rsProcessTemporalFrame(const RSTemporalFrame *frame,RSTemporalResult *result){
    if(!temporalFixture){static const auto original=reinterpret_cast<decltype(&rsProcessTemporalFrame)>(dlsym(RTLD_NEXT,"rsProcessTemporalFrame"));assert(original);return original(frame,result);}
    assert(frame&&result&&frame->owner&&frame->commandBuffer&&frame->color&&frame->output);assert(frame->frameId==expectedFrameId&&frame->frameTimeMs==12.5f);
    assert(frame->renderWidth==8&&frame->renderHeight==8&&frame->outputWidth==16&&frame->outputHeight==16&&!frame->depth&&!frame->motion);
    const bool probe=frame->flags&RS_TEMPORAL_RESET;const auto status=probe?temporalProbeStatus:temporalEncodeStatus;if(probe)++temporalProbeCalls;else ++temporalCalls;
    result->status=status;result->encoded=status==RS_TEMPORAL_OK;
    std::snprintf(result->reason,sizeof(result->reason),"Controlled temporal %s",status==RS_TEMPORAL_BUSY?"busy":status==RS_TEMPORAL_UNAVAILABLE?"initialization failure":"encode failure");
    if(!probe&&status==RS_TEMPORAL_FAILED){auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=(__bridge id<MTLTexture>)frame->output;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,0);auto encoder=[(__bridge id<MTLCommandBuffer>)frame->commandBuffer renderCommandEncoderWithDescriptor:pass];assert(encoder);[encoder endEncoding];}
    return status;
}
extern "C" void rsReleaseTemporalOwner(void *owner){
    if(temporalFixture){if(owner)++temporalReleases;return;}
    static const auto original=reinterpret_cast<decltype(&rsReleaseTemporalOwner)>(dlsym(RTLD_NEXT,"rsReleaseTemporalOwner"));assert(original);original(owner);
}
int main(int argc,char **argv){@autoreleasepool{
    const bool generation=argc==3&&!std::strcmp(argv[1],"--generation-geometry");
    assert(argc==1||generation||(argc==2&&(!std::strcmp(argv[1],"--temporal-fallback")||!std::strcmp(argv[1],"--memory-color-fallback")||!std::strcmp(argv[1],"--candidate-geometry"))));
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(generation?30:10)*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Ordered fallback check timed out\n",stderr);std::_Exit(2);});
    char temporary[]="/tmp/maclauncher-effects-fallback-XXXXXX";assert(mkdtemp(temporary));NSString *directory=[NSString stringWithUTF8String:temporary],*path=[directory stringByAppendingPathComponent:@"plan.json"];
    NSString *log=std::getenv("RESHADE_LOG")?[NSString stringWithUTF8String:std::getenv("RESHADE_LOG")]:[directory stringByAppendingPathComponent:@"native.log"];
    setenv("RESHADE_LOG",log.fileSystemRepresentation,1);setenv("RESHADE_DIAGNOSTICS","1",1);
    setenv("RESHADE_EFFECT_PLAN",path.fileSystemRepresentation,1);
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    if(generation)return generationGeometry(directory,path,device,queue,@(argv[2]));
    if(argc==2&&!std::strcmp(argv[1],"--temporal-fallback"))return temporalFallback(directory,path,device,queue);
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto input=[device newTextureWithDescriptor:d];d.width=64;d.height=48;auto output=[device newTextureWithDescriptor:d];std::array<unsigned char,32*24*4> pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=16+4*(i/(32*4));pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=64;}
    [input replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    if(argc==2&&!std::strcmp(argv[1],"--candidate-geometry")){candidateGeometry(path,queue,input,output);assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);return 0;}
    if(argc==2)return memoryColorFallback(directory,path,device,queue,input,output);
    publish(path,@"a",@"/proof/encode-fails");macfx::EffectPlanExecutor executor;std::shared_ptr<macfx::EffectExecution> previous;
    // A generic frame owner is not necessarily an Objective-C object. Exercise
    // the actual ingress lookup while an advanced plan enables its depth path.
    int opaqueOwner=0;
    assert(!macfx::viewPresentationForOwner(nullptr)&&!macfx::viewPresentationForOwner(&opaqueOwner));
    assert(!macfx::frameRequiresDepth(&opaqueOwner,device,32,24));
    rsReleaseFrameOwner(&opaqueOwner);
    for(unsigned frame=1;frame<=2;++frame){auto commands=[queue commandBuffer];macfx::ShaderFrame context{commands,input,output};stamp(context,frame);auto selected=executor.prepare(context);assert(selected.execution&&selected.error.empty());previous=selected.execution;auto encoded=previous->encode(context);assert(encoded.encoded&&!encoded.reason.empty());[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);}
    assert(partialCalls==1);
    publish(path,@"c",@"/proof/prepare-fails");auto commands=[queue commandBuffer];macfx::ShaderFrame context{commands,input,output};stamp(context,3);auto retained=executor.prepare(context);assert(retained.execution==previous&&!retained.error.empty());assert(retained.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];verify(output);
    macfx::EffectPlanExecutor firstLaunch;commands=[queue commandBuffer];context.commands=commands;stamp(context,4);auto skipped=firstLaunch.prepare(context);assert(skipped.execution);assert(skipped.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);
    publish(path,@"d",@"/proof/encode-fails",@{@"x":@0.5,@"y":@0.5});commands=[queue commandBuffer];context.commands=commands;stamp(context,5);auto resized=executor.prepare(context);assert(resized.execution&&resized.error.empty());assert(resized.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);assert(brightWidth==16&&partialWidth==16&&partialCalls==2);
    publish(path,@"e",@"/proof/encode-fails",nil,true);macfx::EffectPlanExecutor unavailableGeneration;commands=[queue commandBuffer];context.commands=commands;stamp(context,6);auto realFrames=unavailableGeneration.prepare(context);assert(realFrames.execution&&!realFrames.execution->graphics().generation);assert(realFrames.execution->encode(context).encoded);[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);
    // Rejecting a later parameter change cannot alter any retained node or a
    // suffix batch using the previous execution. Unchanged rows stay shared.
    auto prefix=shader(@"prefix",@"/proof/immutable-prefix");
    auto first=[shader(@"first",@"/proof/immutable-first")mutableCopy],second=[shader(@"second",@"/proof/immutable-second")mutableCopy];
    first[@"parameters"]=@{@"Gain":@[@0.25]};second[@"parameters"]=@{@"Gain":@[@0.5]};
    publishNodes(path,@"f",@[prefix,first,second]);macfx::EffectPlanExecutor immutable;
    commands=[queue commandBuffer];context.commands=commands;stamp(context,7);auto original=immutable.prepare(context);assert(original.execution&&original.error.empty());
    const auto oldPrefix=lastShader["/proof/immutable-prefix"].lock(),oldFirst=lastShader["/proof/immutable-first"].lock(),oldSecond=lastShader["/proof/immutable-second"].lock();assert(oldPrefix&&oldFirst&&oldSecond);
    first[@"parameters"]=@{@"Gain":@[@0.75]};second[@"parameters"]=@{@"Reject":@[@(-1)]};
    publishNodes(path,@"1",@[prefix,first,second]);commands=[queue commandBuffer];context.commands=commands;stamp(context,8);auto invalid=immutable.prepare(context);
    assert(invalid.execution==original.execution&&!invalid.error.empty());
    assert(oldFirst->parameters.at("Gain")[0]==.25f&&oldSecond->parameters.at("Gain")[0]==.5f);
    assert(shaderCreates["/proof/immutable-prefix"]==1&&lastShader["/proof/immutable-prefix"].lock()==oldPrefix);
    second[@"parameters"]=@{@"Gain":@[@0.5]};publishNodes(path,@"2",@[prefix,first,second]);
    commands=[queue commandBuffer];context.commands=commands;stamp(context,9);auto replaced=immutable.prepare(context);assert(replaced.execution&&replaced.execution!=original.execution&&replaced.error.empty());
    assert(lastShader["/proof/immutable-first"].lock()!=oldFirst&&lastShader["/proof/immutable-first"].lock()->parameters.at("Gain")[0]==.75f);
    assert(oldFirst->parameters.at("Gain")[0]==.25f&&oldSecond->parameters.at("Gain")[0]==.5f&&shaderCreates["/proof/immutable-prefix"]==1);
    candidateGeometry(path,queue,input,output);
    // Capture demand includes the accepted chain until replacement succeeds,
    // then releases depth instead of keeping a process-wide sticky demand.
    auto depthNode=[shader(@"depth",@"/proof/retained-depth")mutableCopy];depthNode[@"requirements"]=@{@"depth":@YES};
    publishNodes(path,@"3",@[depthNode]);macfx::EffectPlanExecutor depthPlan;macfx::DepthFrame depth{input,10,macfx::FrameOrigin::BottomLeft};
    commands=[queue commandBuffer];context.commands=commands;context.depth=&depth;stamp(context,10);auto withDepth=depthPlan.prepare(context);assert(withDepth.execution&&withDepth.error.empty()&&withDepth.execution->requiresDepth()&&depthPlan.requiresDepth());
    publishNodes(path,@"4",@[shader(@"invalid",@"/proof/prepare-fails")]);assert(depthPlan.requiresDepth());
    commands=[queue commandBuffer];context.commands=commands;stamp(context,11);auto invalidDepth=depthPlan.prepare(context);assert(invalidDepth.execution==withDepth.execution&&!invalidDepth.error.empty()&&depthPlan.requiresDepth());
    publishNodes(path,@"5",@[shader(@"color",@"/proof/depth-free")]);assert(depthPlan.requiresDepth());
    commands=[queue commandBuffer];context.commands=commands;context.depth=nullptr;stamp(context,12);auto withoutDepth=depthPlan.prepare(context);assert(withoutDepth.execution&&withoutDepth.error.empty()&&!withoutDepth.execution->requiresDepth()&&!depthPlan.requiresDepth());
    // A native producer already at half the presentation needs no reduction
    // allocation/filter pass. Its color, orientation and alpha still reach the
    // remaining shader and final fit through an actual completed GPU buffer.
    publishNodes(path,@"6",@[@{@"id":@"allocation-guard",@"kind":@"spatial",@"enabled":@YES,
        @"method":@"downsample",@"presentationScale":@0.5,@"settings":@{@"spatialMultiplier":NSNull.null}},
        shader(@"guarded-color",@"/proof/bright")]);
    macfx::EffectPlanExecutor guarded;commands=[queue commandBuffer];context.commands=commands;stamp(context,13);
    auto ready=guarded.prepare(context);assert(ready.execution&&ready.error.empty());assert(ready.execution->encode(context).encoded);
    [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);verify(output);
    NSString *reported=[NSString stringWithContentsOfFile:log encoding:NSUTF8StringEncoding error:nil];
    assert([reported containsString:@"allocation-guard requestedMethod=downsample active=bypass input=32x24 output=32x24"]);
    std::array<unsigned char,32*24*4> unchanged;[input getBytes:unchanged.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(unchanged==pixels);
    assert([[NSFileManager defaultManager]removeItemAtPath:directory error:nil]);std::puts("ordered fallback: partial writes bypassed, order and resize preserved, immutable live parameters, unchanged node reuse, accepted depth demand and unavailable rows passed");return 0;
}}
