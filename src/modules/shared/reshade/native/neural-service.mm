// Copyright (c) MacLauncher contributors. MIT license.
// One ARM64 model worker per operation owner. Images cross Mach as IOSurface
// rights. Event notifications/completion replies bridge GPU fences without
// reading pixels; MTLSharedEventHandle requires an XPC encoder for transport.
#if __has_include("neural-provider.h")
#include "neural-service.hpp"
#else
#include "../neural/native/Sources/CNeural/include/maclauncher-neural.h"
#endif
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <bsm/libbsm.h>
#include <servers/bootstrap.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#include <dlfcn.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <thread>
#include <map>
#include <vector>
#include <algorithm>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <cstring>
extern char **environ;
extern "C" uint32_t ml_neural_service_timing_api(void){return 1;}
namespace {
constexpr uint32_t protocolVersion=3;
enum {Hello=1,Create=2,Submit=3,Close=4,SubmitBatch=5,SubmitScene=6,PrepareDepth=7,SubmitTimed=8};
struct Message {
    mach_msg_header_t header{};mach_msg_body_t body{};mach_msg_port_descriptor_t ports[6]{};
    uint32_t version=protocolVersion,command=0;uint64_t request=0;
    MLNeuralOptionsV2 options{};
    uint64_t producer=0,done=0,frame=0,next=0;float phase=0;uint32_t reset=0,count=0;
    float phases[4]{};int32_t process=0;char model[4096]{};
};
struct Reply {mach_msg_header_t header{};uint64_t request=0;int32_t status=0;char message[512]{};};
// Protocol 3 base messages stay byte-for-byte compatible with old helpers.
// Only a supported operation receives these exact larger timed envelopes.
struct TimedMessage {Message base;uint64_t token=0;};
struct TimedReply {Reply base;MLNeuralGPUTimingV1 timing{};};
template<typename T>int send(T &value,mach_port_t port){
    auto&header=*reinterpret_cast<mach_msg_header_t*>(&value);header.msgh_remote_port=port;header.msgh_size=sizeof(T);
    header.msgh_bits=MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0)|(header.msgh_bits&MACH_MSGH_BITS_COMPLEX);
    return mach_msg(&header,MACH_SEND_MSG|MACH_SEND_TIMEOUT,sizeof(T),0,MACH_PORT_NULL,1000,MACH_PORT_NULL);
}
template<typename T>int receive(T &value,mach_port_t port,unsigned timeout,pid_t expectedProcess=0){
    struct {T value;mach_msg_max_trailer_t trailer;} buffer{};
    const auto result=mach_msg(&buffer.value.header,MACH_RCV_MSG|MACH_RCV_TIMEOUT|MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0)|MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),0,sizeof(buffer),port,timeout,MACH_PORT_NULL);
    if(result==KERN_SUCCESS){
        if(buffer.value.header.msgh_size!=sizeof(T)){mach_msg_destroy(&buffer.value.header);return MACH_RCV_INVALID_DATA;}
        if(expectedProcess){
            using AuditPID=pid_t(*)(audit_token_t);
            static const auto auditPID=reinterpret_cast<AuditPID>(dlsym(dlopen("/usr/lib/libbsm.dylib",RTLD_LOCAL|RTLD_NOW),"audit_token_to_pid"));
            const auto *trailer=reinterpret_cast<const mach_msg_audit_trailer_t*>(reinterpret_cast<const uint8_t*>(&buffer)+round_msg(sizeof(T)));
            if(!auditPID||trailer->msgh_trailer_size<sizeof(*trailer)||auditPID(trailer->msgh_audit)!=expectedProcess){mach_msg_destroy(&buffer.value.header);return MACH_RCV_INVALID_DATA;}
        }
        value=buffer.value;
    }
    return result;
}
template<typename T>int receiveFlexible(T&value,size_t baseBytes,mach_port_t port,unsigned timeout,pid_t expectedProcess){
    struct {T value;mach_msg_max_trailer_t trailer;}buffer{};auto&header=*reinterpret_cast<mach_msg_header_t*>(&buffer.value);
    const auto result=mach_msg(&header,MACH_RCV_MSG|MACH_RCV_TIMEOUT|MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0)|MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),0,sizeof(buffer),port,timeout,MACH_PORT_NULL);
    if(result==KERN_SUCCESS){const auto bytes=header.msgh_size;if(bytes!=sizeof(T)&&bytes!=baseBytes){mach_msg_destroy(&header);return MACH_RCV_INVALID_DATA;}
        using AuditPID=pid_t(*)(audit_token_t);static const auto auditPID=reinterpret_cast<AuditPID>(dlsym(dlopen("/usr/lib/libbsm.dylib",RTLD_LOCAL|RTLD_NOW),"audit_token_to_pid"));
        const auto*trailer=reinterpret_cast<const mach_msg_audit_trailer_t*>(reinterpret_cast<const uint8_t*>(&buffer)+round_msg(bytes));
        if(!auditPID||trailer->msgh_trailer_size<sizeof(*trailer)||auditPID(trailer->msgh_audit)!=expectedProcess){mach_msg_destroy(&header);return MACH_RCV_INVALID_DATA;}value=buffer.value;
    }return result;
}
int sendSubmission(Message&message,uint64_t token,mach_port_t port){if(!token)return send(message,port);TimedMessage timed;timed.base=message;timed.token=token;return send(timed,port);}
mach_port_t receiver(){mach_port_t port=MACH_PORT_NULL;if(mach_port_allocate(mach_task_self(),MACH_PORT_RIGHT_RECEIVE,&port)!=KERN_SUCCESS||mach_port_insert_right(mach_task_self(),port,port,MACH_MSG_TYPE_MAKE_SEND)!=KERN_SUCCESS)throw std::runtime_error("Cannot create the neural service endpoint");return port;}
void right(mach_msg_port_descriptor_t &entry,mach_port_t port){entry.name=port;entry.disposition=MACH_MSG_TYPE_COPY_SEND;entry.type=MACH_MSG_PORT_DESCRIPTOR;}
void releaseRights(Message &value){if(!(value.header.msgh_bits&MACH_MSGH_BITS_COMPLEX))return;if(value.body.msgh_descriptor_count!=6){mach_msg_destroy(&value.header);return;}for(auto &entry:value.ports)if(entry.name){mach_port_deallocate(mach_task_self(),entry.name);entry.name=MACH_PORT_NULL;}}
void reply(mach_port_t port,uint64_t request,int status,const char *message,bool timingSupported=false){Reply value{};value.header.msgh_id=timingSupported?1:0;value.request=request;value.status=status;if(message)strlcpy(value.message,message,sizeof(value.message));send(value,port);}

