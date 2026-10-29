// Copyright (c) MacLauncher contributors. MIT license.
// Live edits of a 4K ordered graph through the production executor seam.
//   --history  An upstream control edit keeps a history-owning row (real
//              histogram exposure) with its adaptation and without a new
//              charge; a changed input contract starts its history anew.
//   --release  When the accepted chain and its replacement cannot both be
//              admitted, the replacement is built after the accepted chain's
//              unreused resources are released. Callers hold their last
//              completed output for a bounded time while it reports Preparing,
//              a genuine row error stays with its row, and a replacement that
//              still cannot fit continues as a partial chain until it can.
// Controlled fx rows multiply the color by their Gain control; "heavy" rows
// also hold private 4K images charged to the image-memory ledger.
#include "effects-execution.hpp"
#include "fixture-files.hpp"
#include "image-admission.hpp"
#include "process-phase.hpp"
#include "runtime-status.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <mutex>
#include <optional>
#include <sys/mman.h>
#include <thread>
#include <unistd.h>
#include <vector>
namespace {
using Clock=std::chrono::steady_clock;
constexpr unsigned width=3840,height=2160;
std::mutex createsLock;std::map<std::string,unsigned> creates;
std::atomic<int> heavyAlive{0};
unsigned created(const std::string &file){std::lock_guard guard(createsLock);return creates[file];}
unsigned heavyImages(const std::string &file){return file=="/proof/heavy-huge"?6:file.rfind("/proof/heavy",0)==0?2:0;}
struct Scale final:macfx::ShaderNode {
    std::string file;float gain=1;id<MTLComputePipelineState> kernel;std::vector<id<MTLTexture>> held;const unsigned heavy;
    explicit Scale(std::string value):file(std::move(value)),heavy(heavyImages(file)){if(heavy)++heavyAlive;}
    ~Scale()override{if(heavy)--heavyAlive;}
    void setParameters(const macfx::ShaderParameters &value)override{
        const auto reject=value.find("Reject");if(reject!=value.end()&&reject->second[0]<0)throw std::runtime_error("Shader parameter unavailable");
        const auto found=value.find("Gain");gain=found==value.end()?1:found->second[0];
    }
    macfx::ShaderResult prepare(const macfx::ShaderFrame &frame)override{@autoreleasepool{
        if(!kernel){NSError *error=nil;auto library=[frame.commands.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void scale(texture2d<float,access::read> a [[texture(0)]],texture2d<float,access::write> b [[texture(1)]],constant float &gain [[buffer(0)]],uint2 q [[thread_position_in_grid]]){if(q.x>=b.get_width()||q.y>=b.get_height())return;float4 v=a.read(q);b.write(float4(min(v.rgb*gain,float3(1)),v.a),q);}" options:nil error:&error];
            assert(library);kernel=[frame.commands.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"scale"] error:&error];assert(kernel);}
        if(heavy&&held.empty()){
            auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA32Float width:width height:height mipmapped:NO];
            descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
            // A denial throws the ledger's typed busy result to the executor.
            std::vector<id<MTLTexture>> images;for(unsigned i=0;i<heavy;++i)images.push_back(macfx::newAdmittedTexture(frame.commands.device,descriptor));held=std::move(images);
        }
        return {true,{}};
    }}
    macfx::ShaderResult encode(const macfx::ShaderFrame &frame)override{
        auto encoder=[frame.commands computeCommandEncoder];[encoder setComputePipelineState:kernel];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.target atIndex:1];
        [encoder setBytes:&gain length:sizeof(gain) atIndex:0];[encoder dispatchThreads:MTLSizeMake(frame.target.width,frame.target.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        return {true,{}};
    }
};
NSString *hex(NSString *c){return [@"" stringByPaddingToLength:64 withString:c startingAtIndex:0];}
NSDictionary *scale(NSString *name,NSString *file,float gain,NSDictionary *extra=nil){
    NSMutableDictionary *row=[@{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":file,@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":@{@"Gain":@[@(gain)]},@"preservesCoordinates":@YES} mutableCopy];
    if(extra)[row addEntriesFromDictionary:extra];return row;
}
void publishNodes(NSString *path,NSString *revision,NSArray *nodes){
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":nodes} options:0 error:nil];assert(replaceFile(bytes,path));
    std::this_thread::sleep_for(std::chrono::milliseconds(110));
}
id<MTLTexture> texture(id<MTLDevice> device){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto value=[device newTextureWithDescriptor:descriptor];assert(value);return value;
}
void fill(id<MTLTexture> image,unsigned char gray){
    std::vector<unsigned char> pixels(size_t(width)*height*4);for(size_t i=0;i<pixels.size();i+=4){pixels[i]=pixels[i+1]=pixels[i+2]=gray;pixels[i+3]=255;}
    [image replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:width*4];
}
// The center 8x8 block; every pixel is gray and equal.
unsigned center(id<MTLTexture> image){
    std::array<unsigned char,8*8*4> pixels{};[image getBytes:pixels.data() bytesPerRow:8*4 fromRegion:MTLRegionMake2D(width/2-4,height/2-4,8,8) mipmapLevel:0];
    for(size_t i=0;i<pixels.size();i+=4)assert(pixels[i]==pixels[0]&&pixels[i+1]==pixels[0]&&pixels[i+2]==pixels[0]&&pixels[i+3]==255);
    return pixels[0];
}
bool near(unsigned value,unsigned expected,unsigned tolerance){return value+tolerance>=expected&&value<=expected+tolerance;}
// The launcher's status page and lease for this process.
struct StatusPage {
    char *page=nullptr;
    explicit StatusPage(NSString *directory){
        using namespace macfx::runtime_status;
        NSString *file=[directory stringByAppendingPathComponent:@"status.bin"];
        const int fd=open(file.fileSystemRepresentation,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);assert(fd>=0&&ftruncate(fd,pageSize)==0);
        page=static_cast<char*>(mmap(nullptr,pageSize,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0));close(fd);assert(page!=MAP_FAILED);
        auto *header=reinterpret_cast<Header*>(page);std::memcpy(header->magic,"MLFXSTS1",8);header->version=schema;header->bytes=pageSize;
        std::memset(header->token,'a',64);std::memcpy(header->launchId,"gtr",3);header->launchIdLength=3;
        const std::string token(64,'a');setenv("RESHADE_RUNTIME_STATUS_FILE",file.fileSystemRepresentation,1);
        setenv("RESHADE_RUNTIME_STATUS_TOKEN",token.c_str(),1);setenv("RESHADE_RUNTIME_STATUS_LAUNCH_ID","gtr",1);
        // An open attempt is throttled to one per second.
        for(unsigned i=0;i<1500&&!macfx::runtimeStatusLeased();++i){lease();usleep(1000);}assert(macfx::runtimeStatusLeased());
    }
    ~StatusPage(){munmap(page,macfx::runtime_status::pageSize);}
    void lease(){
        const auto now=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
        __atomic_store_n(&reinterpret_cast<macfx::runtime_status::Header*>(page)->leaseUntil,now+8000,__ATOMIC_RELEASE);macfx::pollRuntimeStatus(true);
    }
    // Any status context of this process for the revision in this phase.
    bool phase(NSString *revision,macfx::RuntimeStatusPhase value)const{
        using namespace macfx::runtime_status;const std::string expected=hex(revision).UTF8String;
        for(unsigned i=0;i<slotCount;++i){const auto *row=reinterpret_cast<const Context*>(page+headerSize+i*slotSize);
            if(row->pid==uint32_t(getpid())&&row->phase==uint32_t(value)&&expected==row->planRevision)return true;}
        return false;
    }
    const macfx::runtime_status::Stage *stage(uintptr_t context,NSString *revision,const char *id)const{
        using namespace macfx::runtime_status;const std::string expected=hex(revision).UTF8String;
        for(unsigned i=0;i<slotCount;++i){const auto *row=reinterpret_cast<const Context*>(page+headerSize+i*slotSize);
            if(row->pid!=uint32_t(getpid())||row->id!=context||expected!=row->planRevision)continue;
            for(unsigned n=0;n<std::min(row->stages,stageCount);++n)if(!std::strcmp(row->rows[n].id,id))return &row->rows[n];}
        return nullptr;
    }
};
struct Chain {
    id<MTLDevice> device;id<MTLCommandQueue> queue;id<MTLTexture> input,output;macfx::EffectPlanExecutor executor;uint64_t frameId=0;
    macfx::ShaderFrame frame(uint64_t id=0){macfx::ShaderFrame value{[queue commandBuffer],input,output};assert(value.commands);value.frameId=id?:++frameId;value.timeMs=value.frameId*16.666;value.frameTimeMs=16.666f;value.origin=macfx::FrameOrigin::TopLeft;return value;}
    // One observation per call on a fresh buffer that is never submitted.
    template<class Done> macfx::EffectExecutionSelection until(const Done &done,double seconds,const char *what){
        const auto deadline=Clock::now()+std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(seconds));const auto observation=++frameId;
        for(;;){@autoreleasepool{
            auto value=frame(observation);auto selected=executor.prepare(value);assert(value.commands.status<MTLCommandBufferStatusCommitted);
            if(done(selected))return selected;
            if(Clock::now()>=deadline){std::fprintf(stderr,"%s: preparing=%d hold=%d error=%s\n",what,int(selected.preparing),int(selected.holdPrevious),selected.error.c_str());std::_Exit(1);}
        }std::this_thread::sleep_for(std::chrono::milliseconds(2));}
    }
    unsigned run(const std::shared_ptr<macfx::EffectExecution> &execution,std::string *reason=nullptr){@autoreleasepool{
        auto value=frame();const auto result=execution->encode(value);if(!result.encoded)std::fprintf(stderr,"frame: %s\n",result.reason.c_str());assert(result.encoded&&!result.busy);
        if(reason)*reason=result.reason;[value.commands commit];[value.commands waitUntilCompleted];assert(value.commands.status==MTLCommandBufferStatusCompleted);
    }return center(output);}
};
bool revision(const macfx::EffectExecutionSelection &selected,NSString *value){return selected.execution&&selected.execution->revision()==std::string(hex(value).UTF8String);}

