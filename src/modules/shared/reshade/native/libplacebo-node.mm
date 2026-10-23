// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "libplacebo-node.hpp"
#include <libplacebo/renderer.h>
#include <libplacebo/filters.h>
#include <libplacebo/vulkan.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>
#include <cstdio>
extern "C" void vkGetMTLDeviceMVK(VkPhysicalDevice,id<MTLDevice>*);
namespace {
using namespace macfx;
thread_local std::string lastError,inspection;
#if defined(MACFX_LIBPLACEBO_TESTING)
// Only the standalone regression includes this source with the testing define.
// The normal provider has no fault switch or injected branch.
std::atomic<bool> failNextAsyncWork{false};
#endif
const pl_filter_config *filterConfig(const char *name){
    if(name)for(const auto *const *item=pl_filter_configs;*item;++item)if((*item)->name&&std::string(name)==(*item)->name&&((*item)->allowed&PL_FILTER_SCALING))return *item;
    throw std::runtime_error("The selected libplacebo scaling filter is unavailable.");
}
std::string readSource(const char *path){
    if(!path||*path!='/')throw std::runtime_error("The shader needs an absolute prepared file path.");
    std::ifstream file(path,std::ios::binary|std::ios::ate);if(!file||file.tellg()<1||file.tellg()>16*1024*1024)throw std::runtime_error("The shader source is unavailable or too large.");
    std::string source(size_t(file.tellg()),'\0');file.seekg(0);if(!file.read(source.data(),source.size()))throw std::runtime_error("The shader source could not be read.");return source;
}
void check(VkResult result,const char *message){if(result!=VK_SUCCESS)throw std::runtime_error(std::string(message)+" (Vulkan "+std::to_string(result)+").");}
struct Context {
    id<MTLDevice> device;
    id<MTLCommandQueue> repairQueue;
    id<MTLLibrary> repairLibrary;
    std::map<MTLPixelFormat,id<MTLRenderPipelineState>> repairPipelines;
    pl_log log=nullptr;pl_vk_inst instance=nullptr;pl_vulkan vulkan=nullptr;
    std::mutex lock,logLock;std::string failure;
    explicit Context(id<MTLDevice> wanted):device(wanted){try{
        pl_log_params logging{};logging.log_level=PL_LOG_WARN;logging.log_priv=this;
        logging.log_cb=[](void *self,pl_log_level,const char *message){auto &context=*static_cast<Context*>(self);std::lock_guard<std::mutex> guard(context.logLock);context.failure=message?message:"libplacebo failed";};
        log=pl_log_create(PL_API_VER,&logging);auto parameters=pl_vk_inst_default_params;parameters.get_proc_addr=vkGetInstanceProcAddr;
        instance=pl_vk_inst_create(log,&parameters);if(!instance)throw std::runtime_error("A Vulkan instance could not be created.");
        uint32_t count=0;check(vkEnumeratePhysicalDevices(instance->instance,&count,nullptr),"GPU enumeration failed");std::vector<VkPhysicalDevice> devices(count);check(vkEnumeratePhysicalDevices(instance->instance,&count,devices.data()),"GPU enumeration failed");VkPhysicalDevice selected{};
        for(auto candidate:devices){id<MTLDevice> actual=nil;vkGetMTLDeviceMVK(candidate,&actual);if(actual&&actual.registryID==wanted.registryID){selected=candidate;break;}}
        if(!selected)throw std::runtime_error("The shader provider cannot share the current Metal device.");
        const char *extensions[]={VK_EXT_METAL_OBJECTS_EXTENSION_NAME};auto settings=pl_vulkan_default_params;settings.instance=instance->instance;settings.get_proc_addr=vkGetInstanceProcAddr;settings.device=selected;
        settings.async_compute=false;settings.async_transfer=false;settings.queue_count=1;settings.extensions=extensions;settings.num_extensions=1;
        vulkan=pl_vulkan_create(log,&settings);if(!vulkan)throw std::runtime_error(failure.empty()?"The shared GPU shader device could not be created.":failure);
        if(!(vulkan->gpu->import_caps.tex&PL_HANDLE_MTL_TEX))throw std::runtime_error("This GPU cannot import Metal textures.");
    }catch(...){destroy();throw;}}
    void destroy(){if(vulkan)pl_vulkan_destroy(&vulkan);if(instance)pl_vk_inst_destroy(&instance);if(log)pl_log_destroy(&log);}
    ~Context(){destroy();}
    pl_gpu gpu()const{return vulkan->gpu;}
    // Called while the shared GPU owner is locked. Initialize a complete
    // passthrough before foreign work, and repair it after a failed provider
    // finishes, so cancellation and partial writes cannot publish undefined data.
    void passthrough(id<MTLCommandBuffer> commands,id<MTLTexture> source,id<MTLTexture> target){
        if(source.width==target.width&&source.height==target.height&&source.pixelFormat==target.pixelFormat){
            auto blit=[commands blitCommandEncoder];if(!blit)throw std::runtime_error("Cannot preserve the original shader frame.");
            [blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(source.width,source.height,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[blit endEncoding];return;
        }
        auto &pipeline=repairPipelines[target.pixelFormat];if(!pipeline){
            NSError *error=nil;
            if(!repairLibrary)repairLibrary=[device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;struct V{float4 p[[position]];float2 uv;};vertex V pass_vertex(uint i[[vertex_id]]){float2 q=float2((i<<1)&2,i&2);return {float4(q*2-1,0,1),float2(q.x,1-q.y)};}fragment float4 pass_fragment(V v[[stage_in]],texture2d<float> source[[texture(0)]]){constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);return source.sample(s,v.uv);}" options:nil error:&error];
            if(!repairLibrary)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare shader passthrough.");
            auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[repairLibrary newFunctionWithName:@"pass_vertex"];descriptor.fragmentFunction=[repairLibrary newFunctionWithName:@"pass_fragment"];descriptor.colorAttachments[0].pixelFormat=target.pixelFormat;
            pipeline=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!pipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare shader passthrough.");
        }
        auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=target;pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
        auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)throw std::runtime_error("Cannot preserve the original shader image.");
        [encoder setRenderPipelineState:pipeline];[encoder setFragmentTexture:source atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
    }
};
std::shared_ptr<Context> context(id<MTLDevice> device){
    static std::mutex lock;static std::map<uint64_t,std::weak_ptr<Context>> owners;std::lock_guard<std::mutex> guard(lock);
    auto &owner=owners[device.registryID];if(auto current=owner.lock())return current;auto created=std::make_shared<Context>(device);owner=created;return created;
}
VkFormat pixelFormat(MTLPixelFormat format){switch(format){
    case MTLPixelFormatRGBA8Unorm:return VK_FORMAT_R8G8B8A8_UNORM;case MTLPixelFormatBGRA8Unorm:return VK_FORMAT_B8G8R8A8_UNORM;
    case MTLPixelFormatRGBA8Unorm_sRGB:return VK_FORMAT_R8G8B8A8_SRGB;case MTLPixelFormatBGRA8Unorm_sRGB:return VK_FORMAT_B8G8R8A8_SRGB;
    case MTLPixelFormatRGBA16Float:return VK_FORMAT_R16G16B16A16_SFLOAT;case MTLPixelFormatRGBA32Float:return VK_FORMAT_R32G32B32A32_SFLOAT;
    case MTLPixelFormatRGB10A2Unorm:return VK_FORMAT_A2B10G10R10_UNORM_PACK32;default:throw std::runtime_error("The shader provider does not support this Metal texture format.");}}
bool srgb(MTLPixelFormat format){return format==MTLPixelFormatRGBA8Unorm_sRGB||format==MTLPixelFormatBGRA8Unorm_sRGB;}
struct Imported {
    std::shared_ptr<Context> owner;id<MTLTexture> metal;VkImage image{};pl_tex texture=nullptr;
    Imported(std::shared_ptr<Context> ctx,id<MTLTexture> value,bool target):owner(std::move(ctx)),metal(value){
        if(value.textureType!=MTLTextureType2D||value.sampleCount!=1)throw std::runtime_error("The shader provider requires a single-sample 2D texture.");
        VkImportMetalTextureInfoEXT external{VK_STRUCTURE_TYPE_IMPORT_METAL_TEXTURE_INFO_EXT};external.plane=VK_IMAGE_ASPECT_COLOR_BIT;external.mtlTexture=value;
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};info.pNext=&external;info.imageType=VK_IMAGE_TYPE_2D;info.format=pixelFormat(value.pixelFormat);info.extent={uint32_t(value.width),uint32_t(value.height),1};info.mipLevels=1;info.arrayLayers=1;info.samples=VK_SAMPLE_COUNT_1_BIT;info.tiling=VK_IMAGE_TILING_OPTIMAL;info.sharingMode=VK_SHARING_MODE_EXCLUSIVE;
        info.usage=target?VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT:VK_IMAGE_USAGE_SAMPLED_BIT;
        check(vkCreateImage(owner->vulkan->device,&info,nullptr,&image),"Metal texture import failed");
        pl_vulkan_wrap_params wrap{};wrap.image=image;wrap.width=value.width;wrap.height=value.height;wrap.format=info.format;wrap.usage=info.usage;
        texture=pl_vulkan_wrap(owner->gpu(),&wrap);if(!texture){vkDestroyImage(owner->vulkan->device,image,nullptr);image={};throw std::runtime_error("The Metal texture could not be wrapped for rendering.");}
    }
    ~Imported(){if(texture)pl_tex_destroy(owner->gpu(),&texture);if(image)vkDestroyImage(owner->vulkan->device,image,nullptr);}
};
pl_frame frame(pl_tex tex,FrameOrigin origin,SpatialColor color,bool hardwareSRGB=false,bool importedSource=false){
    pl_frame out{};out.num_planes=1;out.planes[0].texture=tex;out.planes[0].components=4;for(int i=0;i<4;++i)out.planes[0].component_mapping[i]=i;out.planes[0].flipped=origin==FrameOrigin::BottomLeft;
    // Imported source components follow their host storage order. libplacebo
    // uses sample_order to access them, then this mapping supplies their RGB
    // meaning. Render targets instead use canonical shader output components.
    if(importedSource)for(int i=0;i<4;++i)out.planes[0].component_mapping[i]=tex->params.format->sample_order[i];
    out.repr=pl_color_repr_rgb;out.repr.alpha=PL_ALPHA_INDEPENDENT;out.color=pl_color_space_srgb;
    if(color==SpatialColor::Linear||hardwareSRGB)out.color.transfer=PL_COLOR_TRC_LINEAR;return out;
}
void apply(const pl_hook *hook,const ShaderParameters &values,bool write=true){
    for(const auto &entry:values){const auto &name=entry.first;const auto &value=entry.second;const auto found=std::find_if(hook->parameters,hook->parameters+hook->num_parameters,[&](const auto &p){return p.name&&name==p.name;});if(found==hook->parameters+hook->num_parameters||value.size()!=1||!std::isfinite(value[0]))throw std::runtime_error("The shader parameter does not match its original declaration.");}
    std::vector<pl_var_data> validated;validated.reserve(hook->num_parameters);
    for(int i=0;i<hook->num_parameters;++i){const auto &p=hook->parameters[i];const auto value=values.find(p.name);const double n=value==values.end()?p.type==PL_VAR_FLOAT?p.initial.f:p.type==PL_VAR_UINT?p.initial.u:p.initial.i:value->second[0];pl_var_data out{};
        if(p.type==PL_VAR_FLOAT){if(n<p.minimum.f||n>p.maximum.f)throw std::runtime_error("A shader parameter is outside its original range.");out.f=n;}
        else if(p.type==PL_VAR_SINT){if(std::trunc(n)!=n||n<p.minimum.i||n>p.maximum.i)throw std::runtime_error("A shader parameter needs an integer in its original range.");out.i=n;}
        else if(p.type==PL_VAR_UINT){if(std::trunc(n)!=n||n<p.minimum.u||n>p.maximum.u)throw std::runtime_error("A shader parameter needs an unsigned integer in its original range.");out.u=n;}
        else throw std::runtime_error("The shader declares an unsupported parameter type.");validated.push_back(out);
    }
    // Reject the whole change before touching the current hook's controls.
    if(write)for(int i=0;i<hook->num_parameters;++i)*hook->parameters[i].data=validated[i];
}
bool rgbHook(const pl_hook *hook){return hook->stages&(PL_HOOK_RGB_INPUT|PL_HOOK_NATIVE|PL_HOOK_RGB|PL_HOOK_LINEAR|PL_HOOK_SIGMOID|PL_HOOK_PRE_KERNEL|PL_HOOK_POST_KERNEL|PL_HOOK_SCALED|PL_HOOK_PRE_OUTPUT|PL_HOOK_OUTPUT);}
void render(pl_renderer renderer,const pl_hook *hook,const pl_frame &source,const pl_frame &target,const pl_filter_config *filter=nullptr){
    auto parameters=pl_render_fast_params;parameters.hooks=hook?&hook:nullptr;parameters.num_hooks=hook?1:0;parameters.dither_params=nullptr;parameters.background=PL_CLEAR_SKIP;parameters.background_transparency=1;
    if(filter){
        const bool up=source.planes[0].texture->params.w<target.planes[0].texture->params.w||source.planes[0].texture->params.h<target.planes[0].texture->params.h;
        const bool down=source.planes[0].texture->params.w>target.planes[0].texture->params.w||source.planes[0].texture->params.h>target.planes[0].texture->params.h;
        if(up&&!(filter->allowed&PL_FILTER_UPSCALING)||down&&!(filter->allowed&PL_FILTER_DOWNSCALING))throw std::runtime_error("The selected libplacebo filter does not support this scaling direction.");
        parameters.upscaler=filter->allowed&PL_FILTER_UPSCALING?filter:nullptr;parameters.downscaler=filter->allowed&PL_FILTER_DOWNSCALING?filter:nullptr;parameters.antiringing_strength=filter->antiring;
    }
    if(!pl_render_image(renderer,&source,&target,&parameters)||pl_renderer_get_errors(renderer).errors!=PL_RENDER_ERR_NONE)throw std::runtime_error("The original shader renderer rejected this RGB frame.");
}
struct Slot {
    std::shared_ptr<Context> owner;id<MTLSharedEvent> event;VkSemaphore semaphore{};uint64_t counter=0;bool busy=false;
    explicit Slot(std::shared_ptr<Context> value):owner(std::move(value)){
        event=[owner->device newSharedEvent];if(!event)throw std::runtime_error("A shared GPU event could not be created.");
        VkImportMetalSharedEventInfoEXT external{VK_STRUCTURE_TYPE_IMPORT_METAL_SHARED_EVENT_INFO_EXT};external.mtlSharedEvent=event;
        VkSemaphoreTypeCreateInfo type{VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO};type.pNext=&external;type.semaphoreType=VK_SEMAPHORE_TYPE_TIMELINE;
        VkSemaphoreCreateInfo info{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};info.pNext=&type;check(vkCreateSemaphore(owner->vulkan->device,&info,nullptr,&semaphore),"Shared GPU event import failed");
    }
    ~Slot(){if(semaphore)vkDestroySemaphore(owner->vulkan->device,semaphore,nullptr);}
};
struct State;
struct Work:std::enable_shared_from_this<Work> {
    std::shared_ptr<State> state;std::shared_ptr<Slot> slot;std::shared_ptr<Imported> source,target;std::shared_ptr<const ShaderParameters> parameters;
    FrameOrigin origin;SpatialColor color;uint64_t input,sourceDone,output;std::atomic<unsigned> phase{0};std::atomic<bool> finishing{false},metalDone{false},runDone{false},finishDone{false},retired{false};
    ~Work();void run();void cancel();void complete();void retire();void finishFailed();
};
struct State {
    std::shared_ptr<Context> owner;std::mutex lock;pl_renderer renderer=nullptr;const pl_hook *hook=nullptr;const pl_filter_config *filter=nullptr;
    std::vector<std::shared_ptr<Slot>> slots;std::map<std::pair<void*,bool>,std::shared_ptr<Imported>> imports;std::string failure;
    explicit State(std::shared_ptr<Context> ctx,const std::string &source,const pl_filter_config *scaler=nullptr):owner(std::move(ctx)),filter(scaler){
        std::lock_guard<std::mutex> guard(owner->lock);if(!filter){hook=pl_mpv_user_shader_parse(owner->gpu(),source.data(),source.size());if(!hook)throw std::runtime_error("The original shader parser rejected this file.");
        if(!rgbHook(hook)){pl_mpv_user_shader_destroy(&hook);throw std::runtime_error("This shader has no hook applicable to RGB game frames.");}}
        renderer=pl_renderer_create(owner->log,owner->gpu());if(!renderer){if(hook)pl_mpv_user_shader_destroy(&hook);throw std::runtime_error("The shader renderer could not be created.");}
    }
    ~State(){std::lock_guard<std::mutex> guard(owner->lock);if(renderer)pl_renderer_destroy(&renderer);if(hook)pl_mpv_user_shader_destroy(&hook);imports.clear();slots.clear();}
    std::shared_ptr<Imported> imported(id<MTLTexture> value,bool target){const auto key=std::make_pair((__bridge void*)value,target);const auto found=imports.find(key);if(found!=imports.end())return found->second;auto result=std::make_shared<Imported>(owner,value,target);if(imports.size()>=12)imports.clear();imports[key]=result;return result;}
};
MTLSharedEventListener *listener(){static MTLSharedEventListener *value=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE,0)];return value;}
Work::~Work(){if(state&&slot&&!retired.exchange(true)){std::lock_guard<std::mutex> guard(state->lock);slot->busy=false;}}
void Work::retire(){if(metalDone&&runDone&&(!finishing||finishDone)&&!retired.exchange(true)){std::lock_guard<std::mutex> guard(state->lock);slot->busy=false;}}
void Work::complete(){if(phase==0)cancel();metalDone=true;retire();}
void Work::finishFailed(){if(finishing.exchange(true))return;auto retained=shared_from_this();dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
    try{std::lock_guard<std::mutex> guard(retained->state->owner->lock);auto &owner=*retained->state->owner;pl_gpu_finish(owner.gpu());
        if(!owner.repairQueue)owner.repairQueue=[owner.device newCommandQueue];auto commands=[owner.repairQueue commandBuffer];if(!commands)throw std::runtime_error("Cannot restore the shader frame after a GPU failure.");
        owner.passthrough(commands,retained->source->metal,retained->target->metal);[commands encodeSignalEvent:retained->slot->event value:retained->output];
        [commands addCompletedHandler:^(id<MTLCommandBuffer>){retained->slot->event.signaledValue=std::max(retained->slot->event.signaledValue,retained->output);retained->finishDone=true;retained->runDone=true;retained->retire();}];[commands commit];
    }catch(const std::exception &error){{std::lock_guard<std::mutex>guard(retained->state->lock);retained->state->failure=error.what();}retained->slot->event.signaledValue=std::max(retained->slot->event.signaledValue,retained->output);retained->finishDone=true;retained->runDone=true;retained->retire();}
});}
void Work::cancel(){const auto previous=phase.exchange(2);if(previous==0){slot->event.signaledValue=std::max(slot->event.signaledValue,output);}else if(previous==1)finishFailed();}
void Work::run(){
    unsigned expected=0;if(!phase.compare_exchange_strong(expected,1)){runDone=true;retire();return;}
    try{std::lock_guard<std::mutex> guard(state->owner->lock);
#if defined(MACFX_LIBPLACEBO_TESTING)
        if(failNextAsyncWork.exchange(false))throw std::runtime_error("Injected asynchronous shader failure");
#endif
        if(state->hook)apply(state->hook,*parameters);
        pl_vulkan_release_params release{};release.layout=VK_IMAGE_LAYOUT_GENERAL;release.qf=VK_QUEUE_FAMILY_IGNORED;release.semaphore={slot->semaphore,input};release.tex=source->texture;pl_vulkan_release_ex(state->owner->gpu(),&release);release.tex=target->texture;pl_vulkan_release_ex(state->owner->gpu(),&release);
        render(state->renderer,state->hook,frame(source->texture,origin,color,srgb(source->metal.pixelFormat),true),frame(target->texture,origin,color,srgb(target->metal.pixelFormat)),state->filter);
        pl_vulkan_hold_params hold{};hold.layout=VK_IMAGE_LAYOUT_GENERAL;hold.qf=VK_QUEUE_FAMILY_IGNORED;hold.tex=source->texture;hold.semaphore={slot->semaphore,sourceDone};if(!pl_vulkan_hold_ex(state->owner->gpu(),&hold))throw std::runtime_error("The input GPU texture could not be returned to Metal.");
        hold.tex=target->texture;hold.semaphore={slot->semaphore,output};if(!pl_vulkan_hold_ex(state->owner->gpu(),&hold))throw std::runtime_error("The output GPU texture could not be returned to Metal.");pl_gpu_flush(state->owner->gpu());
    }catch(const std::exception &error){std::lock_guard<std::mutex> guard(state->lock);state->failure=error.what();finishFailed();}
    if(!finishing){runDone=true;retire();}
}
void warm(const std::shared_ptr<State> &state,const std::string &source,const ShaderParameters &parameters,unsigned sourceWidth,unsigned sourceHeight,unsigned targetWidth,unsigned targetHeight,FrameOrigin origin,SpatialColor color){std::lock_guard<std::mutex> gpu(state->owner->lock);
            const pl_hook *test=state->filter?nullptr:pl_mpv_user_shader_parse(state->owner->gpu(),source.data(),source.size());if(!state->filter&&!test)throw std::runtime_error("The shader could not be prepared.");pl_renderer renderer=pl_renderer_create(state->owner->log,state->owner->gpu());pl_tex a=nullptr,b=nullptr;
            try{if(test)apply(test,parameters);pl_tex_params p{};p.w=sourceWidth;p.h=sourceHeight;p.format=pl_find_named_fmt(state->owner->gpu(),"rgba8");p.sampleable=true;p.renderable=true;a=pl_tex_create(state->owner->gpu(),&p);p.w=targetWidth;p.h=targetHeight;b=pl_tex_create(state->owner->gpu(),&p);if(!a||!b||!renderer)throw std::runtime_error("The shader preparation textures could not be allocated.");render(renderer,test,frame(a,origin,color),frame(b,origin,color),state->filter);pl_gpu_flush(state->owner->gpu());}
            catch(...){if(a)pl_tex_destroy(state->owner->gpu(),&a);if(b)pl_tex_destroy(state->owner->gpu(),&b);if(renderer)pl_renderer_destroy(&renderer);if(test)pl_mpv_user_shader_destroy(&test);throw;}
            pl_tex_destroy(state->owner->gpu(),&a);pl_tex_destroy(state->owner->gpu(),&b);pl_renderer_destroy(&renderer);if(test)pl_mpv_user_shader_destroy(&test);
        }