#if !defined(MACLAUNCHER_NEURAL_SERVICE_MAIN)
struct Pending {
    MLNeuralCompletion completion=nullptr;MLNeuralTimingCompletion timingCompletion=nullptr;void *context=nullptr;id<MTLSharedEvent> event;uint64_t done=0,timingToken=0;
    CVPixelBufferRef source=nullptr,next=nullptr,destination=nullptr;
    std::vector<CVPixelBufferRef> extra;
    ~Pending(){if(source)CVPixelBufferRelease(source);if(next)CVPixelBufferRelease(next);if(destination)CVPixelBufferRelease(destination);for(auto image:extra)CVPixelBufferRelease(image);}
};
struct Client:std::enable_shared_from_this<Client>{
    mach_port_t local=MACH_PORT_NULL,remote=MACH_PORT_NULL;pid_t process=0;std::mutex lock;
    MTLSharedEventListener *listener=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0)];
    std::map<uint64_t,std::shared_ptr<Pending>> pending;uint64_t nextRequest=1;bool closed=false,timingSupported=false;
    ~Client(){if(local)mach_port_destroy(mach_task_self(),local);if(remote)mach_port_deallocate(mach_task_self(),remote);if(process){kill(process,SIGTERM);waitpid(process,nullptr,0);}}
    void complete(const Reply &value,const MLNeuralGPUTimingV1*timing=nullptr){std::shared_ptr<Pending> item;{std::lock_guard guard(lock);auto found=pending.find(value.request);if(found==pending.end())return;item=std::move(found->second);pending.erase(found);}
        // A helper rejection occurs before it takes GPU work. Release the
        // caller's initialized output in that case as well as on helper loss.
        if(item->timingCompletion){MLNeuralGPUTimingV1 receipt{};receipt.size=sizeof(receipt);receipt.version=1;receipt.job_token=item->timingToken;receipt.status=2;if(value.status==ML_NEURAL_RENDERED&&timing&&timing->size>=sizeof(*timing)&&timing->version==1&&timing->job_token==item->timingToken)receipt=*timing;item->timingCompletion(item->context,&receipt);}
        if(item->completion)item->completion(item->context,value.status,value.message);
        // Failure metadata selects the caller's own fallback before its GPU
        // wait is released. A lost worker's surfaces must never be read/reused.
        if(item->event)item->event.signaledValue=std::max(item->event.signaledValue,item->done);
    }
    void listen(){pid_t child;{std::lock_guard guard(lock);child=process;}for(;;){TimedReply envelope{};const auto status=receiveFlexible(envelope,sizeof(Reply),local,1000,child);auto&value=envelope.base;
        if(status==KERN_SUCCESS){complete(value,value.header.msgh_size==sizeof(TimedReply)?&envelope.timing:nullptr);continue;}
        if(status==MACH_RCV_INVALID_DATA)continue;
        int exitStatus=0;const auto exited=waitpid(child,&exitStatus,WNOHANG);
        if(status!=MACH_RCV_TIMED_OUT||exited==child||kill(child,0)!=0){
            if(exited!=child)retireLostOwner();
            std::vector<uint64_t> ids;{std::lock_guard guard(lock);if(exited==child)process=0;closed=true;for(auto &[id,_]:pending)ids.push_back(id);}for(auto id:ids){Reply failed{};failed.request=id;failed.status=ML_NEURAL_FAILED;strlcpy(failed.message,"Neural service ownership was lost",sizeof(failed.message));complete(failed);}return;}
        {std::lock_guard guard(lock);if(closed&&pending.empty())return;}
    }}
    void close(){std::lock_guard guard(lock);if(closed)return;closed=true;Message value{};value.command=Close;send(value,remote);}
    void retireLostOwner(){pid_t child;{std::lock_guard guard(lock);closed=true;child=process;process=0;}if(child){kill(child,SIGTERM);waitpid(child,nullptr,0);}}
};
using NeuralServiceHandle=std::shared_ptr<Client>;
std::vector<std::string> serviceEnvironment(){
    std::vector<std::string> result;
    NSDictionary<NSString*,NSString*> *values=NSProcessInfo.processInfo.environment;
    for(NSString *key in values){
        const std::string name=key.UTF8String;
        const bool processSetting=name=="HOME"||name=="TMPDIR"||name=="CFFIXED_USER_HOME"||name=="LANG"||name=="TZ"||name=="__CF_USER_TEXT_ENCODING"||name.rfind("LC_",0)==0;
        if(processSetting)result.push_back(name+"="+std::string(values[key].UTF8String));
    }
    result.emplace_back("PATH=/usr/bin:/bin");
    return result;
}
std::shared_ptr<Client> connect(const char *model,const MLNeuralOptionsV2 &options){
    if(!model||std::strlen(model)>=4096)throw std::runtime_error("Choose a local neural model");
    const auto root=std::getenv("RESHADE_NEURAL_ROOT"),explicitPath=std::getenv("RESHADE_NEURAL_SERVICE");
    const std::string executable=explicitPath&&*explicitPath?explicitPath:root&&*root?std::string(root)+"/maclauncher-neural-service":"";
    if(executable.empty()||executable.front()!='/')throw std::runtime_error("The ARM64 neural service is unavailable");
    auto client=std::make_shared<Client>();client->local=receiver();
    const char *selectedNamespace=std::getenv("RESHADE_NEURAL_SERVICE_NAMESPACE");
    const std::string nameSpace=selectedNamespace&&std::strncmp(selectedNamespace,"org.maclauncher.neural.",23)==0?selectedNamespace:"org.maclauncher.neural.";
    std::string name=nameSpace+std::string(NSUUID.UUID.UUIDString.UTF8String);
    if(bootstrap_register(bootstrap_port,name.data(),client->local)!=KERN_SUCCESS)throw std::runtime_error("Cannot register the neural service endpoint");
    const char *arguments[]={executable.c_str(),name.c_str(),nullptr};
    auto environment=serviceEnvironment();std::vector<char*> environmentPointers;
    for(auto &value:environment)environmentPointers.push_back(value.data());environmentPointers.push_back(nullptr);
    const int launched=posix_spawn(&client->process,executable.c_str(),nullptr,nullptr,const_cast<char *const *>(arguments),environmentPointers.data());
    if(launched){[[maybe_unused]] const auto removed=bootstrap_register(bootstrap_port,name.data(),MACH_PORT_NULL);throw std::runtime_error("Cannot launch the ARM64 neural service");}
    Message hello{};const auto received=receive(hello,client->local,10000,client->process);
    [[maybe_unused]] const auto removed=bootstrap_register(bootstrap_port,name.data(),MACH_PORT_NULL);
    if(received!=KERN_SUCCESS||hello.version!=protocolVersion||hello.command!=Hello||hello.process!=client->process||hello.body.msgh_descriptor_count!=6||!hello.ports[0].name){if(received==KERN_SUCCESS)releaseRights(hello);kill(client->process,SIGTERM);throw std::runtime_error("The ARM64 neural service did not connect");}
    client->remote=hello.ports[0].name;hello.ports[0].name=MACH_PORT_NULL;releaseRights(hello);
    Message create{};create.command=Create;create.options=options;strlcpy(create.model,model,sizeof(create.model));
    if(send(create,client->remote)!=KERN_SUCCESS)throw std::runtime_error("Cannot initialize the neural service");
    Reply result{};if(receive(result,client->local,10000,client->process)!=KERN_SUCCESS||result.status!=ML_NEURAL_RENDERED){client->close();throw std::runtime_error(result.message[0]?result.message:"The neural service could not prepare this operation");}
    client->timingSupported=result.header.msgh_id==1;
    std::thread([client]{@autoreleasepool{client->listen();}}).detach();return client;
}
#endif
}

