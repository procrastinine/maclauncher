// Actual adapter ownership with controlled C API exports and command buffers.
// No Metal device, queue, texture, capture, application or GPU work is created.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#define LIBRA_RUNTIME_METAL
#include <librashader.h>
#include <dlfcn.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace {
unsigned opens=0,created=0,createAttempts=0,frames=0;
bool failCreate=false,failFrame=false;
std::set<unsigned>freed;
std::vector<unsigned>encoded;
void *historyOpen(const char *,int);
void *historySymbol(void *,const char *);
const char *historyError(){return "Controlled shader provider error";}
// The adapter creates and frees generations on its own serial resource queue.
dispatch_queue_t resources=nil;
dispatch_queue_t historyQueue(const char *label,dispatch_queue_attr_t attributes){auto queue=dispatch_queue_create(label,attributes);if(label&&!strcmp(label,"org.maclauncher.slang.resources"))resources=queue;return queue;}
void settle(){if(resources)dispatch_sync(resources,^{});}
}
#define dispatch_queue_create historyQueue
#define dlopen historyOpen
#define dlsym historySymbol
#define dlerror historyError
#ifndef MACFX_RETROARCH_SOURCE
#define MACFX_RETROARCH_SOURCE <retroarch.hpp>
#endif
#include MACFX_RETROARCH_SOURCE
#undef dispatch_queue_create
#undef dlopen
#undef dlsym
#undef dlerror

@interface HistoryCommandBuffer:NSObject
@property(nonatomic)MTLCommandBufferStatus status;
@property(nonatomic,strong)id<MTLCommandQueue>commandQueue;
@property(nonatomic)BOOL retainedReferences;
@property(nonatomic,strong)NSMutableArray *callbacks;
@end
@implementation HistoryCommandBuffer
- (instancetype)init{if((self=[super init])){_retainedReferences=YES;_callbacks=[NSMutableArray new];}return self;}
- (void)addCompletedHandler:(MTLCommandBufferHandler)handler{[_callbacks addObject:[handler copy]];}
- (void)finish:(MTLCommandBufferStatus)status{
    self.status=status;NSArray *callbacks=[_callbacks copy];[_callbacks removeAllObjects];
    for(MTLCommandBufferHandler handler in callbacks)handler((id<MTLCommandBuffer>)self);
}
@end