class Node final:public ShaderNode {
    std::string source;const pl_filter_config *filter=nullptr;mutable std::mutex lock;std::shared_ptr<State> state;std::shared_ptr<const ShaderParameters> parameters;
    unsigned preparedWidth=0,preparedHeight=0,preparedSourceWidth=0,preparedSourceHeight=0;MTLPixelFormat preparedFormat=MTLPixelFormatInvalid,preparedSourceFormat=MTLPixelFormatInvalid;FrameOrigin preparedOrigin{};SpatialColor preparedColor{};
public:
    explicit Node(const ShaderSpec &spec):source(readSource(spec.selection.file.c_str())),parameters(std::make_shared<const ShaderParameters>(spec.parameters)){}
    explicit Node(const char *name):filter(filterConfig(name)),parameters(std::make_shared<const ShaderParameters>()){}
    ShaderResult completion()const{
        std::lock_guard<std::mutex>guard(lock);
        if(!state)return {false,"The shader provider has no prepared frame.",false};
        std::lock_guard<std::mutex>gate(state->lock);
        return {state->failure.empty(),state->failure,false};
    }
    void setParameters(const ShaderParameters &value)override{std::lock_guard<std::mutex> guard(lock);if(*parameters==value)return;
        if(filter)throw std::runtime_error("This scaling filter uses its original built-in parameters.");
        if(state){bool compile=false;{std::lock_guard<std::mutex> gpu(state->owner->lock);apply(state->hook,value,false);
            for(int i=0;i<state->hook->num_parameters;++i){const auto &p=state->hook->parameters[i];if(p.mode!=PL_HOOK_PAR_CONSTANT&&p.mode!=PL_HOOK_PAR_DEFINE)continue;
                const auto previous=parameters->find(p.name),next=value.find(p.name);const float initial=p.type==PL_VAR_FLOAT?p.initial.f:p.type==PL_VAR_UINT?p.initial.u:p.initial.i;
                compile|=(previous==parameters->end()?initial:previous->second[0])!=(next==value.end()?initial:next->second[0]);}}
            if(compile)warm(state,source,value,preparedSourceWidth,preparedSourceHeight,preparedWidth,preparedHeight,preparedOrigin,preparedColor);
        }parameters=std::make_shared<const ShaderParameters>(value);
    }
    ShaderResult prepare(const ShaderFrame &input)override{try{
        if(!input.commands||!input.source||!input.target)return {false,"A shader needs separate input and output textures.",false};
        if(input.source.device.registryID!=input.target.device.registryID)return {false,"The shader input and output belong to different GPUs.",false};
        pixelFormat(input.source.pixelFormat);pixelFormat(input.target.pixelFormat);std::lock_guard<std::mutex> guard(lock);
        if(state&&state->owner->device.registryID==input.source.device.registryID&&preparedSourceWidth==input.source.width&&preparedSourceHeight==input.source.height&&preparedSourceFormat==input.source.pixelFormat&&preparedOrigin==input.origin&&preparedColor==input.color&&preparedWidth==input.target.width&&preparedHeight==input.target.height&&preparedFormat==input.target.pixelFormat)return {true,{},false};
        auto candidate=std::make_shared<State>(context(input.source.device),source,filter);
        warm(candidate,source,*parameters,input.source.width,input.source.height,input.target.width,input.target.height,input.origin,input.color);
        state=std::move(candidate);preparedWidth=input.target.width;preparedHeight=input.target.height;preparedFormat=input.target.pixelFormat;preparedSourceWidth=input.source.width;preparedSourceHeight=input.source.height;preparedSourceFormat=input.source.pixelFormat;preparedOrigin=input.origin;preparedColor=input.color;return {true,{},false};
    }catch(const std::exception &error){return {false,error.what(),false};}}
    ShaderResult encode(const ShaderFrame &input)override{if(input.source==input.target)return {false,"A shader needs separate input and output textures.",false};if(!input.commands||input.commands.status>=MTLCommandBufferStatusCommitted||!input.commands.retainedReferences)return {false,"Shaders require a retaining, unsubmitted command buffer.",false};auto ready=prepare(input);if(!ready.encoded)return ready;try{
        std::shared_ptr<Work> work=std::make_shared<Work>();{std::lock_guard<std::mutex> guard(lock);work->state=state;work->parameters=parameters;std::lock_guard<std::mutex> gate(state->lock);if(!state->failure.empty())return {false,state->failure,false};
            for(auto &slot:state->slots)if(!slot->busy){work->slot=slot;break;}if(!work->slot){if(state->slots.size()>=8)return {false,"The shader GPU frame capacity is busy.",true};work->slot=std::make_shared<Slot>(state->owner);state->slots.push_back(work->slot);}work->slot->busy=true;
            {std::lock_guard<std::mutex> gpu(state->owner->lock);work->source=state->imported(input.source,false);work->target=state->imported(input.target,true);state->owner->passthrough(input.commands,input.source,input.target);}
            work->input=++work->slot->counter;work->sourceDone=++work->slot->counter;work->output=++work->slot->counter;work->origin=input.origin;work->color=input.color;
        }
        struct Cancellation {std::shared_ptr<Work> work;std::atomic<bool> completed{false};~Cancellation(){if(!completed){work->cancel();work->complete();}}};
        auto cancellation=std::make_shared<Cancellation>();cancellation->work=work;
        [input.commands addCompletedHandler:^(id<MTLCommandBuffer> commands){if(commands.status!=MTLCommandBufferStatusCompleted)work->cancel();work->complete();cancellation->completed=true;}];
        // Register before commit: the CPU notification must not depend on a
        // scheduled-handler callback while this buffer waits for its result.
        // Cancellation releases an unsubmitted notification without GPU work.
        [work->slot->event notifyListener:listener() atValue:work->input block:^(id<MTLSharedEvent>,uint64_t){work->run();}];
        [input.commands encodeSignalEvent:work->slot->event value:work->input];[input.commands encodeWaitForEvent:work->slot->event value:work->output];return {true,{},false};
    }catch(const std::exception &error){return {false,error.what(),false};}}
};
}
extern "C" uint32_t rsLibplaceboNodeABI(){return 1;}
extern "C" const char *rsLibplaceboLastError(){return lastError.c_str();}
extern "C" int rsLibplaceboNodeCompletion(const macfx::ShaderNode *node,char *error,size_t capacity){
    if(error&&capacity)error[0]=0;
    try{
        const auto *value=dynamic_cast<const Node*>(node);
        if(!value)throw std::runtime_error("The shader completion belongs to another provider.");
        const auto status=value->completion();
        if(status.encoded)return 0;
        if(error&&capacity)std::snprintf(error,capacity,"%s",status.reason.c_str());return 1;
    }catch(const std::exception &problem){if(error&&capacity)std::snprintf(error,capacity,"%s",problem.what());return 1;}
}
extern "C" macfx::ShaderNode *rsCreateLibplaceboShaderNode(const macfx::ShaderSpec *spec){try{if(!spec)throw std::runtime_error("The shader selection is missing.");lastError.clear();return new Node(*spec);}catch(const std::exception &error){lastError=error.what();return nullptr;}}
extern "C" macfx::ShaderNode *rsCreateLibplaceboScalerNode(const char *name){try{lastError.clear();return new Node(name);}catch(const std::exception &error){lastError=error.what();return nullptr;}}
extern "C" const char *rsLibplaceboFilters(){@autoreleasepool{try{
    NSMutableArray *filters=[NSMutableArray new];
    for(const auto *const *item=pl_filter_configs;*item;++item){const auto &config=**item;if(!config.name||!(config.allowed&PL_FILTER_SCALING))continue;
        NSString *name=[NSString stringWithUTF8String:config.name];NSMutableDictionary *row=[@{@"id":[@"libplacebo:" stringByAppendingString:name],@"name":name,@"label":[NSString stringWithUTF8String:config.description?:config.name],@"upscale":@((config.allowed&PL_FILTER_UPSCALING)!=0),@"downscale":@((config.allowed&PL_FILTER_DOWNSCALING)!=0),@"recommendedUpscaling":@((config.recommended&PL_FILTER_UPSCALING)!=0),@"recommendedDownscaling":@((config.recommended&PL_FILTER_DOWNSCALING)!=0),@"polar":@(config.polar),@"radius":@(config.radius?config.radius:config.kernel?config.kernel->radius:0)}mutableCopy];
        if(config.kernel&&config.kernel->name)row[@"kernel"]=[NSString stringWithUTF8String:config.kernel->name];if(config.window&&config.window->name)row[@"window"]=[NSString stringWithUTF8String:config.window->name];[filters addObject:row];
    }
    NSDictionary *result=@{@"schema":@1,@"provider":@"libplacebo",@"version":@"7.360.1",@"filters":filters};NSData *data=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];if(!data)throw std::runtime_error("The scaling filter catalog could not be encoded.");inspection.assign(static_cast<const char*>(data.bytes),data.length);lastError.clear();return inspection.c_str();
}catch(const std::exception &error){lastError=error.what();return nullptr;}}}
extern "C" const char *rsLibplaceboInspect(const char *file){@autoreleasepool{try{
    auto source=readSource(file);auto owner=context(MTLCreateSystemDefaultDevice());std::lock_guard<std::mutex> guard(owner->lock);
    const pl_hook *hook=pl_mpv_user_shader_parse(owner->gpu(),source.data(),source.size());if(!hook)throw std::runtime_error("The original libplacebo parser rejected this shader.");
    try{if(hook->num_parameters>4096)throw std::runtime_error("The shader declares too many parameters.");NSMutableArray *parameters=[NSMutableArray new],*stages=[NSMutableArray new];
        const std::pair<unsigned,const char*> names[]={{PL_HOOK_RGB_INPUT,"RGB"},{PL_HOOK_LUMA_INPUT,"LUMA"},{PL_HOOK_CHROMA_INPUT,"CHROMA"},{PL_HOOK_ALPHA_INPUT,"ALPHA"},{PL_HOOK_XYZ_INPUT,"XYZ"},{PL_HOOK_CHROMA_SCALED,"CHROMA_SCALED"},{PL_HOOK_ALPHA_SCALED,"ALPHA_SCALED"},{PL_HOOK_NATIVE,"NATIVE"},{PL_HOOK_RGB,"MAIN"},{PL_HOOK_LINEAR,"LINEAR"},{PL_HOOK_SIGMOID,"SIGMOID"},{PL_HOOK_PRE_KERNEL,"PREKERNEL"},{PL_HOOK_POST_KERNEL,"POSTKERNEL"},{PL_HOOK_SCALED,"SCALED"},{PL_HOOK_PRE_OUTPUT,"PREOUTPUT"},{PL_HOOK_OUTPUT,"OUTPUT"}};
        for(const auto &[mask,name]:names)if(hook->stages&mask)[stages addObject:[NSString stringWithUTF8String:name]];
        for(int i=0;i<hook->num_parameters;++i){const auto &p=hook->parameters[i];NSString *name=[NSString stringWithUTF8String:p.name?:""];if(name.length<1||[name lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>4096)throw std::runtime_error("The shader parameter name is invalid.");
            const auto numeric=[&](pl_var_data value)->double{switch(p.type){case PL_VAR_FLOAT:return value.f;case PL_VAR_SINT:return value.i;case PL_VAR_UINT:return value.u;default:throw std::runtime_error("The shader parameter type is unsupported.");}};
            const auto initial=numeric(p.initial),minimum=numeric(p.minimum),maximum=numeric(p.maximum);if(!std::isfinite(initial)||!std::isfinite(minimum)||!std::isfinite(maximum)||minimum>initial||initial>maximum)throw std::runtime_error("The shader parameter range is invalid.");
            NSString *mode=p.mode==PL_HOOK_PAR_DYNAMIC?@"dynamic":p.mode==PL_HOOK_PAR_CONSTANT?@"constant":p.mode==PL_HOOK_PAR_DEFINE?@"define":@"variable";
            NSMutableDictionary *row=[@{@"name":name,@"label":[NSString stringWithUTF8String:p.description?:p.name],@"type":p.type==PL_VAR_FLOAT?@"float":@"int",@"default":@[@(initial)],@"min":@(minimum),@"max":@(maximum),@"step":p.type==PL_VAR_FLOAT?@0:@1,@"mode":mode,@"constant":@(p.mode==PL_HOOK_PAR_CONSTANT||p.mode==PL_HOOK_PAR_DEFINE)} mutableCopy];
            if(p.names&&p.type==PL_VAR_SINT&&p.minimum.i>=0&&p.maximum.i-p.minimum.i<=4096){NSMutableArray *options=[NSMutableArray new];for(int n=p.minimum.i;n<=p.maximum.i;++n)if(p.names[n])[options addObject:@{@"value":@(n),@"label":[NSString stringWithUTF8String:p.names[n]]}];row[@"options"]=options;}
            [parameters addObject:row];
        }
        NSDictionary *metadata=@{@"schema":@1,@"format":@"libplacebo",@"parameters":parameters,@"stages":stages,@"rgbCompatible":@(rgbHook(hook)),@"requirements":@{},@"upstream":@{@"name":@"libplacebo",@"version":@"7.360.1",@"url":@"https://libplacebo.org/custom-shaders/"}};
        NSData *data=[NSJSONSerialization dataWithJSONObject:metadata options:NSJSONWritingSortedKeys error:nil];if(!data)throw std::runtime_error("The shader metadata could not be encoded.");inspection.assign(static_cast<const char*>(data.bytes),data.length);pl_mpv_user_shader_destroy(&hook);lastError.clear();return inspection.c_str();
    }catch(...){pl_mpv_user_shader_destroy(&hook);throw;}
}catch(const std::exception &error){lastError=error.what();return nullptr;}}}