#if !defined(MACLAUNCHER_NEURAL_SERVICE_MAIN)
MLNeuralProvider ml_neural_service_create_v2(const char *path,const MLNeuralOptionsV2 *options,char *error,size_t capacity){
    try{if(!options||options->size<sizeof(*options)||options->version!=2)throw std::runtime_error("Unsupported neural operation ABI");return new NeuralServiceHandle(connect(path,*options));}
    catch(const std::exception &problem){if(error&&capacity)strlcpy(error,problem.what(),capacity);return nullptr;}
}
MLNeuralProvider ml_neural_service_create(const char *path,float intensity,int temporal,char *error,size_t capacity){MLNeuralOptionsV2 options{};options.size=sizeof(options);options.version=2;options.operation=ML_NEURAL_NR;options.intensity=intensity;options.temporal=temporal;return ml_neural_service_create_v2(path,&options,error,capacity);}
static int submitService(MLNeuralProvider handle,const MLNeuralFrameV2 *frame,const void *const *destinations,const float *phases,uint32_t count,MLNeuralCompletion completion,void *context,const void *guide=nullptr,uint64_t timingToken=0,MLNeuralTimingCompletion timingCompletion=nullptr){
    if(!handle||!frame||frame->size<sizeof(*frame)||frame->version!=2||!frame->source||!frame->destination||!frame->shared_event)return ML_NEURAL_INVALID;
    auto client=*static_cast<NeuralServiceHandle*>(handle);auto item=std::make_shared<Pending>();item->completion=completion;item->context=context;item->done=frame->done_value;item->timingToken=timingToken;item->timingCompletion=timingCompletion;if(timingCompletion&&(!timingToken||!client->timingSupported))return ML_NEURAL_INVALID;
    item->source=(CVPixelBufferRef)CFRetain(frame->source);item->destination=(CVPixelBufferRef)CFRetain(frame->destination);if(frame->next_source)item->next=(CVPixelBufferRef)CFRetain(frame->next_source);
    item->event=(__bridge id<MTLSharedEvent>)frame->shared_event;
    auto held=std::shared_ptr<Message>(new Message,[](Message *value){releaseRights(*value);delete value;});auto &message=*held;
    if(count>4||count&&(!destinations||!phases))return ML_NEURAL_INVALID;
    message.command=timingCompletion?SubmitTimed:guide?SubmitScene:count?SubmitBatch:Submit;message.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;message.body.msgh_descriptor_count=6;
    for(auto &entry:message.ports)right(entry,MACH_PORT_NULL);
    auto source=CVPixelBufferGetIOSurface(item->source),destination=CVPixelBufferGetIOSurface(item->destination),next=item->next?CVPixelBufferGetIOSurface(item->next):nullptr;
    if(!source||!destination||item->next&&!next)return ML_NEURAL_INVALID;
    right(message.ports[0],IOSurfaceCreateMachPort(source));
    if(count){
        if(!next)return ML_NEURAL_INVALID;right(message.ports[1],IOSurfaceCreateMachPort(next));message.count=count;
        for(unsigned i=0;i<count;++i){if(!destinations[i])return ML_NEURAL_INVALID;auto image=(CVPixelBufferRef)destinations[i];if(i)item->extra.push_back((CVPixelBufferRef)CFRetain(image));
            auto surface=CVPixelBufferGetIOSurface(image);if(!surface)return ML_NEURAL_INVALID;right(message.ports[2+i],IOSurfaceCreateMachPort(surface));message.phases[i]=phases[i];}
    }else{right(message.ports[1],IOSurfaceCreateMachPort(destination));
        if(guide){auto image=(CVPixelBufferRef)guide;auto surface=CVPixelBufferGetIOSurface(image);if(!surface)return ML_NEURAL_INVALID;item->extra.push_back((CVPixelBufferRef)CFRetain(image));right(message.ports[2],IOSurfaceCreateMachPort(surface));}
        else right(message.ports[2],next?IOSurfaceCreateMachPort(next):MACH_PORT_NULL);}
    message.producer=frame->producer_value;message.done=frame->done_value;message.frame=frame->frame_id;message.next=frame->next_frame_id;message.phase=frame->phase;message.reset=frame->reset_history;
    {std::lock_guard guard(client->lock);if(client->closed)return ML_NEURAL_CLOSED;if(client->pending.size()>=2)return ML_NEURAL_BUSY;
        message.request=client->nextRequest++;client->pending.emplace(message.request,item);}
    std::weak_ptr<Client> weak=client;
    [item->event notifyListener:client->listener atValue:message.producer block:^(id<MTLSharedEvent>,uint64_t){
        if(auto selected=weak.lock()){
            bool failed=false;{std::lock_guard guard(selected->lock);if(selected->pending.count(held->request))failed=sendSubmission(*held,timingToken,selected->remote)!=KERN_SUCCESS;}
            if(failed){selected->retireLostOwner();Reply value{};value.request=held->request;value.status=ML_NEURAL_FAILED;strlcpy(value.message,"Neural service ownership was lost during submission",sizeof(value.message));selected->complete(value);}
        }
    }];
    const auto request=message.request,producer=message.producer;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        if(auto selected=weak.lock()){
            std::shared_ptr<Pending> pending;{std::lock_guard guard(selected->lock);const auto found=selected->pending.find(request);if(found!=selected->pending.end())pending=found->second;}
            if(pending&&pending->event.signaledValue<producer){Reply value{};value.request=request;value.status=ML_NEURAL_FAILED;strlcpy(value.message,"The neural source was not submitted",sizeof(value.message));selected->complete(value);}
        }
    });
    return ML_NEURAL_RENDERED;
}
uint32_t ml_neural_service_timing_supported_v1(MLNeuralProvider handle){return handle&&(*static_cast<NeuralServiceHandle*>(handle))->timingSupported?1:0;}
int ml_neural_service_submit_timed_v1(MLNeuralProvider handle,const MLNeuralFrameV2*frame,uint64_t token,MLNeuralTimingCompletion timing,MLNeuralCompletion completion,void*context){if(!timing)return ML_NEURAL_INVALID;return submitService(handle,frame,nullptr,nullptr,0,completion,context,nullptr,token,timing);}
int ml_neural_service_submit_batch_timed_v1(MLNeuralProvider handle,const MLNeuralFrameV2*frame,const void*const*destinations,const float*phases,uint32_t count,uint64_t token,MLNeuralTimingCompletion timing,MLNeuralCompletion completion,void*context){if(!timing||!count)return ML_NEURAL_INVALID;return submitService(handle,frame,destinations,phases,count,completion,context,nullptr,token,timing);}
int ml_neural_service_submit_v2(MLNeuralProvider provider,const MLNeuralFrameV2 *frame,MLNeuralCompletion completion,void *context){return submitService(provider,frame,nullptr,nullptr,0,completion,context);}
int ml_neural_service_submit_batch_v2(MLNeuralProvider provider,const MLNeuralFrameV2 *frame,const void *const *destinations,const float *phases,uint32_t count,MLNeuralCompletion completion,void *context){if(!count)return ML_NEURAL_INVALID;return submitService(provider,frame,destinations,phases,count,completion,context);}
int ml_neural_service_submit_scene_v3(MLNeuralProvider provider,const MLNeuralSceneFrameV3 *scene,MLNeuralCompletion completion,void *context){if(!scene||scene->size<sizeof(*scene)||scene->version!=3||!scene->guides)return ML_NEURAL_INVALID;return submitService(provider,&scene->frame,nullptr,nullptr,0,completion,context,scene->guides);}
int ml_neural_service_prepare_depth_v1(MLNeuralProvider handle,uint32_t width,uint32_t height,MLNeuralCompletion completion,void *context){
    if(!handle||!width||!height||width>4096||height>4096||width%14||height%14)return ML_NEURAL_INVALID;
    auto client=*static_cast<NeuralServiceHandle*>(handle);auto item=std::make_shared<Pending>();item->completion=completion;item->context=context;
    Message message{};message.command=PrepareDepth;message.count=width;message.reset=height;
    {std::lock_guard guard(client->lock);if(client->closed)return ML_NEURAL_CLOSED;if(client->pending.size()>=2)return ML_NEURAL_BUSY;
        message.request=client->nextRequest++;client->pending.emplace(message.request,item);}
    if(send(message,client->remote)!=KERN_SUCCESS){client->retireLostOwner();Reply failed{};failed.request=message.request;failed.status=ML_NEURAL_FAILED;strlcpy(failed.message,"Neural service ownership was lost during preparation",sizeof(failed.message));client->complete(failed);}
    return ML_NEURAL_RENDERED;
}
int ml_neural_service_submit(MLNeuralProvider provider,const void *source,const void *destination,const void *event,uint64_t producer,uint64_t done,uint64_t frame,int reset,MLNeuralCompletion completion,void *context){MLNeuralFrameV2 value{};value.size=sizeof(value);value.version=2;value.source=source;value.destination=destination;value.shared_event=event;value.producer_value=producer;value.done_value=done;value.frame_id=frame;value.reset_history=reset;return ml_neural_service_submit_v2(provider,&value,completion,context);}
void ml_neural_service_destroy(MLNeuralProvider handle){if(!handle)return;auto client=*static_cast<NeuralServiceHandle*>(handle);delete static_cast<NeuralServiceHandle*>(handle);client->close();}
#else
namespace {
struct ServiceFlight {CVPixelBufferRef source=nullptr,destination=nullptr,next=nullptr,guides=nullptr;id<MTLSharedEvent> event;mach_port_t replyPort;uint64_t request;std::atomic<unsigned> *active;
    std::vector<CVPixelBufferRef> outputs;bool timed=false;uint64_t token=0;MLNeuralGPUTimingV1 timing{};
    ~ServiceFlight(){if(source)CVPixelBufferRelease(source);if(destination&&outputs.empty())CVPixelBufferRelease(destination);if(next)CVPixelBufferRelease(next);if(guides)CVPixelBufferRelease(guides);for(auto image:outputs)if(image)CVPixelBufferRelease(image);}
};
CVPixelBufferRef pixel(mach_port_t port){if(!port)return nullptr;IOSurfaceRef surface=IOSurfaceLookupFromMachPort(port);if(!surface)return nullptr;CVPixelBufferRef output=nullptr;CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault,surface,(__bridge CFDictionaryRef)@{(__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES},&output);CFRelease(surface);return output;}
void serviceTiming(void*pointer,const MLNeuralGPUTimingV1*receipt){auto*frame=static_cast<ServiceFlight*>(pointer);if(receipt&&receipt->size>=sizeof(*receipt)&&receipt->version==1&&receipt->job_token==frame->token)frame->timing=*receipt;}
void serviceDone(void *pointer,int status,const char *message){std::unique_ptr<ServiceFlight> frame(static_cast<ServiceFlight*>(pointer));if(frame->timed){TimedReply value;value.base.request=frame->request;value.base.status=status;if(message)strlcpy(value.base.message,message,sizeof(value.base.message));value.timing=frame->timing;send(value,frame->replyPort);}else reply(frame->replyPort,frame->request,status,message);frame->active->fetch_sub(1);}
}
int main(int argc,char **argv){@autoreleasepool{
    if(argc!=2)return 2;const auto parent=getppid();mach_port_t client=MACH_PORT_NULL;if(bootstrap_look_up(bootstrap_port,argv[1],&client)!=KERN_SUCCESS)return 3;
    const auto local=receiver();Message hello{};hello.command=Hello;hello.process=getpid();hello.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;hello.body.msgh_descriptor_count=6;for(auto &entry:hello.ports)right(entry,MACH_PORT_NULL);right(hello.ports[0],local);if(send(hello,client)!=KERN_SUCCESS)return 4;
    NSString *folder=[NSString stringWithUTF8String:argv[0]].stringByDeletingLastPathComponent;
    void *library=dlopen([folder stringByAppendingPathComponent:@"libMacLauncherNeural.dylib"].fileSystemRepresentation,RTLD_NOW|RTLD_LOCAL);
    auto create=library?reinterpret_cast<decltype(&ml_neural_create_v2)>(dlsym(library,"ml_neural_create_v2")):nullptr;
    auto submit=library?reinterpret_cast<decltype(&ml_neural_submit_v2)>(dlsym(library,"ml_neural_submit_v2")):nullptr;
    auto submitBatch=library?reinterpret_cast<decltype(&ml_neural_submit_batch_v2)>(dlsym(library,"ml_neural_submit_batch_v2")):nullptr;
    auto submitScene=library?reinterpret_cast<decltype(&ml_neural_submit_scene_v3)>(dlsym(library,"ml_neural_submit_scene_v3")):nullptr;
    auto depthAPI=library?reinterpret_cast<decltype(&ml_neural_depth_api)>(dlsym(library,"ml_neural_depth_api")):nullptr;
    auto prepareDepth=library?reinterpret_cast<decltype(&ml_neural_prepare_depth_v1)>(dlsym(library,"ml_neural_prepare_depth_v1")):nullptr;
    auto destroy=library?reinterpret_cast<decltype(&ml_neural_destroy_v2)>(dlsym(library,"ml_neural_destroy_v2")):nullptr;
    const auto timingAPI=library?reinterpret_cast<uint32_t(*)()>(dlsym(library,"ml_neural_timing_api")):nullptr;
    const auto timingSupported=timingAPI&&timingAPI()==1?reinterpret_cast<decltype(&ml_neural_timing_supported_v1)>(dlsym(library,"ml_neural_timing_supported_v1")):nullptr;
    const auto submitTimed=timingSupported?reinterpret_cast<decltype(&ml_neural_submit_timed_v1)>(dlsym(library,"ml_neural_submit_timed_v1")):nullptr;
    const auto submitBatchTimed=timingSupported?reinterpret_cast<decltype(&ml_neural_submit_batch_timed_v1)>(dlsym(library,"ml_neural_submit_batch_timed_v1")):nullptr;
    MLNeuralProvider provider=nullptr;std::atomic<unsigned> active{0};bool closing=false;auto device=MTLCreateSystemDefaultDevice();
    for(;;){if(getppid()!=parent)break;if(closing&&!active.load())break;TimedMessage envelope{};const auto status=receiveFlexible(envelope,sizeof(Message),local,250,parent);auto&value=envelope.base;if(status==MACH_RCV_TIMED_OUT||status==MACH_RCV_INVALID_DATA)continue;if(status!=KERN_SUCCESS)break;
        if(value.version!=protocolVersion){releaseRights(value);continue;}
        if(value.command==Create){char error[512]{};if(create&&submit&&destroy){
            if(value.options.operation==ML_NEURAL_DEPTH_ANYTHING_V2_SMALL&&(!depthAPI||depthAPI()!=1||!prepareDepth))strlcpy(error,"This neural provider does not supply scalar relative-depth inference",sizeof(error));
            else provider=create(value.model,&value.options,error,sizeof(error));
        }reply(client,0,provider?ML_NEURAL_RENDERED:ML_NEURAL_FAILED,error[0]?error:"The neural operation provider is unavailable",provider&&timingSupported&&submitTimed&&timingSupported(provider)==1);}
        else if(value.command==Close){closing=true;if(provider){destroy(provider);provider=nullptr;}}
        else if(value.command==PrepareDepth){auto flight=std::make_unique<ServiceFlight>();flight->replyPort=client;flight->request=value.request;flight->active=&active;
            active.fetch_add(1);const auto accepted=provider&&prepareDepth?prepareDepth(provider,value.count,value.reset,serviceDone,flight.get()):ML_NEURAL_INVALID;
            if(accepted==ML_NEURAL_RENDERED)flight.release();else{reply(client,value.request,ML_NEURAL_FAILED,"The neural provider cannot prepare this scalar inference grid");active.fetch_sub(1);}
        }
        else if(value.command==Submit||value.command==SubmitBatch||value.command==SubmitScene||value.command==SubmitTimed){auto flight=std::make_unique<ServiceFlight>();flight->replyPort=client;flight->request=value.request;flight->active=&active;flight->timed=value.command==SubmitTimed;flight->token=flight->timed?envelope.token:0;flight->timing.size=sizeof(flight->timing);flight->timing.version=1;flight->timing.job_token=flight->token;flight->timing.status=2;
            if(value.body.msgh_descriptor_count==6){
                flight->source=pixel(value.ports[0].name);
                if((value.command==SubmitBatch||value.command==SubmitTimed)&&value.count>0&&value.count<=4){flight->next=pixel(value.ports[1].name);for(unsigned i=0;i<value.count;++i)flight->outputs.push_back(pixel(value.ports[2+i].name));flight->destination=flight->outputs[0];}
                else{flight->destination=pixel(value.ports[1].name);if(value.command==SubmitScene)flight->guides=pixel(value.ports[2].name);else flight->next=pixel(value.ports[2].name);}
                flight->event=[device newSharedEvent];flight->event.signaledValue=value.producer;
            }
            MLNeuralFrameV2 frame{};frame.size=sizeof(frame);frame.version=2;frame.source=flight->source;frame.destination=flight->destination;frame.next_source=flight->next;frame.shared_event=(__bridge void*)flight->event;frame.producer_value=value.producer;frame.done_value=value.done;frame.frame_id=value.frame;frame.next_frame_id=value.next;frame.phase=value.phase;frame.reset_history=value.reset;
            std::vector<const void*> targets;for(auto image:flight->outputs)targets.push_back(image);
            MLNeuralSceneFrameV3 scene{};scene.size=sizeof(scene);scene.version=3;scene.frame=frame;scene.guides=flight->guides;
            active.fetch_add(1);const auto accepted=provider?(flight->timed?(value.header.msgh_size==sizeof(TimedMessage)&&flight->token&&timingSupported&&timingSupported(provider)==1?(value.count?(submitBatchTimed?submitBatchTimed(provider,&frame,targets.data(),value.phases,value.count,flight->token,serviceTiming,serviceDone,flight.get()):ML_NEURAL_INVALID):(submitTimed?submitTimed(provider,&frame,flight->token,serviceTiming,serviceDone,flight.get()):ML_NEURAL_INVALID)):ML_NEURAL_INVALID):value.command==SubmitScene?(submitScene?submitScene(provider,&scene,serviceDone,flight.get()):ML_NEURAL_INVALID):value.command==SubmitBatch?(submitBatch?submitBatch(provider,&frame,targets.data(),value.phases,value.count,serviceDone,flight.get()):ML_NEURAL_INVALID):submit(provider,&frame,serviceDone,flight.get())):ML_NEURAL_CLOSED;
            if(accepted==ML_NEURAL_RENDERED)flight.release();else{reply(client,value.request,ML_NEURAL_FAILED,"The neural service rejected this image contract");active.fetch_sub(1);}
        }
        releaseRights(value);
    }
    if(provider&&destroy)destroy(provider);mach_port_destroy(mach_task_self(),local);mach_port_deallocate(mach_task_self(),client);return 0;
}}
#endif