int history(NSString *directory,NSString *path,Chain &chain){
    fill(chain.input,64);
    // Real histogram exposure with slow adaptation and no image-derived cut.
    NSString *filter=[directory stringByAppendingPathComponent:@"exposure.mclfilter"];
    NSDictionary *descriptor=@{@"schema":@1,@"method":@"histogram-exposure",@"parameters":@{@"AdaptationSpeed":@0.5,@"CutThreshold":@0}};
    assert([[NSJSONSerialization dataWithJSONObject:descriptor options:0 error:nil] writeToFile:filter atomically:NO]);
    NSDictionary *exposure=@{@"id":@"exposure",@"kind":@"shader",@"enabled":@YES,@"format":@"native",@"file":filter,@"key":hex(@"c"),@"revision":hex(@"d"),@"parameters":@{},@"preservesCoordinates":@YES};
    const auto nodes=[&](NSString *lift,float gain){return @[scale(@"lift",lift,gain),exposure,scale(@"after",@"/proof/after",1)];};
    publishNodes(path,@"1",nodes(@"/proof/lift",1));
    auto first=chain.until([](const auto &s){return !s.preparing;},8,"first chain");assert(first.error.empty()&&revision(first,@"1"));
    unsigned adapted=0;for(unsigned i=0;i<30;++i)adapted=chain.run(first.execution);
    // Key gray 0.18 in linear light, within the histogram's 1/8 EV bins.
    assert(near(adapted,118,6)&&created("/proof/lift")==1&&created("/proof/after")==1);
    const uint64_t before=chain.device.currentAllocatedSize;
    // An upstream control edit. The accepted execution stays alive across the
    // replacement, as it does while its last frames are in flight.
    publishNodes(path,@"2",nodes(@"/proof/lift",1.5f));
    auto edited=chain.until([&](const auto &s){return !s.preparing&&s.execution!=first.execution;},8,"upstream edit");
    assert(edited.error.empty()&&revision(edited,@"2"));
    const uint64_t during=chain.device.currentAllocatedSize;const int64_t charge=int64_t(during)-int64_t(before);
    first={};
    const unsigned continued=chain.run(edited.execution);
    std::printf("history: adapted=%u after-upstream-edit=%u transition-charge=%lld bytes later-row-instances=%u\n",adapted,continued,(long long)charge,created("/proof/after"));std::fflush(stdout);
    // The edited row is new; the history-owning row and the later row are the
    // accepted instances.
    assert(created("/proof/lift")==2&&created("/proof/after")==1);
    // Adaptation continues: the brighter input (1.5x encoded, 2.28x linear)
    // keeps the adapted exposure, about 172 here, instead of returning to the
    // key gray at 118.
    assert(continued>=150);
    // No 4K exposure image or other per-row resource is charged again; one
    // BGRA8 4K image alone is 33 MB.
    assert(charge<int64_t(16)<<20);
    unsigned later=continued;for(unsigned i=0;i<4;++i){const auto value=chain.run(edited.execution);assert(value<=later&&value+3>=later);later=value;}
    // A different upstream shader changes the input contract: history starts anew.
    publishNodes(path,@"3",nodes(@"/proof/lift-other",1.5f));
    auto contract=chain.until([&](const auto &s){return !s.preparing&&s.execution!=edited.execution;},8,"contract change");
    assert(contract.error.empty()&&revision(contract,@"3"));edited={};
    const unsigned restarted=chain.run(contract.execution);
    assert(near(restarted,118,6)&&created("/proof/after")==2);
    std::printf("history: changed contract restarted at %u; upstream edits keep the history-owning and later rows, a changed contract recreates them\n",restarted);
    return 0;
}