struct _shader_preset {};
struct _libra_error {};
struct _filter_chain_mtl {unsigned generation;id<MTLCommandQueue>queue;float gain=.25f;};
namespace {
_libra_error controlledError;
LIBRASHADER_ABI_VERSION instanceABI(){return LIBRASHADER_CURRENT_ABI;}
LIBRASHADER_API_VERSION instanceAPI(){return LIBRASHADER_CURRENT_VERSION;}
libra_error_t presetCreate(const char *file,libra_shader_preset_t *out){assert(!strcmp(file,"/proof/history.slangp"));*out=new _shader_preset;return nullptr;}
libra_error_t presetFree(libra_shader_preset_t *preset){delete *preset;*preset=nullptr;return nullptr;}
libra_error_t parameters(const libra_shader_preset_t *,libra_preset_param_list_t *out){
    static const libra_preset_param_t gain{"Gain","Controlled parameter",.25f,0,1,.01f};*out={&gain,1};return nullptr;
}
libra_error_t parametersFree(libra_preset_param_list_t){return nullptr;}
libra_error_t chainCreate(libra_shader_preset_t *preset,id<MTLCommandQueue>queue,const filter_chain_mtl_opt_t *options,libra_mtl_filter_chain_t *out){
    assert(queue&&options&&options->version==LIBRASHADER_CURRENT_VERSION);++createAttempts;delete *preset;*preset=nullptr;
    if(failCreate)return &controlledError;
    *out=new _filter_chain_mtl{++created,queue};return nullptr;
}
libra_error_t chainFree(libra_mtl_filter_chain_t *chain){assert(*chain&&freed.insert((*chain)->generation).second);delete *chain;*chain=nullptr;return nullptr;}
libra_error_t chainGet(const libra_mtl_filter_chain_t *chain,const char *name,float *out){assert(*chain&&!strcmp(name,"Gain"));*out=(*chain)->gain;return nullptr;}
libra_error_t chainSet(libra_mtl_filter_chain_t *chain,const char *name,float value){assert(*chain&&!strcmp(name,"Gain"));(*chain)->gain=value;return nullptr;}
libra_error_t chainFrame(libra_mtl_filter_chain_t *chain,id<MTLCommandBuffer>commands,size_t,id<MTLTexture>input,id<MTLTexture>output,const libra_viewport_t *,const float *,const frame_mtl_opt_t *options){
    assert(*chain&&commands&&input&&output&&options&&(*chain)->queue==commands.commandQueue&&!freed.count((*chain)->generation));
    assert((*chain)->gain==.75f);encoded.push_back((*chain)->generation);++frames;return failFrame?&controlledError:nullptr;
}
int32_t errorWrite(libra_error_t error,char **out){assert(error==&controlledError);*out=strdup("Controlled chain creation failure");return 0;}
int32_t errorFree(libra_error_t *error){assert(*error==&controlledError);*error=nullptr;return 0;}
int32_t errorStringFree(char **text){free(*text);*text=nullptr;return 0;}
void *historyOpen(const char *file,int){assert(!strcmp(file,"/proof/cpu-only-librashader.dylib"));++opens;return reinterpret_cast<void*>(1);}
void *historySymbol(void *handle,const char *name){assert(handle==reinterpret_cast<void*>(1));
#define SYMBOL(api,implementation) if(!strcmp(name,api))return reinterpret_cast<void*>(&implementation)
    SYMBOL("libra_instance_abi_version",instanceABI);SYMBOL("libra_instance_api_version",instanceAPI);
    SYMBOL("libra_error_write",errorWrite);SYMBOL("libra_error_free",errorFree);SYMBOL("libra_error_free_string",errorStringFree);
    SYMBOL("libra_preset_create",presetCreate);SYMBOL("libra_preset_free",presetFree);SYMBOL("libra_preset_get_runtime_params",parameters);SYMBOL("libra_preset_free_runtime_params",parametersFree);
    SYMBOL("libra_mtl_filter_chain_create",chainCreate);SYMBOL("libra_mtl_filter_chain_frame",chainFrame);SYMBOL("libra_mtl_filter_chain_free",chainFree);SYMBOL("libra_mtl_filter_chain_get_param",chainGet);SYMBOL("libra_mtl_filter_chain_set_param",chainSet);
#undef SYMBOL
    // Optional external-input and uniform-snapshot extensions are absent, as
    // in a provider without them; the adapter keeps its ordinary chain path.
    for(const char *optional:{"libra_mtl_external_inputs_api","libra_mtl_filter_chain_create_external","libra_mtl_filter_chain_set_external","libra_mtl_filter_chain_uniform_snapshots","libra_mtl_filter_chain_uniform_snapshot_bytes","libra_mtl_filter_chain_prepare_uniform_snapshots","libra_mtl_filter_chain_uniform_snapshots_available"})if(!strcmp(name,optional))return nullptr;
    assert(false&&"Unexpected provider API");return nullptr;
}
HistoryCommandBuffer *buffer(id<MTLCommandQueue>queue){auto value=[HistoryCommandBuffer new];value.commandQueue=queue;return value;}
std::unique_ptr<macfx::RetroarchChain>chain(id<MTLCommandQueue>queue){return std::make_unique<macfx::RetroarchChain>("/proof/history.slangp",std::string(64,'a'),queue);}
unsigned encode(macfx::RetroarchChain &owner,HistoryCommandBuffer *commands){
    static const std::map<std::string,std::vector<float>>settings{{"Gain",{.75f}}};
    // The adapter treats image handles as opaque; the fake C API never reads
    // image properties or fabricates a graphics-processing success receipt.
    // A replacement generation is prepared off the frame path: the first
    // attempt reports busy, and the next attempt adopts the prepared chain.
    auto image=[NSObject new];const auto attempt=[&]{owner.encode((id<MTLCommandBuffer>)commands,(id<MTLTexture>)image,(id<MTLTexture>)image,frames+1,16.666667f,&settings,7);};
    try{attempt();}catch(const macfx::RetroarchBusy &error){if(std::strncmp(error.what(),"Preparing",9))throw;settle();attempt();}
    settle();assert(!encoded.empty());return encoded.back();
}
void complete(HistoryCommandBuffer *commands,MTLCommandBufferStatus status=MTLCommandBufferStatusCompleted){@autoreleasepool{[commands finish:status];}settle();}
void committedReuse(id<MTLCommandQueue>queue){
    const unsigned before=created;auto owner=chain(queue);auto a=buffer(queue);const auto generation=encode(*owner,a);
    const unsigned beforeFrames=frames;
    const auto busy=[&](HistoryCommandBuffer *commands){bool caught=false;try{encode(*owner,commands);}catch(const std::exception&){caught=true;}assert(caught&&frames==beforeFrames&&created==before+1);};
    busy(a); // Shared uniforms must not be rewritten even in the same buffer.
    a.status=MTLCommandBufferStatusCommitted;auto b=buffer(queue);busy(b);
    complete(a);assert(encode(*owner,b)==generation&&created==before+1);complete(b);
    for(unsigned i=0;i<3;++i){auto next=buffer(queue);assert(encode(*owner,next)==generation&&created==before+1);complete(next);}
    owner.reset();settle();assert(freed.count(generation));
}
void uncommittedAndLate(id<MTLCommandQueue>queue){
    const unsigned before=created;auto owner=chain(queue);auto old=buffer(queue);const auto previous=encode(*owner,old);
    auto current=buffer(queue);const auto replacement=encode(*owner,current);
    assert(replacement!=previous&&created==before+2);assert(!freed.count(previous));
    complete(current);old.status=MTLCommandBufferStatusCommitted;complete(old);assert(freed.count(previous)&&!freed.count(replacement));
    owner.reset();settle();assert(freed.count(replacement));
}
void abandoned(id<MTLCommandQueue>queue){
    const unsigned before=created;auto owner=chain(queue);unsigned previous=0;
    @autoreleasepool{auto old=buffer(queue);previous=encode(*owner,old);old=nil;}
    auto current=buffer(queue);const auto replacement=encode(*owner,current);assert(replacement!=previous&&created==before+2&&freed.count(previous));
    complete(current);owner.reset();settle();assert(freed.count(replacement));
}
void failed(id<MTLCommandQueue>queue){
    auto owner=chain(queue);auto old=buffer(queue);const auto previous=encode(*owner,old);complete(old,MTLCommandBufferStatusError);
    auto current=buffer(queue);const auto replacement=encode(*owner,current);assert(replacement!=previous&&freed.count(previous));
    complete(current);owner.reset();settle();assert(freed.count(replacement));
}
void changedQueue(id<MTLCommandQueue>first,id<MTLCommandQueue>second){
    auto owner=chain(first);auto old=buffer(first);const auto previous=encode(*owner,old);old.status=MTLCommandBufferStatusCommitted;
    auto current=buffer(second);const auto replacement=encode(*owner,current);assert(replacement!=previous&&!freed.count(previous));
    complete(old);assert(freed.count(previous));complete(current);
    auto next=buffer(second);assert(encode(*owner,next)==replacement);complete(next);owner.reset();settle();assert(freed.count(replacement));
}
void lateSuccessDoesNotBlessPending(id<MTLCommandQueue>queue){
    const unsigned before=created;auto owner=chain(queue);auto a=buffer(queue);const auto previous=encode(*owner,a);
    auto b=buffer(queue);const auto pending=encode(*owner,b);assert(pending!=previous);
    complete(a);assert(freed.count(previous)); // Success belongs to A; B still has only encoded history.
    auto current=buffer(queue);const auto replacement=encode(*owner,current);
    assert(replacement!=pending&&created==before+3&&!freed.count(pending));
    complete(b);assert(freed.count(pending));complete(current);owner.reset();settle();assert(freed.count(replacement));
}
void lateErrorDoesNotPoisonReplacement(id<MTLCommandQueue>queue){
    const unsigned before=created;auto owner=chain(queue);auto old=buffer(queue);const auto previous=encode(*owner,old);
    auto current=buffer(queue);const auto replacement=encode(*owner,current);assert(replacement!=previous);
    current.status=MTLCommandBufferStatusCommitted;complete(old,MTLCommandBufferStatusError);assert(freed.count(previous));
    complete(current);auto next=buffer(queue);assert(encode(*owner,next)==replacement&&created==before+2);
    complete(next);owner.reset();settle();assert(freed.count(replacement));
}
void rejectedFrame(id<MTLCommandQueue>queue){
    const unsigned before=created;auto owner=chain(queue);auto old=buffer(queue);bool caught=false;
    failFrame=true;try{encode(*owner,old);}catch(const std::runtime_error&){caught=true;}failFrame=false;
    assert(caught&&created==before+1);const auto previous=encoded.back();
    old.status=MTLCommandBufferStatusCommitted;auto current=buffer(queue);const auto replacement=encode(*owner,current);
    assert(replacement!=previous&&created==before+2&&!freed.count(previous));
    complete(old);assert(freed.count(previous));complete(current);owner.reset();settle();assert(freed.count(replacement));
}
void rejectedCreation(id<MTLCommandQueue>queue){
    auto owner=chain(queue);auto old=buffer(queue);const auto previous=encode(*owner,old);const unsigned beforeFrames=frames,attempts=createAttempts;
    failCreate=true;auto rejected=buffer(queue);bool caught=false;try{encode(*owner,rejected);}catch(const std::runtime_error&){caught=true;}
    assert(caught&&frames==beforeFrames&&createAttempts==attempts+1&&!freed.count(previous));failCreate=false;
    // A failed preparation is reported once; the next frame on the same queue
    // prepares again and the retired generation still waits for its buffer.
    auto current=buffer(queue);const auto replacement=encode(*owner,current);assert(replacement!=previous&&!freed.count(previous));
    complete(old);assert(freed.count(previous));complete(current);owner.reset();settle();assert(freed.count(replacement));
}
void invalidBuffers(id<MTLCommandQueue>queue){
    auto owner=chain(queue);const unsigned before=frames;
    const auto reject=[&](HistoryCommandBuffer *commands){bool caught=false;try{encode(*owner,commands);}catch(const std::runtime_error&){caught=true;}assert(caught&&frames==before);};
    auto committed=buffer(queue);committed.status=MTLCommandBufferStatusCommitted;reject(committed);
    auto unretained=buffer(queue);unretained.retainedReferences=NO;reject(unretained);reject(buffer(nil));owner.reset();
}
}
int main(){@autoreleasepool{
    unsetenv("RESHADE_CONTROL_FILE");unsetenv("RESHADE_DIAGNOSTICS");setenv("RESHADE_LIBRASHADER","/proof/cpu-only-librashader.dylib",1);
    assert(opens==0&&created==0&&frames==0); // Merely enabling live capability loads nothing while Off.
    auto first=(id<MTLCommandQueue>)[NSObject new],second=(id<MTLCommandQueue>)[NSObject new];
    committedReuse(first);uncommittedAndLate(first);abandoned(first);failed(first);changedQueue(first,second);
    lateSuccessDoesNotBlessPending(first);lateErrorDoesNotPoisonReplacement(first);rejectedFrame(first);rejectedCreation(first);invalidBuffers(first);
    settle();assert(opens==1&&freed.size()==created);
    std::printf("actual Retroarch adapter CPU: provider opens=%u creates=%u frees=%zu frames=%u; same-buffer/in-flight busy without frame or creation, completed reuse, uncommitted/abandoned/failed/queue replacement, per-buffer late callbacks, failed frame/create retirement and invalid-buffer rejection passed; no GPU\n",opens,created,freed.size(),frames);return 0;
}}
