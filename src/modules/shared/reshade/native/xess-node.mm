// Copyright (c) MacLauncher contributors. MIT license.
#include "xess-node.hpp"
#include "native-config.hpp"
#include "xess-scene-matrices.hpp"
#include "scene-matrices.hpp"
#if __has_include("xess-fg-protocol.h")
#include "xess-fg-protocol.h"
#else
#include "../xess/native/xess-fg-protocol.h"
#endif
#include "image-admission.hpp"
#include "path-watch.hpp"
#include "color-island.hpp"
#include "color-conversion.hpp"
#include "gpu-completion.hpp"
#if __has_include("xess-wire.hpp")
#include "xess-wire.hpp"
#else
#include "../xess/native/xess-wire.hpp"
#endif
#import <CoreVideo/CoreVideo.h>
#include <servers/bootstrap.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <atomic>
#include <algorithm>
#include <array>
#include <map>
#include <mutex>
#include <thread>
#include <functional>
#include <cstring>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fcntl.h>
namespace macfx {
namespace {
using namespace xess;
void quarantine(std::shared_ptr<void> value){static auto *items=new std::vector<std::shared_ptr<void>>;static std::mutex lock;std::lock_guard guard(lock);items->push_back(std::move(value));}
struct Surface {
    CVPixelBufferRef pixels=nullptr;id<MTLTexture> texture;std::shared_ptr<ImageReservation> reservation;
    ~Surface(){if(pixels)CVPixelBufferRelease(pixels);}
    void allocate(id<MTLDevice>device,unsigned width,unsigned height,bool guides=false){reservation=reserveImageBytes(device,alignedImageBytes(width,height,guides?16:8),0,"xess-memory",true);NSDictionary *properties=@{(__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES,(__bridge NSString*)kCVPixelBufferBytesPerRowAlignmentKey:@256,(__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{}};if(CVPixelBufferCreate(kCFAllocatorDefault,width,height,guides?kCVPixelFormatType_128RGBAFloat:kCVPixelFormatType_64RGBAHalf,(__bridge CFDictionaryRef)properties,&pixels)!=kCVReturnSuccess)throw std::runtime_error("Cannot allocate XeSS shared scene images");reservation->commit(CVPixelBufferGetDataSize(pixels));auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:guides?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;texture=[device newTextureWithDescriptor:descriptor iosurface:CVPixelBufferGetIOSurface(pixels) plane:0];if(!texture)throw std::runtime_error("Cannot bind XeSS scene images to Metal");attachImageReservation(texture,reservation);}
};
struct Images {Surface source,guides,output;id<MTLTexture> linearSource,linearResult;};
struct Flight;
void requestStop(std::string root,std::string request){if(root.empty()||request.empty())return;dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{@autoreleasepool{NSDictionary *value=@{@"schema":@1,@"requestId":[NSString stringWithUTF8String:request.c_str()]};NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];[data writeToFile:[NSString stringWithUTF8String:(root+"/"+request+".stop.json").c_str()] options:NSDataWritingAtomic error:nil];}});}
struct Client:std::enable_shared_from_this<Client> {
    mach_port_t local=receiver(),remote=0;pid_t launcher=0,helper=0;proc_bsdinfo helperIdentity{};std::mutex lock;bool closed=false;
    std::map<uint64_t,std::function<void(const MLXessCall&,bool)>> pending;uint64_t next=1,lastFrame=0;std::shared_ptr<ImageReservation> memory;
    bool brokerOwned=false;std::string requestRoot,requestId;
    ~Client(){if(brokerOwned)requestStop(requestRoot,requestId);if(local)mach_port_destroy(mach_task_self(),local);if(remote)mach_port_deallocate(mach_task_self(),remote);}
    bool belongs(pid_t pid){for(unsigned depth=0;pid>1&&depth<16;++depth){if(pid==launcher)return true;proc_bsdinfo info{};if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info))break;pid=info.pbi_ppid;}return false;}
    void stopHelper(){pid_t pid=0;proc_bsdinfo identity{};{std::lock_guard guard(lock);pid=helper;identity=helperIdentity;helper=0;closed=true;}if(brokerOwned){requestStop(requestRoot,requestId);return;}proc_bsdinfo current{};if(pid&&proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&current,sizeof(current))==sizeof(current)&&current.pbi_start_tvsec==identity.pbi_start_tvsec&&current.pbi_start_tvusec==identity.pbi_start_tvusec)kill(pid,SIGTERM);}
    void complete(const MLXessCall &call,bool lost){std::function<void(const MLXessCall&,bool)> completion;{std::lock_guard guard(lock);auto found=pending.find(call.request);if(found==pending.end())return;completion=std::move(found->second);pending.erase(found);}completion(call,lost);}
    void fail(){stopHelper();std::vector<uint64_t> ids;{std::lock_guard guard(lock);for(auto &[id,_]:pending)ids.push_back(id);}for(auto id:ids){MLXessCall call{};call.request=id;call.status=-1;strlcpy(call.message,"XeSS GPU service ownership was lost",sizeof(call.message));complete(call,true);}}
    void close(){{std::lock_guard guard(lock);if(closed)return;closed=true;}auto self=shared_from_this();dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{Wire message{};message.call.size=sizeof(MLXessCall);message.call.version=ML_XESS_VERSION;message.call.command=ML_XESS_CLOSE;message.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;message.body.msgh_descriptor_count=3;for(auto &port:message.ports)right(port,0);send(message,self->remote);if(self->brokerOwned)requestStop(self->requestRoot,self->requestId);});}
    void listen(){pid_t pid;{std::lock_guard guard(lock);pid=helper;}for(;;){mach_port_type_t type=0;if(mach_port_type(mach_task_self(),remote,&type)!=KERN_SUCCESS||(type&MACH_PORT_TYPE_DEAD_NAME)){fail();return;}Reply reply{};auto result=receive(reply,local,1000,pid);if(result==KERN_SUCCESS){complete(reply.call,false);continue;}if(result==MACH_RCV_INVALID_DATA)continue;bool stopped;{std::lock_guard guard(lock);stopped=closed&&pending.empty();}if(stopped)return;if(brokerOwned){if(result!=MACH_RCV_TIMED_OUT){fail();return;}continue;}proc_bsdinfo info{};if(result!=MACH_RCV_TIMED_OUT||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info)||info.pbi_start_tvsec!=helperIdentity.pbi_start_tvsec||info.pbi_start_tvusec!=helperIdentity.pbi_start_tvusec){fail();return;}}}
};
NSDictionary *receipt(const std::string &root,const std::string &request){
    const auto file=root+"/"+request+".receipt.json";auto changed=dispatch_semaphore_create(0);auto replaced=std::make_shared<std::atomic<bool>>(false);
    const auto arm=[&]{return macfx::watchDirectory(root,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^(bool moved){if(moved)replaced->store(true);dispatch_semaphore_signal(changed);});};
    dispatch_source_t watcher=arm();macfx::RetryBackoff backoff;
    NSDictionary *result=nil;const auto deadline=dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC);
    for(;;){NSData *data=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:file.c_str()]];if(data&&data.length<16384){id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];if([value isKindOfClass:NSDictionary.class]){result=value;break;}}
        // Until the deadline, a watcher that cannot be armed, or whose
        // directory was replaced, is armed again and the file is polled at a
        // bounded backoff meanwhile.
        if(watcher&&replaced->exchange(false)){dispatch_source_cancel(watcher);watcher=nil;}
        if(!watcher)watcher=arm();
        const auto wait=watcher?deadline:std::min(deadline,dispatch_time(DISPATCH_TIME_NOW,int64_t(backoff.next())));
        if(dispatch_semaphore_wait(changed,wait)&&dispatch_time(DISPATCH_TIME_NOW,0)>=deadline)break;}
    if(watcher)dispatch_source_cancel(watcher);if(!result)throw std::runtime_error("The XeSS broker receipt is unavailable");if([result[@"error"] isKindOfClass:NSString.class])throw std::runtime_error([result[@"error"] UTF8String]);return result;
}
bool environmentName(const std::string &key){return key=="PATH"||key=="HOME"||key=="TMPDIR"||key=="CFFIXED_USER_HOME"||key=="LANG"||key=="TZ"||key=="__CF_USER_TEXT_ENCODING"||key.rfind("LC_",0)==0||key=="WINEPREFIX"||key=="WINELOADER"||key=="WINESERVER"||key=="WINEDLLPATH"||key=="WINEDLLOVERRIDES"||key=="WINEDEBUG"||key=="WINEESYNC"||key=="WINEMSYNC"||key=="WINED3DMETAL"||key=="WINEDXVK"||key=="CX_ROOT"||key=="CX_HOME"||key=="CX_BOTTLE"||key=="CX_BOTTLE_PATH"||key=="CX_WINELOADER"||key=="CX_GRAPHICS_BACKEND"||key=="DYLD_LIBRARY_PATH"||key=="VK_ICD_FILENAMES"||key=="VK_DRIVER_FILES";}
struct Registration {std::string endpoint;void remove(){if(endpoint.empty())return;[[maybe_unused]] const auto removed=bootstrap_register(bootstrap_port,endpoint.data(),MACH_PORT_NULL);endpoint.clear();}~Registration(){remove();}};
std::shared_ptr<Client> connect(id<MTLDevice>device,const MLXessCall &configuration,const std::string &requestedBackend,const std::string &operation="superresolution"){
    const auto selected=std::getenv("RESHADE_XESS_CONFIG");if(!selected||selected[0]!='/')throw std::runtime_error("The XeSS Windows GPU host is unavailable");
    const auto requests=std::getenv("RESHADE_XESS_REQUEST_ROOT"),receipts=std::getenv("RESHADE_XESS_RECEIPT_ROOT");const bool brokerOwned=requests&&receipts&&requests[0]=='/'&&receipts[0]=='/';
    NSData *configurationData=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:selected]];
    if(!configurationData||configurationData.length>1024*1024)throw std::runtime_error("The XeSS GPU host configuration is unavailable");
    NSDictionary *table=[NSJSONSerialization JSONObjectWithData:configurationData options:0 error:nil];
    if(![table isKindOfClass:NSDictionary.class]||[table[@"schema"] intValue]!=1)throw std::runtime_error("The XeSS GPU host configuration is invalid");
    NSDictionary *config=table;NSString *backend=nil;
    if([table[@"hosts"] isKindOfClass:NSDictionary.class]){
        backend=operation=="interpolate"?@"d3d12":requestedBackend=="auto"?table[@"defaultBackend"]:[NSString stringWithUTF8String:requestedBackend.c_str()];
        if(![backend isKindOfClass:NSString.class])throw std::runtime_error("The XeSS GPU host backend is unavailable");
        config=table[@"hosts"][operation=="interpolate"?@"d3d12-fg":backend];
    }else{
        backend=[table[@"backend"] isKindOfClass:NSString.class]?table[@"backend"]:@"d3d12";
        if(requestedBackend!="auto"&&requestedBackend!=backend.UTF8String)throw std::runtime_error("The prepared XeSS GPU host does not match this backend");
    }
    if(!([backend isEqualToString:@"d3d12"]||[backend isEqualToString:@"vulkan"])||![config isKindOfClass:NSDictionary.class])throw std::runtime_error("The selected XeSS GPU host is unavailable");
    auto client=std::make_shared<Client>();client->brokerOwned=brokerOwned;const auto prefix=std::getenv("RESHADE_XESS_SERVICE_NAMESPACE");if(!prefix||std::strncmp(prefix,"org.maclauncher.xess.",21))throw std::runtime_error("The XeSS GPU host namespace is unavailable");const std::string requestId=NSUUID.UUID.UUIDString.UTF8String;std::string endpoint=std::string(prefix)+requestId;if(endpoint.size()>=256||bootstrap_register(bootstrap_port,endpoint.data(),client->local)!=KERN_SUCCESS)throw std::runtime_error("Cannot register the XeSS GPU host endpoint");
    Registration registration{endpoint};
    if(brokerOwned){
        client->requestRoot=requests;client->requestId=requestId;NSDictionary *request=@{@"schema":@1,@"backend":backend,@"operation":[NSString stringWithUTF8String:operation.c_str()],@"requestId":[NSString stringWithUTF8String:requestId.c_str()],@"endpoint":[NSString stringWithUTF8String:endpoint.c_str()]};NSError *error=nil;NSData *data=[NSJSONSerialization dataWithJSONObject:request options:0 error:&error];if(!data||![data writeToFile:[NSString stringWithUTF8String:(client->requestRoot+"/"+requestId+".request.json").c_str()] options:NSDataWritingAtomic error:&error])throw std::runtime_error("Cannot request the XeSS GPU host");
    }else{
        if(![config[@"executable"] isKindOfClass:NSString.class]||![config[@"arguments"] isKindOfClass:NSArray.class]||![config[@"hostPath"] isKindOfClass:NSString.class]||![config[@"originalLibrary"] isKindOfClass:NSString.class])throw std::runtime_error("The XeSS GPU host configuration is invalid");
        std::vector<std::string> arguments{[config[@"executable"] UTF8String]};for(id value in config[@"arguments"]){if(![value isKindOfClass:NSString.class])throw std::runtime_error("Invalid XeSS GPU host argument");arguments.emplace_back([value UTF8String]);}arguments.emplace_back([config[@"hostPath"] UTF8String]);arguments.push_back(endpoint);if([config[@"originalLibraries"] isKindOfClass:NSArray.class]){for(id original in config[@"originalLibraries"]){if(![original isKindOfClass:NSString.class])throw std::runtime_error("Invalid XeSS original library path");arguments.emplace_back([original UTF8String]);}}else arguments.emplace_back([config[@"originalLibrary"] UTF8String]);
        std::vector<std::string> environment;NSDictionary *values=config[@"environment"];if([values isKindOfClass:NSDictionary.class])for(NSString *key in values){id value=values[key];if([key isKindOfClass:NSString.class]&&[value isKindOfClass:NSString.class]&&environmentName(key.UTF8String))environment.emplace_back(std::string(key.UTF8String)+"="+[value UTF8String]);}if(std::none_of(environment.begin(),environment.end(),[](const auto &value){return value.rfind("PATH=",0)==0;}))environment.emplace_back("PATH=/usr/bin:/bin");
        std::vector<char*> argv,env;for(auto &value:arguments)argv.push_back(value.data());argv.push_back(nullptr);for(auto &value:environment)env.push_back(value.data());env.push_back(nullptr);const int spawned=posix_spawn(&client->launcher,arguments.front().c_str(),nullptr,nullptr,argv.data(),env.data());if(spawned)throw std::runtime_error("Cannot launch the XeSS Windows GPU host");
    }
    Wire hello{};pid_t actual=0;const auto received=receive(hello,client->local,15000,0,&actual);registration.remove();
    bool authenticated=received==KERN_SUCCESS&&hello.call.version==ML_XESS_VERSION&&hello.call.command==ML_XESS_HELLO&&hello.call.process==actual&&std::memchr(hello.call.message,0,sizeof(hello.call.message))&&hello.body.msgh_descriptor_count==3&&hello.ports[0].name;
    if(authenticated&&brokerOwned){auto trusted=receipt(receipts,requestId);authenticated=[trusted[@"schema"] intValue]==1&&[trusted[@"backend"] isEqualToString:backend]&&(operation=="superresolution"||[trusted[@"operation"] isEqualToString:@"interpolate"])&&[trusted[@"requestId"] isEqualToString:[NSString stringWithUTF8String:requestId.c_str()]]&&[trusted[@"helperPID"] intValue]==actual&&[trusted[@"hostToken"] isKindOfClass:NSString.class]&&[trusted[@"hostToken"] isEqualToString:[NSString stringWithUTF8String:hello.call.message]];client->launcher=[trusted[@"launcherPID"] intValue];}else if(authenticated)authenticated=client->belongs(actual);
    if(!authenticated){if(received==KERN_SUCCESS)release(hello);throw std::runtime_error("The XeSS Windows GPU host did not authenticate");}
    client->helper=actual;if(!brokerOwned)proc_pidinfo(actual,PROC_PIDTBSDINFO,0,&client->helperIdentity,sizeof(client->helperIdentity));client->remote=hello.ports[0].name;hello.ports[0].name=0;release(hello);mach_port_t previous=MACH_PORT_NULL;[[maybe_unused]]const auto notification=mach_port_request_notification(mach_task_self(),client->remote,MACH_NOTIFY_DEAD_NAME,0,client->local,MACH_MSG_TYPE_MAKE_SEND_ONCE,&previous);if(previous)mach_port_deallocate(mach_task_self(),previous);
    Wire request{};request.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;request.body.msgh_descriptor_count=3;for(auto &port:request.ports)right(port,0);request.call=configuration;request.call.command=ML_XESS_CONFIGURE;if(send(request,client->remote)!=KERN_SUCCESS){client->stopHelper();throw std::runtime_error("Cannot configure the XeSS GPU host");}
    Reply prepared{};if(receive(prepared,client->local,15000,actual)!=KERN_SUCCESS||prepared.call.status!=2||!prepared.call.allocationBytes){client->stopHelper();throw std::runtime_error(prepared.call.message[0]?prepared.call.message:"The XeSS allocation query failed");}
    try{client->memory=reserveImageBytes(device,prepared.call.allocationBytes,0,"xess-host-memory",true);client->memory->commit(prepared.call.allocationBytes);}catch(...){client->stopHelper();throw;}
    request.call.command=ML_XESS_ADMIT;if(send(request,client->remote)!=KERN_SUCCESS){client->stopHelper();throw std::runtime_error("Cannot admit the XeSS GPU host");}
    if(receive(prepared,client->local,60000,actual)!=KERN_SUCCESS||prepared.call.status!=0){client->stopHelper();throw std::runtime_error(prepared.call.message[0]?prepared.call.message:"The original Intel XeSS runtime could not prepare this scene");}
    if(prepared.call.allocationBytes>client->memory->bytes()){client->stopHelper();throw std::runtime_error("The XeSS host allocation exceeded its admitted image envelope");}
    std::thread([client]{@autoreleasepool{client->listen();}}).detach();return client;
}
struct Control {uint32_t extent[2],outputExtent[2],colorBase[2],depthBase[2],motionBase[2];float motionScale[2],motionRatio[2];float preExposure;uint32_t flags;};
// Both original-SDK operations use the same memory-pressure backoff policy.
// No shared image has been submitted during preparation, so partial slots can
// be released before a later attempt. Real host/model failures remain terminal.
template<class Prepared>void preparationDenied(Prepared &state,const TransientBusy &problem){
    std::lock_guard guard(state.lock);state.error=problem.what();state.slots.clear();
    state.failed=problem.structurallyImpossible;
    state.retryAt=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
    state.preparation.store(state.failed?2:3,std::memory_order_release);
}
template<class Prepared>void retryPreparation(std::shared_ptr<Prepared> &state,TransientBound &pressure,std::chrono::steady_clock::time_point &nextAttempt){
    if(!state||state->preparation.load(std::memory_order_acquire)!=3)return;
    {
        std::lock_guard guard(state->lock);const auto now=std::chrono::steady_clock::now();
        if(now<state->retryAt)return;
        if(now<nextAttempt){state->retryAt=nextAttempt;return;}
        pressure.record();nextAttempt=now+std::chrono::milliseconds(pressure.exhausted()?1000:250);
    }
    // Elapsed time changes urgency, never whether valid work can recover.
    state.reset();
}
template<class Prepared>ShaderResult preparationResult(const std::shared_ptr<Prepared> &state,const char *pending,const char *unavailable){
    if(!state)return {true,{}};
    const auto status=state->preparation.load(std::memory_order_acquire);if(!status)return {false,pending,true};
    std::lock_guard guard(state->lock);
    if(status==3)return std::chrono::steady_clock::now()<state->retryAt?ShaderResult{false,state->error,true}:ShaderResult{true,{}};
    return status==2||state->failed?ShaderResult{false,state->error.empty()?unavailable:state->error}:ShaderResult{true,{}};
}
struct State {
    id<MTLDevice>device;ImageColorDescription sourceColor,linearColor;ColorEncoder color;std::string backend;
    std::shared_ptr<Client> client;std::shared_ptr<ImageReservation> memory;id<MTLComputePipelineState> input,output;
    std::mutex lock;std::vector<std::shared_ptr<Images>> slots;std::atomic<unsigned> preparation{0};std::string error;bool failed=false;ShaderResult last{true,{}};
    // preparation: 0 preparing, 1 ready, 2 failed, 3 waiting for a denied
    // image budget until retryAt (written before the release store).
    std::chrono::steady_clock::time_point retryAt{};
    MLXessCall configuration{};unsigned sourceWidth=0,sourceHeight=0,resultWidth=0,resultHeight=0;MTLPixelFormat targetFormat;bool depthFormat;
    ~State(){if(client)client->close();}
    State(id<MTLDevice>d,const RSTemporalFrame &f,const ImageColorDescription&description,std::string selectedBackend):device(d),backend(std::move(selectedBackend)),sourceColor(description),linearColor(description),color(d),targetFormat(((__bridge id<MTLTexture>)f.output).pixelFormat){linearColor.transfer=ColorTransfer::Linear;linearColor.range=ColorRange::Full;linearColor.alpha=ColorAlpha::Straight;sourceWidth=((__bridge id<MTLTexture>)f.color).width;sourceHeight=((__bridge id<MTLTexture>)f.color).height;resultWidth=f.outputWidth;resultHeight=f.outputHeight;const auto depth=((__bridge id<MTLTexture>)f.depth).pixelFormat;depthFormat=depth==MTLPixelFormatDepth32Float||depth==MTLPixelFormatDepth32Float_Stencil8||depth==MTLPixelFormatDepth24Unorm_Stencil8;configuration.size=sizeof(configuration);configuration.version=ML_XESS_VERSION;configuration.inputWidth=f.renderWidth;configuration.inputHeight=f.renderHeight;configuration.outputWidth=std::max(f.renderWidth,std::min(f.outputWidth,f.renderWidth*3));configuration.outputHeight=std::max(f.renderHeight,std::min(f.outputHeight,f.renderHeight*3));configuration.flags=(f.flags&RS_TEMPORAL_HDR?0:64u)|(f.flags&RS_TEMPORAL_DEPTH_REVERSED?2u:0u)|(f.flags&RS_TEMPORAL_JITTERED_MOTION?128u:0u)|(f.flags&RS_TEMPORAL_AUTO_EXPOSURE?256u:0u)|(f.reactive?8u:0u);}
    std::shared_ptr<Images> acquire(){std::lock_guard guard(lock);for(auto &slot:slots)if(slot.use_count()==1)return slot;return {};}
    void prepare(){try{
        const auto in=color.prepare(MTLPixelFormatRGBA16Float),out=color.prepare(targetFormat);if(!in.encoded||!out.encoded)throw std::runtime_error(in.encoded?out.reason:in.reason);
        NSString *source=[NSString stringWithFormat:@"#include <metal_stdlib>\nusing namespace metal;struct Control{uint2 extent,outputExtent,colorBase,depthBase,motionBase;float2 motionScale,motionRatio;float preExposure;uint flags;};kernel void xess_input(texture2d<float,access::sample> color [[texture(0)]],%@ depth [[texture(1)]],texture2d<float,access::sample> motion [[texture(2)]],texture2d<float,access::read> exposure [[texture(3)]],texture2d<float,access::sample> reactive [[texture(4)]],texture2d<float,access::write> target [[texture(5)]],texture2d<float,access::write> guides [[texture(6)]],constant Control&c [[buffer(0)]],uint2 p [[thread_position_in_grid]]){if(any(p>=c.extent))return;constexpr sampler linear(coord::normalized,address::clamp_to_edge,filter::linear);constexpr sampler nearest(coord::normalized,address::clamp_to_edge,filter::nearest);float2 point=float2(p)+.5f;float4 value=color.sample(linear,(point+float2(c.colorBase))/float2(color.get_width(),color.get_height()));float gain=(c.flags&512)?max(exposure.read(uint2(0)).x,1e-6f):1;value.rgb*=gain/c.preExposure;value.a=1;target.write(value,p);float2 flow=motion.sample(linear,(point*c.motionRatio+float2(c.motionBase))/float2(motion.get_width(),motion.get_height())).xy*c.motionScale;float z=float4(depth.sample(nearest,(point+float2(c.depthBase))/float2(depth.get_width(),depth.get_height()))).x;float mask=(c.flags&256)?reactive.sample(linear,(point+float2(c.colorBase))/float2(reactive.get_width(),reactive.get_height())).x:0;guides.write(float4(flow,z,clamp(mask,0.0f,1.0f)),p);}kernel void xess_output(texture2d<float,access::sample> original [[texture(0)]],texture2d<float,access::sample> model [[texture(1)]],texture2d<float,access::read> exposure [[texture(2)]],texture2d<float,access::write> target [[texture(3)]],constant Control&c [[buffer(0)]],device const uint *valid [[buffer(1)]],uint2 p [[thread_position_in_grid]]){if(any(p>=c.outputExtent))return;constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float2 uv=(float2(p)+.5f)/float2(c.outputExtent);float4 source=original.sample(s,(uv*float2(c.extent)+float2(c.colorBase))/float2(original.get_width(),original.get_height()));float4 value=source;if(*valid){value=model.sample(s,uv);float gain=(c.flags&512)?max(exposure.read(uint2(0)).x,1e-6f):1;value.rgb*=c.preExposure/gain;value.a=source.a;}target.write(value,p);}",depthFormat?@"depth2d<float,access::sample>":@"texture2d<float,access::sample>"];
        NSError *problem=nil;auto library=[device newLibraryWithSource:source options:nil error:&problem];if(!library)throw std::runtime_error(problem.localizedDescription.UTF8String?:"Cannot prepare XeSS GPU scene conversion");input=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"xess_input"] error:&problem];output=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"xess_output"] error:&problem];if(!input||!output)throw std::runtime_error("Cannot prepare XeSS scene pipelines");
        for(unsigned i=0;i<ML_XESS_SLOTS;++i){auto images=std::make_shared<Images>();images->source.allocate(device,configuration.inputWidth,configuration.inputHeight);images->guides.allocate(device,configuration.inputWidth,configuration.inputHeight,true);images->output.allocate(device,configuration.outputWidth,configuration.outputHeight);auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:sourceWidth height:sourceHeight mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;images->linearSource=newAdmittedTexture(device,descriptor,0,"xess-color-memory");descriptor.width=resultWidth;descriptor.height=resultHeight;images->linearResult=newAdmittedTexture(device,descriptor,0,"xess-color-memory");slots.push_back(std::move(images));}
        client=connect(device,configuration,backend);preparation.store(1,std::memory_order_release);
    }catch(const TransientBusy &problem){preparationDenied(*this,problem);}
    catch(const std::exception &problem){std::lock_guard guard(lock);error=problem.what();failed=true;preparation.store(2,std::memory_order_release);}}
};
// Every host wait in a caller buffer is bounded (releaseLateProvider).
constexpr const char *lateXess="XeSS exceeded its GPU wait bound; frames continue without it until it completes";
struct Flight {std::shared_ptr<State>state;std::shared_ptr<Images>images;id<MTLSharedEvent>event;id<MTLBuffer>valid;GPUCompletionFence fence;std::atomic<unsigned>submission{0};std::atomic<bool>providerDone{false},gpuDone{false},expired{false};MLXessCall call{},reply{};std::chrono::steady_clock::time_point started;};
void diagnostic(const std::shared_ptr<Flight>&flight,const MLXessCall&call){
    const auto &selected=nativeConfig().diagnostics.path;if(selected.empty())return;
    static std::mutex lock;std::lock_guard guard(lock);const auto file=std::string(selected)+".xess."+std::to_string(getpid())+".jsonl";
    FILE*output=std::fopen(file.c_str(),"a");if(!output)return;
    const double wall=flight->started.time_since_epoch().count()?std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-flight->started).count():0;
    auto metric=[&](double value){std::array<char,48> text{};if(!call.status&&std::isfinite(value)&&value>=0)std::snprintf(text.data(),text.size(),"%.6f",value);else std::strcpy(text.data(),"null");return text;};
    const auto source=metric(call.sourceCopyMs),copies=metric(call.inputCopyMs),inference=metric(call.inferenceMs),egress=metric(call.outputCopyMs);
    std::fprintf(output,"{\"frameId\":%llu,\"status\":%d,\"inputWidth\":%u,\"inputHeight\":%u,\"outputWidth\":%u,\"outputHeight\":%u,\"slot\":%u,\"source_copy_gpu_ms\":%s,\"gpu_copies_ms\":%s,\"inference_gpu_ms\":%s,\"output_copy_gpu_ms\":%s,\"completion_wall_ms\":%.6f}\n",(unsigned long long)flight->call.frameId,call.status,flight->call.inputWidth,flight->call.inputHeight,flight->call.outputWidth,flight->call.outputHeight,call.slot,source.data(),copies.data(),inference.data(),egress.data(),wall);
    std::fclose(output);
}
void completed(const std::shared_ptr<Flight>&flight,const MLXessCall &call,bool lost){diagnostic(flight,call);flight->reply=call;if(call.status){*static_cast<uint32_t*>(flight->valid.contents)=0;std::lock_guard guard(flight->state->lock);flight->state->last={false,call.message,call.status==1};if(call.status!=1){flight->state->failed=true;flight->state->error=call.message;}}if(!call.status){std::lock_guard guard(flight->state->lock);if(!flight->state->failed)flight->state->last={true,{}};}if(lost)quarantine(flight);flight->providerDone.store(true,std::memory_order_release);flight->event.signaledValue=std::max<uint64_t>(flight->event.signaledValue,2);}
void submit(const std::shared_ptr<Flight>&flight){auto client=flight->state->client;{std::lock_guard guard(client->lock);if(client->closed)throw std::runtime_error("The XeSS GPU owner is unavailable");flight->call.request=client->next++;client->pending.emplace(flight->call.request,[flight](const MLXessCall &call,bool lost){completed(flight,call,lost);});}
    std::weak_ptr<Flight> weak=flight;auto listener=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];
    [flight->event notifyListener:listener atValue:1 block:^(id<MTLSharedEvent>,uint64_t){if(auto current=weak.lock()){unsigned initial=0;if(!current->submission.compare_exchange_strong(initial,1))return;current->started=std::chrono::steady_clock::now();auto owner=current->state->client;Wire request{};request.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;request.body.msgh_descriptor_count=3;request.call=current->call;request.call.command=ML_XESS_FRAME;{std::lock_guard guard(owner->lock);request.call.reset=request.call.reset||!owner->lastFrame||request.call.frameId!=owner->lastFrame+1;owner->lastFrame=request.call.frameId;}right(request.ports[0],IOSurfaceCreateMachPort(CVPixelBufferGetIOSurface(current->images->source.pixels)));right(request.ports[1],IOSurfaceCreateMachPort(CVPixelBufferGetIOSurface(current->images->guides.pixels)));right(request.ports[2],IOSurfaceCreateMachPort(CVPixelBufferGetIOSurface(current->images->output.pixels)));const auto sent=send(request,owner->remote);release(request);if(sent!=KERN_SUCCESS)owner->fail();
        else{id<MTLBuffer> valid=current->valid;releaseLateProvider(current->event,2,^{auto late=weak.lock();if(late&&late->providerDone.load(std::memory_order_acquire))return;*static_cast<uint32_t*>(valid.contents)=0;if(late)late->expired.store(true,std::memory_order_release);});}}}];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{if(auto current=weak.lock()){unsigned initial=0;if(current->submission.compare_exchange_strong(initial,2)){MLXessCall failure=current->call;failure.status=1;strlcpy(failure.message,"The XeSS source was not submitted",sizeof(failure.message));current->state->client->complete(failure,false);}}});
}
class Encoder final:public XessSceneEncoder {
    id<MTLDevice>device;XessSpec spec;ImageColorDescription description;std::mutex mutex;std::shared_ptr<State>state;std::weak_ptr<Flight>pending;
    // A prolonged denial slows retries; only a structurally impossible
    // allocation fails. Guarded by mutex and reset for a changed contract.
    TransientBound pressure;std::chrono::steady_clock::time_point nextAttempt{};
    void retryDenied(){retryPreparation(state,pressure,nextAttempt);}
    static bool region(id<MTLTexture>image,unsigned x,unsigned y,unsigned w,unsigned h){return image&&x<=image.width&&y<=image.height&&w<=image.width-x&&h<=image.height-y;}
    std::string invalid(const RSTemporalFrame&f){auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;auto color=(__bridge id<MTLTexture>)f.color,depth=(__bridge id<MTLTexture>)f.depth,motion=(__bridge id<MTLTexture>)f.motion,output=(__bridge id<MTLTexture>)f.output;if(f.size<sizeof(f)||f.version!=1||f.commandBufferKind||!commands||commands.device!=device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return "XeSS requires the actual unsubmitted retaining Metal commands";if(!f.frameId||!f.renderWidth||!f.renderHeight||!f.outputWidth||!f.outputHeight||f.renderWidth>16384||f.renderHeight>16384)return "XeSS requires valid scene dimensions";const unsigned mw=f.flags&RS_TEMPORAL_OUTPUT_MOTION?f.outputWidth:f.renderWidth,mh=f.flags&RS_TEMPORAL_OUTPUT_MOTION?f.outputHeight:f.renderHeight;if(!region(color,f.colorX,f.colorY,f.renderWidth,f.renderHeight)||!region(depth,f.depthX,f.depthY,f.renderWidth,f.renderHeight)||!region(motion,f.motionX,f.motionY,mw,mh)||!region(output,f.outputX,f.outputY,f.outputWidth,f.outputHeight))return "XeSS requires matching actual color, depth, motion and output regions";for(auto image:{color,depth,motion,output})if(image.device!=device||image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly)return "XeSS requires resolved accessible images on its Metal device";if(output==color||output==depth||output==motion||!(color.usage&MTLTextureUsageShaderRead)||!(depth.usage&MTLTextureUsageShaderRead)||!(motion.usage&MTLTextureUsageShaderRead))return "XeSS requires distinct output and readable scene guides";if(!std::isfinite(f.preExposure)||f.preExposure<=0||!std::isfinite(f.jitterX)||!std::isfinite(f.jitterY)||!std::isfinite(f.motionScaleX)||!std::isfinite(f.motionScaleY))return "XeSS requires finite scene jitter, motion scales and positive pre-exposure";if(f.exposure){auto image=(__bridge id<MTLTexture>)f.exposure;if(image.device!=device||image.width!=1||image.height!=1||!(image.usage&MTLTextureUsageShaderRead))return "XeSS exposure must be the actual readable 1 by 1 GPU image";}if(f.reactive){auto image=(__bridge id<MTLTexture>)f.reactive;if(image.device!=device||!region(image,f.colorX,f.colorY,f.renderWidth,f.renderHeight)||!(image.usage&MTLTextureUsageShaderRead))return "XeSS responsive pixels require the actual matching GPU mask";}return {};}
public:
    Encoder(id<MTLDevice>d,const XessSpec&s):device(d),spec(s){if(spec.backend!="auto"&&spec.backend!="d3d12"&&spec.backend!="vulkan")throw std::runtime_error("Choose a supported XeSS GPU host");}
    ShaderResult preparationStatus()override{std::shared_ptr<State>selected;{std::lock_guard guard(mutex);selected=state;}return preparationResult(selected,"Preparing XeSS","XeSS is unavailable");}
    void setColorDescription(const ImageColorDescription&value)override{if(!value.valid())return;std::lock_guard guard(mutex);if(!sameImageColorDescription(description,value)){description=value;state.reset();pressure.reset();nextAttempt={};}}
    ShaderResult prepare(const RSTemporalFrame&f)override{if(auto reason=invalid(f);!reason.empty())return {false,reason};std::lock_guard guard(mutex);retryDenied();const auto color=(__bridge id<MTLTexture>)f.color,output=(__bridge id<MTLTexture>)f.output;const auto flags=(f.flags&RS_TEMPORAL_HDR?0:64u)|(f.flags&RS_TEMPORAL_DEPTH_REVERSED?2u:0u)|(f.flags&RS_TEMPORAL_JITTERED_MOTION?128u:0u)|(f.flags&RS_TEMPORAL_AUTO_EXPOSURE?256u:0u)|(f.reactive?8u:0u);
        if(!state||state->configuration.inputWidth!=f.renderWidth||state->configuration.inputHeight!=f.renderHeight||state->configuration.flags!=flags||state->sourceWidth!=color.width||state->sourceHeight!=color.height||state->resultWidth!=f.outputWidth||state->resultHeight!=f.outputHeight||state->targetFormat!=output.pixelFormat||state->depthFormat!=(((__bridge id<MTLTexture>)f.depth).pixelFormat==MTLPixelFormatDepth32Float||((__bridge id<MTLTexture>)f.depth).pixelFormat==MTLPixelFormatDepth32Float_Stencil8||((__bridge id<MTLTexture>)f.depth).pixelFormat==MTLPixelFormatDepth24Unorm_Stencil8)){if(state){pressure.reset();nextAttempt={};}auto next=std::make_shared<State>(device,f,description,spec.backend);state=next;std::thread([next]{@autoreleasepool{next->prepare();}}).detach();}
        const auto status=state->preparation.load(std::memory_order_acquire);if(!status)return {false,"Preparing XeSS",true};{std::lock_guard stateLock(state->lock);if(status==2||state->failed)return {false,state->error.empty()?"XeSS is unavailable":state->error};if(status==3)return {false,state->error,true};}pressure.reset();nextAttempt={};if(!state->acquire())return {false,"The XeSS GPU queue is full",true};return {true,{}};
    }
    ShaderResult encode(const RSTemporalFrame&f)override{auto ready=prepare(f);if(!ready.encoded)return ready;
        // A late scene holds no caller buffer; frames continue without XeSS
        // until its host finishes, instead of queuing behind it.
        {std::lock_guard guard(mutex);if(auto late=pending.lock();late&&late->expired.load(std::memory_order_acquire)&&!late->providerDone.load(std::memory_order_acquire))return {false,lateXess};}std::shared_ptr<State>selected;{std::lock_guard guard(mutex);selected=state;}auto images=selected->acquire();if(!images)return {false,"The XeSS GPU queue is full",true};auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;auto source=(__bridge id<MTLTexture>)f.color,depth=(__bridge id<MTLTexture>)f.depth,motion=(__bridge id<MTLTexture>)f.motion,target=(__bridge id<MTLTexture>)f.output,exposure=f.exposure?(__bridge id<MTLTexture>)f.exposure:source,reactive=f.reactive?(__bridge id<MTLTexture>)f.reactive:source;
        auto flight=std::make_shared<Flight>();flight->state=selected;flight->images=images;flight->fence.bind(commands);flight->event=[device newSharedEvent];flight->valid=[device newBufferWithLength:4 options:MTLResourceStorageModeShared];if(!flight->event||!flight->valid)return {false,"Cannot synchronize XeSS GPU work"};*static_cast<uint32_t*>(flight->valid.contents)=1;flight->call=selected->configuration;flight->call.frameId=f.frameId;flight->call.reset=f.flags&RS_TEMPORAL_RESET;flight->call.jitterX=f.jitterX;flight->call.jitterY=f.jitterY;
        ColorConversion convert;convert.source=selected->sourceColor;convert.target=selected->linearColor;convert.frameId=f.frameId;auto converted=selected->color.encode(commands,source,images->linearSource,convert);if(!converted.encoded)return converted;
        Control c{{f.renderWidth,f.renderHeight},{f.outputWidth,f.outputHeight},{f.colorX,f.colorY},{f.depthX,f.depthY},{f.motionX,f.motionY},{f.motionScaleX,f.motionScaleY},{1,1},f.preExposure,(f.reactive?256u:0u)|(f.exposure?512u:0u)};if(f.flags&RS_TEMPORAL_OUTPUT_MOTION){c.motionRatio[0]=float(f.outputWidth)/f.renderWidth;c.motionRatio[1]=float(f.outputHeight)/f.renderHeight;c.motionScale[0]*=float(f.renderWidth)/f.outputWidth;c.motionScale[1]*=float(f.renderHeight)/f.outputHeight;}
        auto encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:selected->input];const std::array<id<MTLTexture>,7> inputs={images->linearSource,depth,motion,exposure,reactive,images->source.texture,images->guides.texture};for(unsigned i=0;i<inputs.size();++i)[encoder setTexture:inputs[i] atIndex:i];[encoder setBytes:&c length:sizeof(c) atIndex:0];[encoder dispatchThreads:MTLSizeMake(f.renderWidth,f.renderHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        try{submit(flight);}catch(const std::exception&error){return {false,error.what()};}[commands encodeSignalEvent:flight->event value:1];[commands encodeWaitForEvent:flight->event value:2];
        encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:selected->output];[encoder setTexture:images->linearSource atIndex:0];[encoder setTexture:images->output.texture atIndex:1];[encoder setTexture:exposure atIndex:2];[encoder setTexture:images->linearResult atIndex:3];[encoder setBytes:&c length:sizeof(c) atIndex:0];[encoder setBuffer:flight->valid offset:0 atIndex:1];[encoder dispatchThreads:MTLSizeMake(f.outputWidth,f.outputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];convert.source=selected->linearColor;convert.target=selected->sourceColor;convert.outputX=f.outputX;convert.outputY=f.outputY;convert.outputWidth=f.outputWidth;convert.outputHeight=f.outputHeight;converted=selected->color.encode(commands,images->linearResult,target,convert);[commands addCompletedHandler:^(id<MTLCommandBuffer>completed){flight->fence.observe(completed);flight->gpuDone.store(true,std::memory_order_release);}];{std::lock_guard guard(mutex);pending=flight;}return converted;
    }
    ShaderResult completion()override{std::shared_ptr<State>selected;{std::lock_guard guard(mutex);selected=state;}if(!selected)return {false,"XeSS has no completed scene"};std::lock_guard guard(selected->lock);return selected->failed?ShaderResult{false,selected->error}:selected->last;}
    std::function<ShaderResult()>completionTicket()override{
        std::shared_ptr<Flight>flight;{std::lock_guard guard(mutex);flight=pending.lock();}
        if(!flight)return []{return ShaderResult{false,"XeSS has no submitted scene"};};
        return [flight]{
            if(flight->expired.load(std::memory_order_acquire))return ShaderResult{false,lateXess};
            if(!flight->providerDone.load(std::memory_order_acquire))return ShaderResult{false,"XeSS scene completion is pending",true};
            if(!flight->fence.completed())return ShaderResult{false,flight->fence.failed()?"XeSS scene GPU work failed":"XeSS scene GPU work is pending",!flight->fence.failed()};
            if(flight->reply.status)return ShaderResult{false,flight->reply.message,flight->reply.status==1};
            return *static_cast<const uint32_t*>(flight->valid.contents)?ShaderResult{true,{}}:ShaderResult{false,"XeSS did not render this scene"};
        };
    }
};
struct GenerationState {
 id<MTLDevice>device;ImageColorDescription sourceColor,providerColor;ColorEncoder color;
 std::shared_ptr<Client>client;std::vector<std::shared_ptr<Images>>slots;
 id<MTLComputePipelineState>input,output;MTLPixelFormat targetFormat;bool depthFormat=false;
    MLXessCall configuration{};std::mutex lock;std::atomic<unsigned>preparation{0};bool failed=false;std::string error;std::chrono::steady_clock::time_point retryAt{};
 uint32_t frameIndex=0;
 GenerationState(id<MTLDevice>d,id<MTLTexture>source,const RSTemporalFrame&scene,const ImageColorDescription&description):device(d),sourceColor(description),providerColor(description),color(d),targetFormat(source.pixelFormat){
  const bool hdr=imageColorIsHDR(description)||description.primaries!=ColorPrimaries::BT709;
  providerColor.primaries=hdr?ColorPrimaries::BT2020:ColorPrimaries::BT709;providerColor.transfer=hdr?ColorTransfer::PQ:ColorTransfer::SRGB;providerColor.range=ColorRange::Full;providerColor.alpha=ColorAlpha::Opaque;providerColor.sceneReferred=false;
  configuration.size=sizeof(configuration);configuration.version=ML_XESS_VERSION;configuration.inputWidth=configuration.outputWidth=source.width;configuration.inputHeight=configuration.outputHeight=source.height;configuration.flags=ML_XESS_FLAG_FRAME_GENERATION|(hdr?ML_XESS_FLAG_GENERATION_HDR10:0u)|(scene.flags&RS_TEMPORAL_DEPTH_REVERSED?1u:0u);
  const auto format=((__bridge id<MTLTexture>)scene.depth).pixelFormat;depthFormat=format==MTLPixelFormatDepth32Float||format==MTLPixelFormatDepth32Float_Stencil8||format==MTLPixelFormatDepth24Unorm_Stencil8;
 }
 ~GenerationState(){if(client)client->close();}
 std::shared_ptr<Images>acquire(){std::lock_guard guard(lock);for(const auto&slot:slots)if(slot.use_count()==1)return slot;return {};}
 void prepare(){try{
  const auto prepared=color.prepare(MTLPixelFormatRGBA16Float),target=color.prepare(targetFormat);if(!prepared.encoded||!target.encoded)throw std::runtime_error(prepared.encoded?target.reason:prepared.reason);
  NSString*source=[NSString stringWithFormat:@"#include <metal_stdlib>\nusing namespace metal;struct Control{uint2 extent,renderExtent,depthBase,motionBase;float2 motionRatio,motionScale,jitter,previousJitter;uint flags,reserved;};kernel void generation_input(texture2d<float,access::sample>color[[texture(0)]],%@ depth[[texture(1)]],texture2d<float,access::sample>motion[[texture(2)]],texture2d<float,access::write>target[[texture(3)]],texture2d<float,access::write>guides[[texture(4)]],constant Control&c[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(any(p>=c.extent))return;constexpr sampler linear(coord::normalized,address::clamp_to_edge,filter::linear);constexpr sampler nearest(coord::normalized,address::clamp_to_edge,filter::nearest);float2 point=float2(p)+.5f;float2 renderRatio=float2(c.renderExtent)/float2(c.extent);float2 colorShift=(c.flags&256)?c.jitter/renderRatio:float2(0);float4 value=color.sample(linear,(point+colorShift)/float2(c.extent));value.a=1;target.write(value,p);float2 guidePoint=point*renderRatio+c.jitter;float z=float4(depth.sample(nearest,(guidePoint+float2(c.depthBase))/float2(depth.get_width(),depth.get_height()))).x;float2 flow=motion.sample(linear,(guidePoint*c.motionRatio+float2(c.motionBase))/float2(motion.get_width(),motion.get_height())).xy*c.motionScale;if(c.flags&32)flow+=(c.previousJitter-c.jitter)/renderRatio;guides.write(float4(flow,z,0),p);}kernel void generation_output(texture2d<float,access::sample>original[[texture(0)]],texture2d<float,access::sample>model[[texture(1)]],texture2d<float,access::write>target[[texture(2)]],device const uint*valid[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(p.x>=target.get_width()||p.y>=target.get_height())return;constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float2 uv=(float2(p)+.5f)/float2(target.get_width(),target.get_height());float4 value=*valid?model.sample(s,uv):original.sample(s,uv);value.a=1;target.write(value,p);}",depthFormat?@"depth2d<float,access::sample>":@"texture2d<float,access::sample>"];
  NSError*problem=nil;auto library=[device newLibraryWithSource:source options:nil error:&problem];if(!library)throw std::runtime_error(problem.localizedDescription.UTF8String?:"Cannot prepare XeSS generation scene conversion");input=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"generation_input"] error:&problem];output=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"generation_output"] error:&problem];if(!input||!output)throw std::runtime_error("Cannot prepare XeSS generation GPU pipelines");
  for(unsigned i=0;i<ML_XESS_SLOTS;++i){auto images=std::make_shared<Images>();images->source.allocate(device,configuration.inputWidth,configuration.inputHeight);images->guides.allocate(device,configuration.inputWidth,configuration.inputHeight,true);images->output.allocate(device,configuration.inputWidth,configuration.inputHeight);auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:configuration.inputWidth height:configuration.inputHeight mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;images->linearSource=newAdmittedTexture(device,descriptor,0,"xess-generation-color-memory");images->linearResult=newAdmittedTexture(device,descriptor,0,"xess-generation-color-memory");slots.push_back(std::move(images));}
  client=connect(device,configuration,"d3d12","interpolate");preparation.store(1,std::memory_order_release);
 }catch(const TransientBusy&problem){preparationDenied(*this,problem);}
 catch(const std::exception&problem){std::lock_guard guard(lock);failed=true;error=problem.what();preparation.store(2,std::memory_order_release);}}
};
struct GenerationFlightXess {
 std::shared_ptr<GenerationState>state;std::shared_ptr<Images>images;id<MTLSharedEvent>event;id<MTLBuffer>valid;__weak id<MTLCommandBuffer>commands;
 std::chrono::steady_clock::time_point started;MLXessCall call{},reply{};GPUCompletionFence fence;std::atomic<unsigned>submission{0};std::atomic<bool>providerDone{false},gpuDone{false},expired{false};
 ShaderResult completion()const{if(expired.load(std::memory_order_acquire))return {false,lateXess};if(!providerDone.load(std::memory_order_acquire))return {false,"XeSS generation completion is pending",true};if(!fence.completed())return {false,fence.failed()?"XeSS generation GPU work failed":"XeSS generation GPU work is pending",!fence.failed()};if(reply.status)return {false,reply.message,reply.status==1};return reply.flags&ML_XESS_FLAG_GENERATED&&*static_cast<const uint32_t*>(valid.contents)?ShaderResult{true,{}}:ShaderResult{false,"XeSS did not generate this intermediate frame"};}
};
void generationDiagnostic(const std::shared_ptr<GenerationFlightXess>&flight,const MLXessCall&call){
 const auto &selected=nativeConfig().diagnostics.path;if(selected.empty())return;static std::mutex lock;std::lock_guard guard(lock);const auto name=std::string(selected)+".xess-fg."+std::to_string(getpid())+".jsonl";FILE*file=std::fopen(name.c_str(),"a");if(!file)return;
 auto metric=[&](double value){std::array<char,48>text{};if(!call.status&&std::isfinite(value)&&value>=0)std::snprintf(text.data(),text.size(),"%.6f",value);else std::strcpy(text.data(),"null");return text;};const auto source=metric(call.sourceCopyMs),backend=metric(call.inferenceMs),output=metric(call.outputCopyMs);const double elapsed=flight->started.time_since_epoch().count()?std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-flight->started).count():0;
 std::fprintf(file,"{\"frameId\":%llu,\"status\":%d,\"generated\":%s,\"width\":%u,\"height\":%u,\"source_copy_gpu_ms\":%s,\"backend_completion_wall_ms\":%s,\"output_copy_gpu_ms\":%s,\"inference_gpu_ms\":null,\"completion_wall_ms\":%.6f}\n",(unsigned long long)flight->call.frameId,call.status,call.flags&ML_XESS_FLAG_GENERATED?"true":"false",flight->call.inputWidth,flight->call.inputHeight,source.data(),backend.data(),output.data(),elapsed);std::fclose(file);
}
void completeGeneration(const std::shared_ptr<GenerationFlightXess>&flight,const MLXessCall&call,bool lost){
 generationDiagnostic(flight,call);
 flight->reply=call;if(call.status||!(call.flags&ML_XESS_FLAG_GENERATED))*static_cast<uint32_t*>(flight->valid.contents)=0;
 if(call.status<0){std::lock_guard guard(flight->state->lock);flight->state->failed=true;flight->state->error=call.message;}
 if(lost)quarantine(flight);flight->providerDone.store(true,std::memory_order_release);flight->event.signaledValue=std::max<uint64_t>(flight->event.signaledValue,2);
}
void submitGeneration(const std::shared_ptr<GenerationFlightXess>&flight){
 auto client=flight->state->client;{std::lock_guard guard(client->lock);if(client->closed)throw std::runtime_error("The XeSS generation GPU owner is unavailable");flight->call.request=client->next++;client->pending.emplace(flight->call.request,[flight](const MLXessCall&call,bool lost){completeGeneration(flight,call,lost);});}
 const std::weak_ptr<GenerationFlightXess>weak=flight;static auto listener=[[MTLSharedEventListener alloc]initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];
 [flight->event notifyListener:listener atValue:1 block:^(id<MTLSharedEvent>,uint64_t){if(auto current=weak.lock()){unsigned initial=0;if(!current->submission.compare_exchange_strong(initial,1))return;current->started=std::chrono::steady_clock::now();auto owner=current->state->client;Wire request{};request.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;request.body.msgh_descriptor_count=3;request.call=current->call;request.call.command=ML_XESS_FRAME;right(request.ports[0],IOSurfaceCreateMachPort(CVPixelBufferGetIOSurface(current->images->source.pixels)));right(request.ports[1],IOSurfaceCreateMachPort(CVPixelBufferGetIOSurface(current->images->guides.pixels)));right(request.ports[2],IOSurfaceCreateMachPort(CVPixelBufferGetIOSurface(current->images->output.pixels)));const auto sent=send(request,owner->remote);release(request);if(sent!=KERN_SUCCESS)owner->fail();
        else{id<MTLBuffer> valid=current->valid;releaseLateProvider(current->event,2,^{auto late=weak.lock();if(late&&late->providerDone.load(std::memory_order_acquire))return;*static_cast<uint32_t*>(valid.contents)=0;if(late)late->expired.store(true,std::memory_order_release);});}}}];
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{if(auto current=weak.lock()){unsigned initial=0;if(current->submission.compare_exchange_strong(initial,2)){MLXessCall failure=current->call;failure.status=1;strlcpy(failure.message,"The XeSS generation source was not submitted",sizeof(failure.message));current->state->client->complete(failure,false);}}});
}
struct GenerationControl {uint32_t extent[2],renderExtent[2],depthBase[2],motionBase[2];float motionRatio[2],motionScale[2],jitter[2],previousJitter[2];uint32_t flags,reserved;};
class XessGenerationEncoder final:public GenerationEncoder {
 id<MTLDevice>device;ImageColorDescription description;LsfgConfig config;mutable std::mutex lock;
 RSTemporalFrame scene{};__weak id<MTLCommandBuffer>sceneCommands;id<MTLTexture>depth,motion;std::optional<RSSceneMatrices>matrices;bool colorJittered=true;FrameOrigin origin=FrameOrigin::TopLeft;
 std::shared_ptr<GenerationState>state;uint64_t previous=0;float previousJitter[2]{};TransientBound pressure;std::chrono::steady_clock::time_point nextAttempt{};
 std::string invalid(id<MTLCommandBuffer>commands,id<MTLTexture>source)const{
  if(!commands||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||commands.device!=device||!source||source.device!=device||source.framebufferOnly||source.textureType!=MTLTextureType2D||source.sampleCount!=1||!(source.usage&MTLTextureUsageShaderRead))return "XeSS generation requires unsubmitted retained Metal commands and a readable image";
  if(sceneCommands!=commands||!depth||!motion||depth.device!=device||motion.device!=device||depth.framebufferOnly||motion.framebufferOnly||!(depth.usage&MTLTextureUsageShaderRead)||!(motion.usage&MTLTextureUsageShaderRead))return "XeSS generation requires matching actual scene depth and motion";
  if(!matrices||matrices->frameId!=scene.frameId||(matrices->flags&(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID))!=(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID))return "XeSS generation waits for the actual view and projection matrices";
  const unsigned mw=scene.flags&RS_TEMPORAL_OUTPUT_MOTION?scene.outputWidth:scene.renderWidth,mh=scene.flags&RS_TEMPORAL_OUTPUT_MOTION?scene.outputHeight:scene.renderHeight;
  const auto region=[](id<MTLTexture>image,unsigned x,unsigned y,unsigned width,unsigned height){return width&&height&&x<=image.width&&y<=image.height&&width<=image.width-x&&height<=image.height-y;};
  if(!region(depth,scene.depthX,scene.depthY,scene.renderWidth,scene.renderHeight)||!region(motion,scene.motionX,scene.motionY,mw,mh)||source.width>16384||source.height>16384)return "XeSS generation requires actual matching scene guide regions";
  if(!std::isfinite(scene.jitterX)||!std::isfinite(scene.jitterY)||!std::isfinite(scene.motionScaleX)||!std::isfinite(scene.motionScaleY)||!std::isfinite(scene.frameTimeMs)||scene.frameTimeMs<=0)return "XeSS generation requires finite source jitter, motion scale and duration";
  return {};
 }
public:
 XessGenerationEncoder(id<MTLDevice>d,const LsfgConfig&value):device(d),config(value){if(!d||value.multiplier!=2)throw std::runtime_error("The original XeSS generation profile produces one midpoint between real scene frames");}
 const char*method()const noexcept override{return "xess";}
  ShaderResult preparationStatus()const override{std::shared_ptr<GenerationState>selected;{std::lock_guard guard(lock);selected=state;}return preparationResult(selected,"Preparing XeSS frame generation","XeSS generation is unavailable");}
 bool requiresScene()const noexcept override{return true;}
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
  void setColorDescription(const ImageColorDescription&value)override{if(!value.valid())return;std::lock_guard guard(lock);if(!sameImageColorDescription(value,description)){description=value;state.reset();pressure.reset();nextAttempt={};previous=0;}}
 void setSceneColorJitter(bool value)override{std::lock_guard guard(lock);colorJittered=value;}
 void setSceneOrigin(FrameOrigin value)override{std::lock_guard guard(lock);if(origin!=value){origin=value;previous=0;}}
 void setScene(const RSTemporalFrame&value)override{std::lock_guard guard(lock);scene=value;sceneCommands=(__bridge id<MTLCommandBuffer>)value.commandBuffer;depth=(__bridge id<MTLTexture>)value.depth;motion=(__bridge id<MTLTexture>)value.motion;matrices=temporalSceneMatrices(value);}
 GenerationResult prepare(id<MTLCommandBuffer>commands,id<MTLTexture>source,const RSTemporalFrame*frame)override{
  if(frame)setScene(*frame);std::lock_guard guard(lock);GenerationResult result;
  if(auto reason=invalid(commands,source);!reason.empty()){result.reason=reason;return result;}
   retryPreparation(state,pressure,nextAttempt);const auto df=depth.pixelFormat;const bool sampled=df==MTLPixelFormatDepth32Float||df==MTLPixelFormatDepth32Float_Stencil8||df==MTLPixelFormatDepth24Unorm_Stencil8;
  if(!state||state->configuration.inputWidth!=source.width||state->configuration.inputHeight!=source.height||state->targetFormat!=source.pixelFormat||state->depthFormat!=sampled||bool(state->configuration.flags&1)!=bool(scene.flags&RS_TEMPORAL_DEPTH_REVERSED)||state->frameIndex==UINT32_MAX){if(state){pressure.reset();nextAttempt={};}auto next=std::make_shared<GenerationState>(device,source,scene,description);state=next;previous=0;std::thread([next]{@autoreleasepool{next->prepare();}}).detach();}
  const auto status=state->preparation.load(std::memory_order_acquire);if(!status){result.busy=true;result.reason="Preparing XeSS frame generation";return result;}
   {std::lock_guard stateLock(state->lock);if(status==2||state->failed){result.reason=state->error.empty()?"XeSS generation is unavailable":state->error;return result;}if(status==3){result.busy=true;result.reason=state->error;return result;}}pressure.reset();nextAttempt={};
  if(!state->acquire()){result.busy=true;result.reason="The XeSS generation GPU queue is full";return result;}result.encoded=true;return result;
 }
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  auto result=prepare(commands,source,nullptr);result.frameId=sequence;if(!result.encoded)return result;
  std::lock_guard guard(lock);result.encoded=false;
  if(outputs.size()!=phases.count||phases.count>1||phases.count&&std::abs(phases.timestamps[0]-.5f)>.00001f){result.reason="The original XeSS SDK produces the midpoint phase only";return result;}
  for(auto output:outputs)if(!output||output==source||output.device!=device||output.width!=source.width||output.height!=source.height||output.pixelFormat!=source.pixelFormat||output.framebufferOnly){result.reason="XeSS generation requires distinct matching output images";return result;}
  auto selected=state;auto images=selected->acquire();if(!images){result.busy=true;result.reason="The XeSS generation GPU queue is full";return result;}
  try{
   const bool reset=!previous||sequence<=previous||bool(scene.flags&RS_TEMPORAL_RESET);
   auto flight=std::make_shared<GenerationFlightXess>();flight->state=selected;flight->images=images;flight->commands=commands;flight->fence.bind(commands);flight->event=[device newSharedEvent];flight->valid=[device newBufferWithLength:4 options:MTLResourceStorageModeShared];if(!flight->event||!flight->valid)throw std::runtime_error("Cannot synchronize XeSS generation");*static_cast<uint32_t*>(flight->valid.contents)=1;flight->call=selected->configuration;flight->call.frameId=++selected->frameIndex;flight->call.reset=reset;
   const auto sdkMatrices=xessGenerationMatrices(scene,matrices,origin);if(!sdkMatrices){result.reason="XeSS generation requires a finite unjittered scene projection";return result;}
   MLXessGenerationConstants constants{};std::memcpy(constants.view,sdkMatrices->view,sizeof(constants.view));std::memcpy(constants.projection,sdkMatrices->projection,sizeof(constants.projection));constants.renderTimeMs=scene.frameTimeMs;mlXessSetGenerationConstants(&flight->call,&constants);
   ColorConversion convert;convert.source=selected->sourceColor;convert.target=selected->providerColor;convert.frameId=sequence;auto converted=selected->color.encode(commands,source,images->linearSource,convert);if(!converted.encoded){result.reason=converted.reason;result.busy=converted.busy;return result;}
   GenerationControl c{{unsigned(source.width),unsigned(source.height)},{scene.renderWidth,scene.renderHeight},{scene.depthX,scene.depthY},{scene.motionX,scene.motionY},{1,1},{scene.motionScaleX*source.width/scene.renderWidth,scene.motionScaleY*source.height/scene.renderHeight},{scene.jitterX,scene.jitterY},{reset?scene.jitterX:previousJitter[0],reset?scene.jitterY:previousJitter[1]},scene.flags|(colorJittered?256u:0u)};
   if(scene.flags&RS_TEMPORAL_OUTPUT_MOTION){c.motionRatio[0]=float(scene.outputWidth)/scene.renderWidth;c.motionRatio[1]=float(scene.outputHeight)/scene.renderHeight;c.motionScale[0]=scene.motionScaleX*source.width/scene.outputWidth;c.motionScale[1]=scene.motionScaleY*source.height/scene.outputHeight;}
   auto encoder=[commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot encode XeSS generation scene transport");[encoder setComputePipelineState:selected->input];for(unsigned i=0;i<5;++i)[encoder setTexture:std::array<id<MTLTexture>,5>{images->linearSource,depth,motion,images->source.texture,images->guides.texture}[i] atIndex:i];[encoder setBytes:&c length:sizeof(c) atIndex:0];[encoder dispatchThreads:MTLSizeMake(source.width,source.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
   submitGeneration(flight);[commands encodeSignalEvent:flight->event value:1];[commands encodeWaitForEvent:flight->event value:2];
   if(!outputs.empty()){encoder=[commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot encode XeSS generation output");[encoder setComputePipelineState:selected->output];[encoder setTexture:images->source.texture atIndex:0];[encoder setTexture:images->output.texture atIndex:1];[encoder setTexture:images->linearResult atIndex:2];[encoder setBuffer:flight->valid offset:0 atIndex:0];[encoder dispatchThreads:MTLSizeMake(source.width,source.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];convert.source=selected->providerColor;convert.target=selected->sourceColor;converted=selected->color.encode(commands,images->linearResult,outputs[0],convert);if(!converted.encoded){result.reason=converted.reason;result.busy=converted.busy;return result;}}
   [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){flight->fence.observe(completed);flight->gpuDone.store(true,std::memory_order_release);}];previous=sequence;previousJitter[0]=scene.jitterX;previousJitter[1]=scene.jitterY;result.encoded=true;result.ready=!reset&&!outputs.empty();result.generated=result.ready?1:0;result.historyFrames=reset?1:2;result.completion=[flight]{return flight->completion();};return result;
  }catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&error){result.reason=error.what();return result;}
 }
};

}
std::shared_ptr<GenerationEncoder> makeXessGenerationEncoder(id<MTLDevice>device,const LsfgConfig&config){return std::make_shared<XessGenerationEncoder>(device,config);}
std::shared_ptr<XessSceneEncoder> makeXessSceneEncoder(id<MTLDevice>device,const XessSpec &spec){return std::make_shared<Encoder>(device,spec);}
}
