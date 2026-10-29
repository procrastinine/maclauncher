// Copyright (c) MacLauncher contributors. MIT license.
#include "neural-node.hpp"
#include "fixture-files.hpp"
#include "effects-execution.hpp"
#include "video-frame.h"
#include "process-phase.hpp"
#include <cstdlib>
#include <dlfcn.h>
#import <Metal/Metal.h>
#include <algorithm>
#include <array>
#include <cassert>
#include <chrono>
#include <optional>
#include <thread>
#include <cstdio>
// Plan preparation runs off the frame path. Poll it with fresh unsubmitted
// buffers; the accepted execution then encodes into the frame's own buffer.
static macfx::EffectExecutionSelection prepared(macfx::EffectPlanExecutor &executor,const macfx::ShaderFrame &frame){
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(8);
    for(;;){auto observation=frame;observation.commands=[frame.commands.commandQueue commandBuffer];auto selected=executor.prepare(observation);
        if(!selected.preparing)return selected;assert(std::chrono::steady_clock::now()<deadline);std::this_thread::sleep_for(std::chrono::milliseconds(1));}
}
// A provider slower than the GPU wait bound never holds the caller's command
// buffer past it, and a transient provider failure re-arms after its backoff.
static int deadline(){
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Neural wait bound checks timed out\n",stderr);std::_Exit(2);});
    using clock=std::chrono::steady_clock;
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto source=[device newTextureWithDescriptor:d],target=[device newTextureWithDescriptor:d];
    std::array<unsigned char,32*24*4> pixels,output;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=32;pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=64;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    const auto read=[&]{[target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];};
    const auto processed=[&]{for(unsigned i=0;i<output.size();i+=4)if(output[i]!=32||output[i+1]!=64||output[i+2]!=255||output[i+3]!=64)return false;return true;};
    const auto run=[&](macfx::ShaderFrame &frame){const auto started=clock::now();[frame.commands commit];[frame.commands waitUntilCompleted];assert(frame.commands.status==MTLCommandBufferStatusCompleted);return std::chrono::duration<double>(clock::now()-started).count();};
    auto node=macfx::makeNeuralNode({"/test/local-model",1,false});
    // The first inference takes 2.6 s, longer than the 2 s bound: the frame
    // completes at the bound with its passthrough image instead of reaching
    // the GPU watchdog.
    setenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS","2600",1);
    macfx::ShaderFrame frame{[queue commandBuffer],source,target,1};assert(node->encode(frame).encoded);
    const double bounded=run(frame);unsetenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS");read();
    if(!(bounded>1.8&&bounded<2.4))std::fprintf(stderr,"late inference held its frame for %.3f s\n",bounded);
    assert(bounded>1.8&&bounded<2.4&&output==pixels);
    // While that inference completes, frames continue without the row.
    auto later=frame;later.commands=[queue commandBuffer];later.frameId=2;auto bypassed=node->encode(later);
    assert(!bypassed.encoded&&!bypassed.busy&&bypassed.reason.find("GPU wait bound")!=std::string::npos);run(later);
    // Then the row renders within the frame again.
    double resumedAfter=0,resumed=0;const auto lateAt=clock::now();
    for(uint64_t id=3;;++id){auto next=frame;next.commands=[queue commandBuffer];next.frameId=id;const auto result=node->encode(next);
        if(result.encoded){resumed=run(next);resumedAfter=std::chrono::duration<double>(clock::now()-lateAt).count();break;}
        assert(result.reason.find("GPU wait bound")!=std::string::npos&&clock::now()-lateAt<std::chrono::seconds(3));run(next);std::this_thread::sleep_for(std::chrono::milliseconds(20));}
    read();assert(processed()&&resumed<0.5);
    // A transient provider failure keeps its frame's passthrough image, and
    // the row is unavailable only for its backoff, then renders again.
    setenv("MACLAUNCHER_TEST_NEURAL_FAIL","1",1);
    auto failing=frame;failing.commands=[queue commandBuffer];failing.frameId=100;assert(node->encode(failing).encoded);run(failing);unsetenv("MACLAUNCHER_TEST_NEURAL_FAIL");
    read();assert(output==pixels);
    auto refused=frame;refused.commands=[queue commandBuffer];refused.frameId=101;const auto unavailable=node->encode(refused);run(refused);
    assert(!unavailable.encoded&&!unavailable.busy&&unavailable.reason=="Neural provider failed; retrying: Test transient provider failure");
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    auto rearmed=frame;rearmed.commands=[queue commandBuffer];rearmed.frameId=102;const auto again=node->encode(rearmed);
    if(!again.encoded)std::fprintf(stderr,"after its backoff the row reported: %s\n",again.reason.c_str());
    assert(again.encoded);run(rearmed);read();assert(processed());
    std::printf("neural wait bound: late frame released at %.3f s, row resumed %.3f s later (%.3f s frame), failure re-armed after its backoff: pass\n",bounded,resumedAfter,resumed);
    return 0;
}
// A graph's neural row warms its provider before adoption: the cold first
// inference runs with no frame waiting for it, the previous chain keeps
// rendering meanwhile, and the warmed node is the one adopted. The provider
// admits only opaque sources, as the MLX provider does, so the warm-up's
// own image must not decide admission for the opaque frames that follow.
static int offlineWarmup(){
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,12*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Offline neural warm-up checks timed out\n",stderr);std::_Exit(2);});
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto source=[device newTextureWithDescriptor:d],target=[device newTextureWithDescriptor:d];assert(source&&target);
    std::array<unsigned char,32*24*4> pixels,output;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=32;pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=255;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    // This provider lacks CUGAN's v2 entrypoint. Its permanent row failure
    // must leave the independent, delayed image operation available.
    NSDictionary*document=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0],@"nodes":@[
        @{@"id":@"unsupported",@"kind":@"neural",@"enabled":@YES,@"method":@"realcugan",@"modelPath":@"/test/unsupported-operation"},
        @{@"id":@"healthy",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/test/offline-model",@"settings":@{@"intensity":@1,@"temporal":@NO}}]};
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],@(std::getenv("RESHADE_EFFECT_PLAN"))));macfx::refreshEffectPlan();
    const auto module=dlopen(std::getenv("RESHADE_NEURAL_LIBRARY"),RTLD_NOW);assert(module);
    const auto submissions=reinterpret_cast<unsigned(*)()>(dlsym(module,"ml_test_neural_submissions"));assert(submissions);const auto before=submissions();
    setenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS","2600",1);
    std::thread releaseDelay([&]{while(submissions()==before)std::this_thread::sleep_for(std::chrono::milliseconds(1));std::this_thread::sleep_for(std::chrono::milliseconds(100));unsetenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS");});
    char error[512]{};void*video=rsVideoCreate((__bridge void*)queue,error,sizeof(error));assert(video);
    const RSVideoFrame frame{sizeof(RSVideoFrame),1,(__bridge void*)source,(__bridge void*)target,1,0,1000};
    const auto start=std::chrono::steady_clock::now();const int status=rsVideoProcess(video,&frame,error,sizeof(error));releaseDelay.join();
    if(status)std::fprintf(stderr,"Offline neural processing failed: %s\n",error);
    assert(!status&&std::chrono::steady_clock::now()-start>=std::chrono::milliseconds(2500));
    const auto processed=[&]{[target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];for(unsigned i=0;i<output.size();i+=4)if(output[i]!=32||output[i+1]!=64||output[i+2]!=255||output[i+3]!=255)return false;return true;};assert(processed());
    auto next=frame;next.frameId=2;next.timeMs=1000;RSVideoSequenceOutput image{(__bridge void*)target};RSVideoSequence sequence{sizeof(RSVideoSequence),1,1,0,&image};
    const int timeline=rsVideoProcessSequence(video,&next,&sequence,nullptr,nullptr,error,sizeof(error));if(timeline)std::fprintf(stderr,"Offline neural timeline failed: %s\n",error);
    assert(!timeline&&sequence.count==1&&processed());rsVideoRelease(video);
    std::puts("Offline neural: warm-up longer than live grace completes before exact output; unsupported row preserves healthy image and timeline processing");return 0;
}
static int warmup(){
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Neural warm-up checks timed out\n",stderr);std::_Exit(2);});
    using clock=std::chrono::steady_clock;
    setenv("MACLAUNCHER_TEST_NEURAL_REQUIRE_OPAQUE","1",1);
    const auto providers=reinterpret_cast<unsigned(*)()>(dlsym(dlopen(std::getenv("RESHADE_NEURAL_LIBRARY"),RTLD_NOW),"ml_test_neural_providers"));assert(providers);
    const auto submissions=reinterpret_cast<unsigned(*)()>(dlsym(dlopen(std::getenv("RESHADE_NEURAL_LIBRARY"),RTLD_NOW),"ml_test_neural_submissions"));assert(submissions);
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto source=[device newTextureWithDescriptor:d],target=[device newTextureWithDescriptor:d];
    std::array<unsigned char,32*24*4> pixels,output;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=32;pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=255;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    // A started warm-up resolves with no further call: nothing else holds it
    // before its submission, so it reaches the provider exactly once and the
    // node is then warm. A released warm-up would read as finished, unsent.
    for(int trial=0;trial<8;++trial){auto node=macfx::makeNeuralNode({"/test/direct-warm",1,false});
        const macfx::ShaderFrame cold{[queue commandBuffer],source,target,1};const unsigned before=submissions();
        const auto begun=macfx::warmNeuralNode(node,cold);assert(!begun.encoded&&begun.busy);
        const auto until=clock::now()+std::chrono::seconds(3);
        while(macfx::neuralWarmupStatus(node).busy){assert(clock::now()<until);std::this_thread::sleep_for(std::chrono::milliseconds(1));}
        if(submissions()!=before+1)std::fprintf(stderr,"warm-up trial %d: the provider received %u submissions\n",trial,submissions()-before);
        assert(submissions()==before+1&&macfx::warmNeuralNode(node,cold).encoded);}
    NSString *planPath=[NSString stringWithUTF8String:std::getenv("RESHADE_EFFECT_PLAN")];
    const auto plan=[&](NSString *model,NSString *revision){NSDictionary *value=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:revision startingAtIndex:0],@"nodes":@[@{@"id":@"neural",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":model,@"settings":@{@"intensity":@1,@"temporal":@NO}}]};
        assert(replaceFile([NSJSONSerialization dataWithJSONObject:value options:0 error:nil],planPath));macfx::refreshEffectPlan();};
    macfx::ShaderFrame frame{nil,source,target,1};uint64_t frameId=1;
    // Renders one frame through an execution; true when the row processed it.
    double slowest=0;
    const auto render=[&](const std::shared_ptr<macfx::EffectExecution>&execution){auto work=frame;work.commands=[queue commandBuffer];work.frameId=++frameId;
        const auto t=clock::now();const auto encoded=execution->encode(work);[work.commands commit];[work.commands waitUntilCompleted];
        assert(work.commands.status==MTLCommandBufferStatusCompleted);slowest=std::max(slowest,std::chrono::duration<double>(clock::now()-t).count());
        [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
        bool processed=encoded.encoded&&encoded.reason.empty();for(unsigned i=0;processed&&i<output.size();i+=4)processed=output[i]==32&&output[i+1]==64&&output[i+2]==255&&output[i+3]==255;
        return processed;};
    macfx::EffectPlanExecutor executor;
    plan(@"/test/local-model",@"e");auto first=frame;first.commands=[queue commandBuffer];const auto previous=prepared(executor,first).execution;
    assert(previous);for(int attempt=0;!render(previous);++attempt){assert(attempt<100);std::this_thread::sleep_for(std::chrono::milliseconds(20));}
    const unsigned baseline=providers();
    // The edited row's provider takes 2.6 s for its first inference. The
    // delay applies while the warm-up starts; later inferences take none.
    plan(@"/test/warm-model",@"f");setenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS","2600",1);
    const auto started=clock::now();bool warming=false,delaySet=true;unsigned held=0;macfx::EffectExecutionSelection selected;std::string reasons,last;std::optional<clock::time_point>warmingAt;
    for(;;){auto observation=frame;observation.commands=[queue commandBuffer];selected=executor.prepare(observation);
        warming|=selected.preparing&&selected.error.find("warming up")!=std::string::npos;
        if(selected.error!=last){last=selected.error;char at[32];std::snprintf(at,sizeof(at),"\n  %.3f s: ",std::chrono::duration<double>(clock::now()-started).count());reasons+=at+last;}
        if(warming&&!warmingAt)warmingAt=clock::now();
        if(delaySet&&warmingAt&&clock::now()-*warmingAt>std::chrono::milliseconds(100)){unsetenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS");delaySet=false;}
        if(!selected.preparing&&selected.error.empty())break;
        // Until then the previous chain stays selected and keeps processing.
        assert(selected.execution==previous);if(!delaySet&&render(selected.execution))++held;
        assert(clock::now()-started<std::chrono::seconds(8));std::this_thread::sleep_for(std::chrono::milliseconds(5));}
    const double adopted=std::chrono::duration<double>(clock::now()-started).count();
    // The previous output stays until the provider is warm, or until the
    // 2 s preparation grace adopts the graph with this row bypassed.
    if(!warming||adopted<1.9||!held)std::fprintf(stderr,"warm-up: preparing reason seen=%d, adopted after %.3f s, held frames %u; reasons:%s\n",warming,adopted,held,reasons.c_str());
    assert(warming&&adopted>=1.9&&held&&selected.active&&selected.execution&&selected.execution!=previous);
    // No frame waits for the cold inference; the row then renders.
    for(;;){auto work=frame;work.commands=[queue commandBuffer];auto current=executor.prepare(work);assert(current.execution);
        if(render(current.execution))break;
        assert(clock::now()-started<std::chrono::seconds(8));std::this_thread::sleep_for(std::chrono::milliseconds(20));}
    if(slowest>=0.5)std::fprintf(stderr,"warm-up: a frame took %.3f s\n",slowest);
    // Retries kept the warming node: the edit created exactly one provider.
    if(providers()!=baseline+1)std::fprintf(stderr,"warm-up: the edit created %u providers\n",providers()-baseline);
    assert(slowest<0.5&&providers()==baseline+1);
    std::printf("neural warm-up: previous chain held for %.3f s (%u processed frames), slowest frame %.3f s, warmed node adopted and processed at %.3f s with one provider: pass\n",adopted,held,slowest,std::chrono::duration<double>(clock::now()-started).count());
    return 0;
}
int main(int argc,char **argv){@autoreleasepool{
#if !defined(__arm64__)
    std::puts("Neural rendering requires Apple Silicon");return 77;
#endif
    if(@available(macOS 14.0,*)){}else {std::puts("Neural rendering requires macOS 14 or later");return 77;}
    // The plan file is a launch setting, so the checks run as a phase launched with it.
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        const bool offlineOnly=argc==3&&!std::strcmp(argv[1],"--offline");assert(offlineOnly||argc==2);const char*provider=argv[offlineOnly?2:1];
        if(offlineOnly){NSString*plan=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"neural-offline-" stringByAppendingString:NSUUID.UUID.UUIDString]];const int result=fixture::runPhase("offline",{{"RESHADE_NEURAL_LIBRARY",provider},{"RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation},{"RESHADE_EXPLICIT_HOST","1"}});[NSFileManager.defaultManager removeItemAtPath:plan error:nil];return result;}
        NSString *plan=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"neural-busy-" stringByAppendingString:NSUUID.UUID.UUIDString]];
        const int status=fixture::runPhase("checks",{{"RESHADE_NEURAL_LIBRARY",argv[1]},{"RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation}});
        [NSFileManager.defaultManager removeItemAtPath:plan error:nil];if(status)return status;
        if(const int deadlineStatus=fixture::runPhase("deadline",{{"RESHADE_NEURAL_LIBRARY",argv[1]}}))return deadlineStatus;
        NSString *warm=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"neural-warmup-" stringByAppendingString:NSUUID.UUID.UUIDString]];
        const int warmStatus=fixture::runPhase("warmup",{{"RESHADE_NEURAL_LIBRARY",argv[1]},{"RESHADE_EFFECT_PLAN",warm.fileSystemRepresentation}});
        [NSFileManager.defaultManager removeItemAtPath:warm error:nil];return warmStatus;
    }
    if(phase.name=="deadline")return deadline();
    if(phase.name=="offline")return offlineWarmup();
    if(phase.name=="warmup")return warmup();
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
    // A pending flight admits further work in its own command buffer only.
    auto other=frame;other.commands=[queue commandBuffer];auto busy=node->encode(other);assert(!busy.encoded&&busy.busy);
    [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);
    std::array<unsigned char,32*24*4> output;[target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
    for(unsigned i=0;i<output.size();i+=4)assert(output[i]==32&&output[i+1]==191&&output[i+2]==64&&output[i+3]==64);
    [source getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
    NSString *planPath=[NSString stringWithUTF8String:std::getenv("RESHADE_EFFECT_PLAN")];
    NSDictionary *plan=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0],@"nodes":@[@{@"id":@"neural",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/test/local-model",@"settings":@{@"intensity":@0.25,@"temporal":@NO}}]};
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:plan options:0 error:nil],planPath));macfx::refreshEffectPlan();
    macfx::EffectPlanExecutor executor;auto first=frame;first.commands=[queue commandBuffer];first.frameId=10;
    auto selected=prepared(executor,first);assert(selected.active&&selected.execution&&selected.error.empty());assert(selected.execution->encode(first).encoded);
    auto held=[device newTextureWithDescriptor:d];std::array<unsigned char,32*24*4> sentinel;sentinel.fill(37);[held replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:sentinel.data() bytesPerRow:128];
    auto second=first;second.commands=[queue commandBuffer];second.target=held;second.frameId=11;auto deferred=selected.execution->encode(second);assert(!deferred.encoded&&deferred.busy);
    [second.commands commit];[second.commands waitUntilCompleted];[held getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==sentinel);
    [first.commands commit];[first.commands waitUntilCompleted];assert(first.commands.status==MTLCommandBufferStatusCompleted);
    NSMutableDictionary *automatic=[@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"d" startingAtIndex:0],@"nodes":@[@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"ls1",@"settings":@{}}]} mutableCopy];
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:automatic options:0 error:nil],planPath));macfx::refreshEffectPlan();
    macfx::EffectPlanExecutor fit;auto fitting=frame;fitting.commands=[queue commandBuffer];fitting.frameId=12;auto unchanged=prepared(fit,fitting);assert(unchanged.execution&&unchanged.error.empty());auto copied=unchanged.execution->encode(fitting);assert(copied.encoded&&copied.reason.empty());[fitting.commands commit];[fitting.commands waitUntilCompleted];
    [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
    automatic[@"revision"]=[@"" stringByPaddingToLength:64 withString:@"e" startingAtIndex:0];automatic[@"nodes"]=@[@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"ls1",@"settings":@{@"spatialMultiplier":@1}}];
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:automatic options:0 error:nil],planPath));std::this_thread::sleep_for(std::chrono::milliseconds(110));fitting.commands=[queue commandBuffer];auto explicitFilter=prepared(fit,fitting);
    // The unavailable explicit filter is bypassed in the adopted edit, so the image passes through unchanged.
    if(explicitFilter.execution==unchanged.execution)std::fprintf(stderr,"explicit filter kept the previous execution: %s\n",explicitFilter.error.c_str());
    assert(explicitFilter.execution&&explicitFilter.execution!=unchanged.execution);assert(explicitFilter.execution->encode(fitting).encoded);[fitting.commands commit];[fitting.commands waitUntilCompleted];
    [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(output==pixels);
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
    // Provider submission waits for the GPU to reach the producer signal, so
    // an uncommitted frame cannot time out at the provider. It keeps other
    // buffers busy without failing the owner, and a late commit is processed.
    auto abandoned=macfx::makeNeuralNode({"/test/local-model",1,false});auto delayed=[queue commandBuffer];frame.commands=delayed;frame.frameId=2;assert(abandoned->encode(frame).encoded);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    auto unavailable=frame;unavailable.commands=[queue commandBuffer];assert(abandoned->prepare(unavailable).encoded);auto waiting=abandoned->encode(unavailable);assert(!waiting.encoded&&waiting.busy);
    [delayed commit];[delayed waitUntilCompleted];assert(delayed.status==MTLCommandBufferStatusCompleted);
    [target getBytes:output.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];for(unsigned i=0;i<output.size();i+=4)assert(output[i]==32&&output[i+1]==64&&output[i+2]==255&&output[i+3]==pixels[i+3]);
    std::puts("neural node: borrowed submission, upright model input, declared output origin, exact alpha, busy admission, SDR guard and deferred submission pass");return 0;
}}
