// Copyright (c) MacLauncher contributors. MIT license.
#include "xess-wire.hpp"
#include "xess-fg-protocol.h"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include <servers/bootstrap.h>
#include <unistd.h>
#include <signal.h>
#include <array>
#include <algorithm>
#include <deque>
#include <map>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <thread>
#include <cstring>
#include <cstdio>
#include <poll.h>
#include <pthread/qos.h>
using namespace macfx::xess;
namespace {
struct Job {MLXessCall call{};std::array<IOSurfaceRef,3> surfaces{};std::array<id<MTLTexture>,3> images{};~Job(){for(auto surface:surfaces)if(surface)CFRelease(surface);}};
struct Buffers {std::array<id<MTLBuffer>,5> images{};std::array<MLXessMapping,5> mappings{};};
struct Broker {
    mach_port_t local=receiver(),remote=0;pid_t client=0,parent=getppid();bool brokerOwned=false;
    std::mutex lock;std::condition_variable changed;bool closed=false,configurePending=false,admitPending=false,configured=false;
    MLXessCall configuration{};std::deque<std::shared_ptr<Job>> waiting;std::map<uint64_t,std::shared_ptr<Job>> active;
    std::array<Buffers,ML_XESS_SLOTS> buffers;std::array<bool,ML_XESS_SLOTS> free{{true,true,true}};
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();id<MTLCommandQueue> queue;id<MTLComputePipelineState> guides,packColor,unpackColor;id activity;
    Broker(const char *name,const char *token){
        if(!device||bootstrap_look_up(bootstrap_port,name,&remote)!=KERN_SUCCESS)throw std::runtime_error("The XeSS client endpoint is unavailable");
        activity=[NSProcessInfo.processInfo beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep|NSActivityLatencyCritical reason:@"Live GPU scene reconstruction"];
        queue=[device newCommandQueue];NSError *error=nil;
        auto library=[device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void unpack(texture2d<float,access::read> guides [[texture(0)]],device uchar *motion [[buffer(0)]],device uchar *depth [[buffer(1)]],device uchar *reactive [[buffer(2)]],constant uint4 &c [[buffer(3)]],constant uint &reactiveStride [[buffer(4)]],uint2 p [[thread_position_in_grid]]){if(any(p>=c.xy))return;float4 value=guides.read(p);*((device float2*)(motion+p.y*c.z+p.x*8))=value.xy;*((device float*)(depth+p.y*c.w+p.x*4))=value.z;*((device half*)(reactive+p.y*reactiveStride+p.x*2))=half(clamp(value.w,0.0f,1.0f));}" options:nil error:&error];
        if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare XeSS GPU guide transport");
        guides=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"unpack"] error:&error];
        auto colorLibrary=[device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void pack_color(texture2d<float,access::read>source[[texture(0)]],device uchar*target[[buffer(0)]],constant uint4&c[[buffer(1)]],uint2 p[[thread_position_in_grid]]){if(any(p>=c.xy))return;float4 v=clamp(source.read(p),0.0f,1.0f);device uint*pixel=(device uint*)(target+p.y*c.z+p.x*4);if(c.w){uint4 q=uint4(round(v*float4(1023,1023,1023,3)));*pixel=q.x|(q.y<<10)|(q.z<<20)|(q.w<<30);}else{uint4 q=uint4(round(v*255));*pixel=q.x|(q.y<<8)|(q.z<<16)|(q.w<<24);}}kernel void unpack_color(device const uchar*source[[buffer(0)]],texture2d<float,access::write>target[[texture(0)]],constant uint4&c[[buffer(1)]],uint2 p[[thread_position_in_grid]]){if(any(p>=c.xy))return;uint v=*((device const uint*)(source+p.y*c.z+p.x*4));float4 q=c.w?float4(v&1023,(v>>10)&1023,(v>>20)&1023,v>>30)/float4(1023,1023,1023,3):float4(v&255,(v>>8)&255,(v>>16)&255,v>>24)/255;target.write(q,p);}" options:nil error:&error];
        if(!colorLibrary)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare generation color transport");packColor=[device newComputePipelineStateWithFunction:[colorLibrary newFunctionWithName:@"pack_color"] error:&error];unpackColor=[device newComputePipelineStateWithFunction:[colorLibrary newFunctionWithName:@"unpack_color"] error:&error];if(!packColor||!unpackColor)throw std::runtime_error("Cannot prepare generation color pipelines");
        if(!guides||!queue)throw std::runtime_error("Cannot prepare XeSS GPU queues");
        brokerOwned=token&&*token;if(brokerOwned){if(std::strlen(token)!=64||std::strspn(token,"0123456789abcdef")!=64)throw std::runtime_error("The XeSS broker token is invalid");}
        Wire hello{};hello.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;hello.body.msgh_descriptor_count=3;for(auto &entry:hello.ports)right(entry,0);right(hello.ports[0],local);hello.call.size=sizeof(MLXessCall);hello.call.version=ML_XESS_VERSION;hello.call.command=ML_XESS_HELLO;hello.call.process=getpid();if(brokerOwned)strlcpy(hello.call.message,token,sizeof(hello.call.message));
        if(send(hello,remote)!=KERN_SUCCESS)throw std::runtime_error("Cannot connect the XeSS GPU service");
        std::thread([this]{@autoreleasepool{listen();}}).detach();
    }
    void reply(MLXessCall call,int status,const char *message=""){
        call.status=status;strlcpy(call.message,message?message:"",sizeof(call.message));Reply value{};value.call=call;send(value,remote);
    }
    void finish(const std::shared_ptr<Job>&job,int status,const char *message=""){
        reply(job->call,status,message);std::lock_guard guard(lock);active.erase(job->call.request);free[job->call.slot]=true;changed.notify_all();
    }
    void listen(){for(;;){Wire wire{};pid_t sender=0;auto status=receive(wire,local,1000,client,&sender);
        if(status==MACH_RCV_TIMED_OUT){mach_port_type_t type=0;const bool dead=mach_port_type(mach_task_self(),remote,&type)!=KERN_SUCCESS||(type&MACH_PORT_TYPE_DEAD_NAME);pollfd ownerPipe{STDOUT_FILENO,POLLERR|POLLHUP,0};const bool brokerGone=brokerOwned&&poll(&ownerPipe,1,0)>0&&(ownerPipe.revents&(POLLERR|POLLHUP));if(dead||brokerGone||brokerOwned&&parent>1&&getppid()!=parent){std::lock_guard guard(lock);closed=true;changed.notify_all();return;}continue;}
        if(status!=KERN_SUCCESS)continue;
        auto call=wire.call;
        if(call.size!=sizeof(call)||call.version!=ML_XESS_VERSION||wire.body.msgh_descriptor_count!=3){release(wire);continue;}
        if(!client)client=sender;
        if(call.command==ML_XESS_CLOSE){release(wire);std::lock_guard guard(lock);closed=true;changed.notify_all();return;}
        if(call.command==ML_XESS_ADMIT){release(wire);std::lock_guard guard(lock);admitPending=true;changed.notify_all();continue;}
        if(call.command==ML_XESS_CONFIGURE){release(wire);std::lock_guard guard(lock);if(configured||configurePending){reply(call,-1,"The XeSS owner is already configured");continue;}configuration=call;configurePending=true;changed.notify_all();continue;}
        if(call.command!=ML_XESS_FRAME){release(wire);continue;}
        auto job=std::make_shared<Job>();job->call=call;bool valid=true;
        for(unsigned i=0;i<3;++i){if(wire.ports[i].name)job->surfaces[i]=IOSurfaceLookupFromMachPort(wire.ports[i].name);if(!job->surfaces[i])valid=false;}
        release(wire);
        const uint32_t widths[]={configuration.inputWidth,configuration.inputWidth,configuration.outputWidth},heights[]={configuration.inputHeight,configuration.inputHeight,configuration.outputHeight};
        for(unsigned i=0;i<3&&valid;++i){const auto format=i==1?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float;const uint32_t pixel=i==1?0x52476641:0x52476841;
            if(IOSurfaceGetWidth(job->surfaces[i])!=widths[i]||IOSurfaceGetHeight(job->surfaces[i])!=heights[i]||IOSurfaceGetPixelFormat(job->surfaces[i])!=pixel){valid=false;break;}
            auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:widths[i] height:heights[i] mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;job->images[i]=[device newTextureWithDescriptor:descriptor iosurface:job->surfaces[i] plane:0];valid=job->images[i]!=nil;
        }
        std::lock_guard guard(lock);
        if(!valid||!configured||closed||call.inputWidth!=configuration.inputWidth||call.inputHeight!=configuration.inputHeight||call.outputWidth!=configuration.outputWidth||call.outputHeight!=configuration.outputHeight){reply(call,-1,"XeSS received incompatible scene surfaces");continue;}
        if(active.size()+waiting.size()>=ML_XESS_SLOTS){reply(call,1,"The XeSS GPU queue is full");continue;}
        waiting.push_back(job);changed.notify_all();
    }}
    int next(MLXessCall &call){std::unique_lock guard(lock);changed.wait(guard,[&]{return closed||configurePending||admitPending||!waiting.empty()&&std::any_of(free.begin(),free.end(),[](bool value){return value;});});
        if(closed){call.command=ML_XESS_CLOSE;return 0;}
        if(configurePending){call=configuration;configurePending=false;return 0;}
        if(admitPending){call=configuration;call.command=ML_XESS_ADMIT;admitPending=false;return 0;}
        auto job=waiting.front();waiting.pop_front();unsigned slot=0;while(!free[slot])++slot;free[slot]=false;job->call.slot=slot;active.emplace(job->call.request,job);call=job->call;return 0;
    }
    std::shared_ptr<Job> job(uint64_t request){std::lock_guard guard(lock);auto found=active.find(request);return found==active.end()?nullptr:found->second;}
    int bind(const MLXessCall &call){if(call.slot>=ML_XESS_SLOTS)return -1;Buffers result;
        const uint32_t colorBytes=configuration.flags&ML_XESS_FLAG_FRAME_GENERATION?4:8;
        const uint32_t width[]={configuration.inputWidth,configuration.inputWidth,configuration.inputWidth,configuration.inputWidth,configuration.outputWidth},height[]={configuration.inputHeight,configuration.inputHeight,configuration.inputHeight,configuration.inputHeight,configuration.outputHeight},element[]={colorBytes,8,4,2,colorBytes};
        for(unsigned i=0;i<5;++i){const auto &map=call.mappings[i];if(!map.address||map.address%getpagesize()||map.bytes%getpagesize()||map.rowPitch<uint64_t(width[i])*element[i]||map.bytes<uint64_t(map.rowPitch)*height[i])return -1;
            result.images[i]=[device newBufferWithBytesNoCopy:reinterpret_cast<void*>(map.address) length:map.bytes options:MTLResourceStorageModeShared deallocator:nil];if(!result.images[i])return -1;result.mappings[i]=map;
        }
        buffers[call.slot]=std::move(result);return 0;
    }
    int ingress(MLXessCall &call){auto selected=job(call.request);if(!selected||call.slot>=ML_XESS_SLOTS)return -1;auto &bound=buffers[call.slot];auto command=[queue commandBuffer];id<MTLBlitCommandEncoder> blit=nil;
        if(configuration.flags&ML_XESS_FLAG_FRAME_GENERATION){auto pack=[command computeCommandEncoder];if(!pack)return -1;const uint32_t control[]={configuration.inputWidth,configuration.inputHeight,bound.mappings[0].rowPitch,uint32_t(bool(configuration.flags&ML_XESS_FLAG_GENERATION_HDR10))};[pack setComputePipelineState:packColor];[pack setTexture:selected->images[0] atIndex:0];[pack setBuffer:bound.images[0] offset:0 atIndex:0];[pack setBytes:control length:sizeof(control) atIndex:1];[pack dispatchThreads:MTLSizeMake(configuration.inputWidth,configuration.inputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[pack endEncoding];}
        else{blit=[command blitCommandEncoder];
        [blit copyFromTexture:selected->images[0] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(configuration.inputWidth,configuration.inputHeight,1) toBuffer:bound.images[0] destinationOffset:0 destinationBytesPerRow:bound.mappings[0].rowPitch destinationBytesPerImage:uint64_t(bound.mappings[0].rowPitch)*configuration.inputHeight];[blit endEncoding];
        }
        auto encoder=[command computeCommandEncoder];if(!command||!(configuration.flags&ML_XESS_FLAG_FRAME_GENERATION)&&!blit||!encoder)return -1;uint32_t control[]={configuration.inputWidth,configuration.inputHeight,bound.mappings[1].rowPitch,bound.mappings[2].rowPitch};[encoder setComputePipelineState:guides];[encoder setTexture:selected->images[1] atIndex:0];[encoder setBuffer:bound.images[1] offset:0 atIndex:0];[encoder setBuffer:bound.images[2] offset:0 atIndex:1];[encoder setBuffer:bound.images[3] offset:0 atIndex:2];[encoder setBytes:control length:sizeof(control) atIndex:3];const uint32_t reactiveStride=bound.mappings[3].rowPitch;[encoder setBytes:&reactiveStride length:4 atIndex:4];[encoder dispatchThreads:MTLSizeMake(configuration.inputWidth,configuration.inputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        // Only the separate PE worker waits for this metadata handoff. The
        // caller's game thread and borrowed Metal command buffer never wait on CPU.
        auto finished=dispatch_semaphore_create(0);__block bool okay=false;
        [command addCompletedHandler:^(id<MTLCommandBuffer> done){okay=done.status==MTLCommandBufferStatusCompleted;selected->call.sourceCopyMs=(done.GPUEndTime-done.GPUStartTime)*1000;dispatch_semaphore_signal(finished);}];[command commit];dispatch_semaphore_wait(finished,DISPATCH_TIME_FOREVER);return okay?0:-1;
    }
    int egress(const MLXessCall &call){auto selected=job(call.request);if(!selected||call.slot>=ML_XESS_SLOTS)return -1;auto &bound=buffers[call.slot];selected->call.flags=(selected->call.flags&~ML_XESS_FLAG_GENERATED)|(call.flags&ML_XESS_FLAG_GENERATED);selected->call.inputCopyMs=call.inputCopyMs;selected->call.inferenceMs=call.inferenceMs;selected->call.outputCopyMs=0;
        auto command=[queue commandBuffer];id<MTLBlitCommandEncoder>blit=nil;
        if(configuration.flags&ML_XESS_FLAG_FRAME_GENERATION){auto unpack=[command computeCommandEncoder];if(!unpack)return -1;const uint32_t control[]={configuration.outputWidth,configuration.outputHeight,bound.mappings[4].rowPitch,uint32_t(bool(configuration.flags&ML_XESS_FLAG_GENERATION_HDR10))};[unpack setComputePipelineState:unpackColor];[unpack setTexture:selected->images[2] atIndex:0];[unpack setBuffer:bound.images[4] offset:0 atIndex:0];[unpack setBytes:control length:sizeof(control) atIndex:1];[unpack dispatchThreads:MTLSizeMake(configuration.outputWidth,configuration.outputHeight,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[unpack endEncoding];}
        else{blit=[command blitCommandEncoder];[blit copyFromBuffer:bound.images[4] sourceOffset:0 sourceBytesPerRow:bound.mappings[4].rowPitch sourceBytesPerImage:uint64_t(bound.mappings[4].rowPitch)*configuration.outputHeight sourceSize:MTLSizeMake(configuration.outputWidth,configuration.outputHeight,1) toTexture:selected->images[2] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[blit endEncoding];
        }
        if(!command||!(configuration.flags&ML_XESS_FLAG_FRAME_GENERATION)&&!blit)return -1;[command addCompletedHandler:^(id<MTLCommandBuffer> done){selected->call.outputCopyMs=done.GPUStartTime>0&&done.GPUEndTime>=done.GPUStartTime?(done.GPUEndTime-done.GPUStartTime)*1000:-1;finish(selected,done.status==MTLCommandBufferStatusCompleted?0:-1,done.error.localizedDescription.UTF8String?:"");}];[command commit];return 0;
    }
};
Broker *broker=nullptr;
int entry(void *pointer,unsigned command){@autoreleasepool{thread_local bool initiated=false;if(!initiated){pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED,0);initiated=true;}auto &call=*static_cast<MLXessCall*>(pointer);try{
    if(command==ML_XESS_INIT){if(broker||call.endpoint[0]==0)return -1;broker=new Broker(call.endpoint,call.message);call.process=getpid();return 0;}if(!broker)return -1;
    if(command==ML_XESS_NEXT)return broker->next(call);
    if(command==ML_XESS_READY){{std::lock_guard guard(broker->lock);broker->configured=call.status==0;}broker->reply(call,call.status,call.message);return 0;}
    if(command==ML_XESS_BIND)return broker->bind(call);
    if(command==ML_XESS_INGRESS)return broker->ingress(call);
    if(command==ML_XESS_EGRESS)return broker->egress(call);
    if(command==ML_XESS_FAILURE){auto job=broker->job(call.request);if(job)broker->finish(job,-1,call.message);return 0;}
    return -1;
}catch(const std::exception &error){strlcpy(call.message,error.what(),sizeof(call.message));return -1;}}}
int init(void*p){return entry(p,ML_XESS_INIT);}int next(void*p){return entry(p,ML_XESS_NEXT);}int ready(void*p){return entry(p,ML_XESS_READY);}int bind(void*p){return entry(p,ML_XESS_BIND);}int ingress(void*p){return entry(p,ML_XESS_INGRESS);}int egress(void*p){return entry(p,ML_XESS_EGRESS);}int failure(void*p){return entry(p,ML_XESS_FAILURE);}
}
extern "C" {__attribute__((visibility("default"))) int(*__wine_unix_call_funcs[])(void*)={init,next,ready,bind,ingress,egress,failure};__attribute__((visibility("default"))) int(*__wine_unix_call_wow64_funcs[])(void*)={init,next,ready,bind,ingress,egress,failure};}