int release(NSString *directory,Chain &chain){
    StatusPage status(directory);NSString *path=[NSString stringWithUTF8String:std::getenv("RESHADE_EFFECT_PLAN")];
    const auto context=reinterpret_cast<uintptr_t>(&chain.executor);chain.executor.setStatusContext(context);
    fill(chain.input,64);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA32Float width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;
    const uint64_t image=[chain.device heapTextureSizeAndAlignWithDescriptor:descriptor].size,heavy=2*image;
    publishNodes(path,@"1",@[scale(@"heavy",@"/proof/heavy",1),scale(@"after",@"/proof/after",1)]);
    auto first=chain.until([](const auto &s){return !s.preparing;},8,"first chain");assert(first.error.empty()&&revision(first,@"1"));
    assert(chain.run(first.execution)==64&&heavyAlive==1);first={};
    // Ledger pressure leaves half of one heavy row plus 64 MB. The accepted
    // heavy row and its replacement cannot both be admitted; after the
    // accepted row is released, the replacement fits.
    const uint64_t working=chain.device.recommendedMaxWorkingSetSize,limit=working-working/16,used=chain.device.currentAllocatedSize,remaining=heavy/2+(64ull<<20);
    assert(limit>used+remaining+heavy);auto pressure=macfx::reserveImageBytes(chain.device,limit-used-remaining);
    std::printf("release: workingSet=%llu limit=%llu allocated=%llu remaining=%llu heavyRow=%llu\n",(unsigned long long)working,(unsigned long long)limit,(unsigned long long)used,(unsigned long long)remaining,(unsigned long long)heavy);std::fflush(stdout);
    // Observes one transition. While the replacement is built, callers hold:
    // the output keeps the last completed pixels and nothing is encoded.
    struct Transition {double hold=0;bool held=false,preparing=false;macfx::EffectExecutionSelection selected;};
    const auto transition=[&](NSString *revisionName,double seconds,const char *what){
        Transition result;const unsigned last=center(chain.output);std::optional<Clock::time_point> start;
        result.selected=chain.until([&](const auto &s){
            status.lease();assert(!status.phase(revisionName,macfx::RuntimeStatusPhase::Failed));
            if(s.holdPrevious){if(!start)start=Clock::now();result.held=true;result.preparing|=status.phase(revisionName,macfx::RuntimeStatusPhase::Preparing);assert(center(chain.output)==last);return false;}
            return !s.preparing&&revision(s,revisionName);},seconds,what);
        if(start)result.hold=std::chrono::duration<double>(Clock::now()-*start).count();return result;
    };
    publishNodes(path,@"2",@[scale(@"heavy",@"/proof/heavy",1.5f),scale(@"after",@"/proof/after",1)]);
    auto applied=transition(@"2",8,"release before build");
    assert(applied.held&&applied.preparing&&applied.hold<1.5&&applied.selected.error.empty());
    // The replacement holds the only heavy row: one candidate was denied by
    // image admission, which released the accepted chain, and the next one
    // was built. The later row is the accepted instance.
    if(!(heavyAlive==1&&created("/proof/heavy")==3&&created("/proof/after")==1))std::fprintf(stderr,"release: heavyAlive=%d heavy=%u after=%u\n",heavyAlive.load(),created("/proof/heavy"),created("/proof/after"));
    assert(heavyAlive==1&&created("/proof/heavy")==3&&created("/proof/after")==1);
    assert(chain.run(applied.selected.execution)==96);
    std::printf("release: no-fit edit applied after a %.3f s hold showing Preparing\n",applied.hold);std::fflush(stdout);
    // A genuine error of another row stays with that row; the rest applies.
    NSMutableDictionary *bad=[scale(@"bad",@"/proof/bad",1)mutableCopy];bad[@"parameters"]=@{@"Reject":@[@(-1)]};applied.selected={};
    publishNodes(path,@"3",@[scale(@"heavy",@"/proof/heavy",2),bad,scale(@"after",@"/proof/after",1)]);
    auto isolated=transition(@"3",8,"row failure after release");
    assert(isolated.held&&isolated.hold<1.5&&heavyAlive==1);
    std::string reason;assert(chain.run(isolated.selected.execution,&reason)==128&&reason=="Shader parameter unavailable");
    const auto failed=status.stage(context,@"3","bad");assert(failed&&failed->phase==uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&reason==failed->reason);
    isolated.selected={};
    // A replacement that cannot fit even after the release: the hold ends at
    // its bound and the chain continues with that row pending, then completes
    // when memory becomes available, without another edit.
    publishNodes(path,@"4",@[scale(@"heavy",@"/proof/heavy-huge",.5f),scale(@"after",@"/proof/after",1)]);
    auto bounded=transition(@"4",8,"bounded hold");
    assert(bounded.held&&bounded.hold<2.0);
    assert(chain.run(bounded.selected.execution)==64);const auto pending=status.stage(context,@"4","heavy");
    assert(pending&&pending->phase==uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&*pending->reason);
    assert(!status.phase(@"4",macfx::RuntimeStatusPhase::Failed));
    pressure.reset();const auto partial=bounded.selected.execution;bounded.selected={};
    auto recovered=chain.until([&](const auto &s){status.lease();assert(!status.phase(@"4",macfx::RuntimeStatusPhase::Failed));return !s.preparing&&revision(s,@"4")&&s.execution!=partial;},8,"recovery after pressure");
    assert(chain.run(recovered.execution)==32&&heavyAlive==1);
    // The recovered row reports as applied, without its earlier pending reason.
    const auto recoveredRow=status.stage(context,@"4","heavy");
    if(!(recoveredRow&&recoveredRow->phase!=uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&!*recoveredRow->reason))std::fprintf(stderr,"release: recovered heavy stage phase=%u reason=%s\n",recoveredRow?recoveredRow->phase:0,recoveredRow?recoveredRow->reason:"(none)");
    assert(recoveredRow&&recoveredRow->phase!=uint32_t(macfx::RuntimeStatusPhase::Bypassed)&&!*recoveredRow->reason);
    std::printf("release: genuine row error isolated after a %.3f s hold; unfit replacement continued after a %.3f s bounded hold and completed when memory was available\n",isolated.hold,bounded.hold);
    return 0;
}
}
namespace macfx {std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &spec){{std::lock_guard guard(createsLock);++creates[spec.selection.file];}return std::make_shared<Scale>(spec.selection.file);}}
int main(int argc,char **argv){@autoreleasepool{
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        assert(argc==2&&(!std::strcmp(argv[1],"--history")||!std::strcmp(argv[1],"--release")));
        char temporary[1024];temporaryPath(temporary,"maclauncher-graph-transitions-XXXXXX");assert(mkdtemp(temporary));NSString *directory=[NSString stringWithUTF8String:temporary];
        NSString *log=[directory stringByAppendingPathComponent:@"native.log"];
        const int status=fixture::runPhase("checks",{{"RESHADE_LOG",log.fileSystemRepresentation},{"RESHADE_DIAGNOSTICS","1"},
            {"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation}},{temporary,argv[1]});
        if(status)std::fprintf(stderr,"native log: %s\n",log.fileSystemRepresentation);else [[NSFileManager defaultManager]removeItemAtPath:directory error:nil];
        return status;
    }
    assert(phase.argc==3);NSString *directory=[NSString stringWithUTF8String:phase.argv[1]];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,60*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{std::fputs("Graph transition check timed out\n",stderr);std::_Exit(2);});
    Chain chain;chain.device=MTLCreateSystemDefaultDevice();chain.queue=[chain.device newCommandQueue];assert(chain.device&&chain.queue);
    chain.input=texture(chain.device);chain.output=texture(chain.device);
    if(!std::strcmp(phase.argv[2],"--history"))return history(directory,[directory stringByAppendingPathComponent:@"plan.json"],chain);
    return release(directory,chain);
}}
