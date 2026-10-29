// Copyright (c) MacLauncher contributors. MIT license.
// Real FramePresenter completion closures with NSObject device/images/commands.
// No Metal device/queue/GPU submission or displayed timestamp is fabricated.
#include "presentation.hpp"
#include "fixture-files.hpp"
#include "process-phase.hpp"
#import <Foundation/Foundation.h>
#include <cassert>
#include <atomic>
#include <cstdio>
#include <fstream>
#include <unistd.h>
namespace {std::atomic<unsigned>queues{0},images{0},copies{0};id device;bool rejectPrivateQueue=false;}
@interface FailureTexture:NSObject
@property NSUInteger width,height;
@property MTLPixelFormat pixelFormat;
@end
@implementation FailureTexture
- (id)device{return device;}
- (NSUInteger)allocatedSize{return self.width*self.height*4;}
- (MTLTextureType)textureType{return MTLTextureType2D;}
- (NSUInteger)sampleCount{return 1;}
- (BOOL)isFramebufferOnly{return NO;}
- (MTLTextureUsage)usage{return MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;}
@end
@interface FailureBlit:NSObject
@end
@implementation FailureBlit
- (void)copyFromTexture:(id)a sourceSlice:(NSUInteger)b sourceLevel:(NSUInteger)c sourceOrigin:(MTLOrigin)d sourceSize:(MTLSize)e toTexture:(id)f destinationSlice:(NSUInteger)g destinationLevel:(NSUInteger)h destinationOrigin:(MTLOrigin)i{(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i;++copies;}
- (void)endEncoding{}
@end
@interface FailureCommands:NSObject
@property MTLCommandBufferStatus status;
@property(strong)NSMutableArray *handlers;
@end
@implementation FailureCommands
- (instancetype)init{if((self=[super init])){_handlers=[NSMutableArray new];_status=MTLCommandBufferStatusNotEnqueued;}return self;}
- (BOOL)retainedReferences{return YES;}
- (id)device{return device;}
- (id)commandQueue{return nil;}
- (id)blitCommandEncoder{return [FailureBlit new];}
- (void)addCompletedHandler:(MTLCommandBufferHandler)handler{[self.handlers addObject:[handler copy]];}
- (void)addScheduledHandler:(MTLCommandBufferHandler)handler{(void)handler;}
- (void)commit{self.status=MTLCommandBufferStatusCommitted;}
- (NSError*)error{return [NSError errorWithDomain:@"ControlledGPUFailure" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Controlled command failure"}];}
- (void)fire:(MTLCommandBufferStatus)status{self.status=status;NSArray *saved=[self.handlers copy];[self.handlers removeAllObjects];for(MTLCommandBufferHandler callback in saved)callback((id<MTLCommandBuffer>)self);}
@end
@interface FailureQueue:NSObject
@end
@implementation FailureQueue
- (id)commandBuffer{return [FailureCommands new];}
@end
@interface FailureDevice:NSObject
@end
@implementation FailureDevice
- (id)newCommandQueue{++queues;return rejectPrivateQueue?nil:[FailureQueue new];}
- (NSUInteger)recommendedMaxWorkingSetSize{return 64u<<20;}
- (NSUInteger)currentAllocatedSize{return 0;}
- (MTLSizeAndAlign)heapTextureSizeAndAlignWithDescriptor:(MTLTextureDescriptor*)descriptor{return {descriptor.width*descriptor.height*4,256};}
- (id)newTextureWithDescriptor:(MTLTextureDescriptor*)descriptor{++images;auto image=[FailureTexture new];image.width=descriptor.width;image.height=descriptor.height;image.pixelFormat=descriptor.pixelFormat;return image;}
@end
@interface FailureDrawable:NSObject
@property(strong)id texture;
@end
@implementation FailureDrawable
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler{(void)handler;} // No physical presentation.
@end
@interface FailureLayer:CAMetalLayer
@end
@implementation FailureLayer
- (id<MTLDevice>)device{return (id<MTLDevice>)device;}
- (id<CAMetalDrawable>)nextDrawable{auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:self.pixelFormat width:self.drawableSize.width height:self.drawableSize.height mipmapped:NO];auto drawable=[FailureDrawable new];drawable.texture=[device newTextureWithDescriptor:descriptor];return (id<CAMetalDrawable>)drawable;}
@end
#ifdef MACFX_TEST_GENERATION_FAILURE
// Compile the real presenter with controlled CoreVideo and LSFG boundaries.
// Other frame/admission functions come from the selected coherent core.
#import <CoreVideo/CoreVideo.h>
namespace generation_failure {
enum class Fault {None,Queue,Create,CreateNil,Callback,Start,Display};
struct Counts {unsigned creates=0,callbacks=0,starts=0,stops=0,releases=0,queries=0,displays=0,encodes=0,live=0;};
Fault fault=Fault::None;Counts counts;
struct Link {bool running=false;};
Link* checked(CVDisplayLinkRef value){assert(value);return reinterpret_cast<Link*>(value);}
CVReturn create(CVDisplayLinkRef*out){++counts.creates;*out=nullptr;if(fault==Fault::Create)return kCVReturnError;if(fault==Fault::CreateNil)return kCVReturnSuccess;*out=reinterpret_cast<CVDisplayLinkRef>(new Link);++counts.live;return kCVReturnSuccess;}
CVReturn callback(CVDisplayLinkRef value,CVDisplayLinkOutputCallback,void*){checked(value);++counts.callbacks;return fault==Fault::Callback?kCVReturnError:kCVReturnSuccess;}
CVReturn start(CVDisplayLinkRef value){auto link=checked(value);++counts.starts;if(fault==Fault::Start)return kCVReturnError;link->running=true;return kCVReturnSuccess;}
CVReturn stop(CVDisplayLinkRef value){checked(value)->running=false;++counts.stops;return kCVReturnSuccess;}
void release(CVDisplayLinkRef value){delete checked(value);++counts.releases;assert(counts.live);--counts.live;}
bool running(CVDisplayLinkRef value){++counts.queries;return checked(value)->running;}
CVReturn display(CVDisplayLinkRef value,CGDirectDisplayID){checked(value);++counts.displays;return fault==Fault::Display?kCVReturnError:kCVReturnSuccess;}
}
#define CVDisplayLinkCreateWithActiveCGDisplays generation_failure::create
#define CVDisplayLinkSetOutputCallback generation_failure::callback
#define CVDisplayLinkStart generation_failure::start
#define CVDisplayLinkStop generation_failure::stop
#define CVDisplayLinkRelease generation_failure::release
#define CVDisplayLinkIsRunning generation_failure::running
#define CVDisplayLinkSetCurrentCGDisplay generation_failure::display
#ifndef MACFX_PRESENTATION_FAILURE_SOURCE
#define MACFX_PRESENTATION_FAILURE_SOURCE <presentation.mm>
#endif
#include MACFX_PRESENTATION_FAILURE_SOURCE
#undef CVDisplayLinkCreateWithActiveCGDisplays
#undef CVDisplayLinkSetOutputCallback
#undef CVDisplayLinkStart
#undef CVDisplayLinkStop
#undef CVDisplayLinkRelease
#undef CVDisplayLinkIsRunning
#undef CVDisplayLinkSetCurrentCGDisplay
// The presenter obtains its generator from the provider factory
// (prepareGenerator → makeGenerationEncoder), not from LsfgEncoder directly.
namespace macfx {
namespace {struct ControlledGeneration final:GenerationEncoder {
 const char*method()const noexcept override{return "lsfg";}
 GenerationResult encode(id<MTLCommandBuffer>,id<MTLTexture>,const std::vector<id<MTLTexture>>&,uint64_t,const InterpolationPlan&)override{++generation_failure::counts.encodes;GenerationResult result;result.encoded=true;return result;}
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
};}
std::shared_ptr<GenerationEncoder>makeGenerationEncoder(id<MTLDevice>,const std::string&,const LsfgConfig&){return std::make_shared<ControlledGeneration>();}
}
namespace {
void publishGeneration(const std::string&file,bool enabled){
    macfx::LivePacket packet{};memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=2;packet.flags=enabled?1:0;
    const auto temporary=file+".next";{std::ofstream stream(temporary,std::ios::binary);stream.write(reinterpret_cast<const char*>(&packet),sizeof(packet));assert(stream.good());}assert(!rename(temporary.c_str(),file.c_str()));macfx::refreshLiveState();
}
void generationCase(generation_failure::Fault failure,const std::string&file){
    using namespace generation_failure;assert(!counts.live);counts={};fault=failure;rejectPrivateQueue=failure==Fault::Queue;publishGeneration(file,true);
    auto layer=[FailureLayer layer];layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,24);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:layer.pixelFormat width:32 height:24 mipmapped:NO];auto source=(id<MTLTexture>)[device newTextureWithDescriptor:descriptor];
    macfx::PresenterConfig config;config.generation=macfx::LsfgConfig{"controlled-no-provider",true,false,1,2};int owner=0;
    macfx::FramePresenter presenter(layer,&owner,config);
    if(failure==Fault::Display)presenter.setDisplay(42);
    assert(!presenter.snapshot().reason.empty());const auto queueAttempts=queues.load(),createAttempts=counts.creates,startAttempts=counts.starts;
    for(unsigned frame=1;frame<=4;++frame){auto commands=[FailureCommands new];auto result=presenter.submit((id<MTLCommandBuffer>)commands,source,frame,CACurrentMediaTime());if(!result.encoded)fprintf(stderr,"FG fallback rejected: fault=%u reason=%s\n",unsigned(failure),result.reason.c_str());assert(result.encoded&&!result.busy&&!presenter.terminalGpuFailure());[commands fire:MTLCommandBufferStatusCompleted];}
    assert(queues==queueAttempts&&counts.creates==createAttempts&&counts.starts==startAttempts&&counts.encodes==0&&!counts.live);
    if(failure==Fault::Queue)assert(!counts.creates&&!counts.callbacks&&!counts.starts&&!counts.queries);
    // A real accepted Off packet is inert, then a new accepted On packet may
    // retry the same owner after the controlled allocation/timing fault clears.
    fault=Fault::None;rejectPrivateQueue=false;publishGeneration(file,false);auto off=[FailureCommands new];assert(presenter.submit((id<MTLCommandBuffer>)off,source,5,CACurrentMediaTime()).encoded);[off fire:MTLCommandBufferStatusCompleted];assert(queues==queueAttempts&&counts.creates==createAttempts&&counts.starts==startAttempts);
    publishGeneration(file,true);auto on=[FailureCommands new];auto resumed=presenter.submit((id<MTLCommandBuffer>)on,source,6,CACurrentMediaTime());if(!resumed.encoded)fprintf(stderr,"FG recovery rejected: %s\n",resumed.reason.c_str());assert(resumed.encoded&&counts.live==1&&counts.encodes==1&&counts.creates==createAttempts+1&&counts.starts==startAttempts+1);
    presenter.stop();[on fire:MTLCommandBufferStatusCompleted];assert(!counts.live);const auto afterStop=counts.starts;
    presenter.stop();assert(counts.starts==afterStop);
}
}
int main(int argc,char**argv){@autoreleasepool{
    // The control file is a launch setting: the cases run as a phase with it.
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        char temporary[1024];temporaryPath(temporary,"maclauncher-generation-failure-XXXXXX");assert(mkdtemp(temporary));const std::string file=std::string(temporary)+"/controls.bin";
        const int status=fixture::runPhase("generation",{{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_EFFECT",nullptr},{"RESHADE_EFFECT_PLAN",nullptr},{"RESHADE_LIVE_EFFECTS",nullptr},
            {"RESHADE_PRESENTATION_CONTROL_FILE",nullptr},{"RESHADE_CONTROL_FILE",file.c_str()}},{file});
        unlink(file.c_str());rmdir(temporary);return status;
    }
    assert(phase.argc==2);const std::string file=phase.argv[1];device=[FailureDevice new];
    for(const auto fault:{generation_failure::Fault::Queue,generation_failure::Fault::Create,generation_failure::Fault::CreateNil,generation_failure::Fault::Callback,generation_failure::Fault::Start,generation_failure::Fault::Display})generationCase(fault,file);
    puts("Actual presenter source: FG queue/create/nil/callback/start/display failures bypass generation without null CoreVideo calls; four unchanged submissions keep caller-buffer rendering and make no resource retry; actual Off/On packets recover the same owner. CoreVideo/LSFG/Metal NSObject stand-ins only, no GPU or display.");
}}
#else
int main(){@autoreleasepool{
    setenv("RESHADE_EXPLICIT_HOST","1",1);unsetenv("RESHADE_EFFECT");unsetenv("RESHADE_EFFECT_PLAN");unsetenv("RESHADE_CONTROL_FILE");unsetenv("RESHADE_LIVE_EFFECTS");unsetenv("RESHADE_PRESENTATION_CONTROL_FILE");
    device=[FailureDevice new];auto layer=[FailureLayer layer];layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,24);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:layer.pixelFormat width:32 height:24 mipmapped:NO];auto source=(id<MTLTexture>)[device newTextureWithDescriptor:descriptor];
    rejectPrivateQueue=true;
    int owner=0;macfx::FramePresenter presenter(layer,&owner);assert(queues==0);auto commands=[FailureCommands new];
    auto result=presenter.submit((id<MTLCommandBuffer>)commands,source,1,CACurrentMediaTime());if(!result.encoded)fprintf(stderr,"Baseline rejected: busy=%d reason=%s\n",result.busy,result.reason.c_str());assert(result.encoded&&copies>0&&commands.handlers.count>0);
    assert(queues==0); // Baseline uses only the caller's already working queue.
    [commands fire:MTLCommandBufferStatusError];assert(presenter.terminalGpuFailure()&&!presenter.snapshot().reason.empty());
    const auto beforeImages=images.load(),beforeQueues=queues.load(),beforeCopies=copies.load();
    for(unsigned i=0;i<16;++i){auto rejected=presenter.submit(nil,source,2+i,CACurrentMediaTime());assert(!rejected.encoded&&!rejected.busy&&!rejected.reason.empty());}
    assert(images==beforeImages&&queues==beforeQueues&&copies==beforeCopies);
    assert(presenter.gpuFailureMatchesCurrent(32,24,layer.pixelFormat,(id<MTLDevice>)device));
    assert(!presenter.gpuFailureMatchesCurrent(64,48,layer.pixelFormat,(id<MTLDevice>)device));
    assert(!presenter.gpuFailureMatchesCurrent(32,24,MTLPixelFormatRGBA8Unorm,(id<MTLDevice>)device));
    presenter.stop();assert(presenter.snapshot().stopped&&presenter.snapshot().presentedReal==0);
    // A fresh accepted publication creates one new owner; a failed owner is
    // never silently retried by submit. Automatic Off removes its publisher entry.
    auto fresh=[FailureLayer layer];fresh.pixelFormat=MTLPixelFormatBGRA8Unorm;fresh.drawableSize=CGSizeMake(32,24);int next=0;macfx::FramePresenter replacement(fresh,&next);assert(queues==beforeQueues&&!replacement.terminalGpuFailure());
    replacement.retainCompletedFrameForReplay(true);auto baseline=[FailureCommands new];assert(replacement.submit((id<MTLCommandBuffer>)baseline,source,1,CACurrentMediaTime()).encoded);assert(queues==beforeQueues);
    // Controlled completion invokes the real retention callback. It does not
    // establish physical GPU completion or a positive displayed timestamp.
    [baseline fire:MTLCommandBufferStatusCompleted];assert(replacement.completedFrameReplayReady());
    assert(!replacement.replayCompletedFrame());assert(queues==beforeQueues+1);
    assert(!replacement.replayCompletedFrame());assert(queues==beforeQueues+1); // Same unavailable private contract is not retried.
    auto afterUnavailable=[FailureCommands new];assert(replacement.submit((id<MTLCommandBuffer>)afterUnavailable,source,2,CACurrentMediaTime()).encoded);assert(queues==beforeQueues+1&&!replacement.terminalGpuFailure());
    [afterUnavailable fire:MTLCommandBufferStatusCompleted];
    replacement.stop();
    rejectPrivateQueue=false;int finalOwner=0;macfx::FramePresenter available(fresh,&finalOwner);assert(queues==beforeQueues+1);
    available.retainCompletedFrameForReplay(true);auto completed=[FailureCommands new];assert(available.submit((id<MTLCommandBuffer>)completed,source,1,CACurrentMediaTime()).encoded);assert(queues==beforeQueues+1);
    [completed fire:MTLCommandBufferStatusCompleted];assert(available.completedFrameReplayReady());assert(available.replayCompletedFrame());assert(queues==beforeQueues+2);available.stop();
    puts("Actual FramePresenter callbacks: baseline caller-buffer output uses zero private queues, private replay allocates only on demand, unavailable private replay is latched without blocking baseline, terminal GPU error suppresses repeated work. NSObject stand-ins and controlled completion callbacks only; no GPU or display ACK.");
}}
#endif
