// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "libplacebo-node.hpp"
#include "image-budget.hpp"
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
#include <sstream>
#include <optional>
#include <set>
#include <cstring>
#if defined(MACFX_LIBPLACEBO_SCENE_INPUTS) && !defined(PL_MPV_EXTERNAL_TEXTURES_API)
#error The original libplacebo named texture resolver is required for scene inputs.
#endif
extern "C" void vkGetMTLDeviceMVK(VkPhysicalDevice,id<MTLDevice>*);
namespace {
using namespace macfx;
thread_local std::string lastError,inspection;
struct SceneScope {const ShaderNode *node=nullptr;const RSShaderSceneInputsV1 *inputs=nullptr;};
thread_local SceneScope sceneScope;
struct SceneLease {
    void *storage;void(*release)(void*);
    explicit SceneLease(const RSShaderSceneInputsV1 &p):storage(p.storage),release(p.release){p.retain(storage);}
    ~SceneLease(){release(storage);}
};
struct SceneImage {
    std::string name;uint32_t role=0,width=0,height=0,origin=0,encoding=0,space=0;MTLPixelFormat format=MTLPixelFormatInvalid;
    bool operator==(const SceneImage &b)const{return name==b.name&&role==b.role&&width==b.width&&height==b.height&&origin==b.origin&&encoding==b.encoding&&space==b.space&&format==b.format;}
};
using SceneContract=std::vector<SceneImage>;
#if defined(MACFX_LIBPLACEBO_SCENE_INPUTS)
using ExternalTexture=pl_mpv_external_tex;
#else
struct ExternalTexture {const char *name;pl_tex texture;pl_rect2df rect;pl_color_repr repr;pl_color_space color;int components;};
#endif
ExternalTexture externalTexture(const SceneImage &image,pl_tex texture){
    ExternalTexture result{};result.name=image.name.c_str();result.texture=texture;result.components=texture->params.format->num_components;
    result.rect={0,image.origin?float(image.height):0,float(image.width),image.origin?0:float(image.height)};
    result.repr=pl_color_repr_rgb;result.repr.alpha=PL_ALPHA_INDEPENDENT;result.repr.bits.sample_depth=result.repr.bits.color_depth=32;
    // BIND resources are raw canonical signals. Original sampling macros do
    // not color-convert the signed normal, material, depth or motion channels.
    result.color=pl_color_space_srgb;result.color.transfer=PL_COLOR_TRC_LINEAR;return result;
}
struct ExternalScope {
    const pl_hook *hook;
    ExternalScope(const pl_hook *value,const std::vector<ExternalTexture> &images):hook(value){
#if defined(MACFX_LIBPLACEBO_SCENE_INPUTS)
        if(!images.empty()&&(!hook||!pl_mpv_user_shader_set_external_textures(hook,images.data(),int(images.size()))))throw std::runtime_error("The libplacebo BIND resource is invalid, unused, reserved or writable.");
#else
        if(!images.empty())throw std::runtime_error("This libplacebo provider has no named scene texture resolver.");
#endif
    }
    ~ExternalScope(){
#if defined(MACFX_LIBPLACEBO_SCENE_INPUTS)
        if(hook)pl_mpv_user_shader_set_external_textures(hook,nullptr,0);
#endif
    }
};
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
bool debandSource(const std::string &source){
    const auto begin=source.find_first_not_of(" \t\r\n");if(begin==std::string::npos||source[begin]!='{')return false;
    NSData *data=[NSData dataWithBytes:source.data() length:source.size()];id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if(![value isKindOfClass:NSDictionary.class]||[value count]!=2||![[value objectForKey:@"schema"] isKindOfClass:NSNumber.class]||
       CFGetTypeID((__bridge CFTypeRef)[value objectForKey:@"schema"])==CFBooleanGetTypeID()||[[value objectForKey:@"schema"] doubleValue]!=1||
       ![[value objectForKey:@"method"] isEqual:@"deband"])throw std::runtime_error("The libplacebo filter descriptor is invalid.");
    return true;
}
pl_deband_params debandParameters(const ShaderParameters &parameters){
    auto result=pl_deband_default_params;
    for(const auto &[name,values]:parameters){
        if(values.size()!=1||!std::isfinite(values[0]))throw std::runtime_error("Libplacebo deband controls require finite scalar values.");
        const float value=values[0];
        if(name=="iterations"){if(value<0||value>4||std::trunc(value)!=value)throw std::runtime_error("Deband iterations must be whole numbers from 0 to 4.");result.iterations=int(value);}
        else if(name=="threshold"){if(value<0||value>64)throw std::runtime_error("Deband threshold must be from 0 to 64.");result.threshold=value;}
        else if(name=="radius"){if(value<1||value>64)throw std::runtime_error("Deband radius must be from 1 to 64 pixels.");result.radius=value;}
        else if(name=="grain"){if(value<0||value>16)throw std::runtime_error("Deband grain must be from 0 to 16.");result.grain=value;}
        else throw std::runtime_error("The libplacebo deband control is unavailable.");
    }return result;
}
NSDictionary *debandMetadata(){
    NSMutableArray *parameters=[NSMutableArray new];
    const struct {const char *name,*label,*type;double value,minimum,maximum,step;} controls[]={
        {"iterations","Iterations","int",1,0,4,1},{"threshold","Threshold","float",3,0,64,.1},
        {"radius","Radius","float",16,1,64,1},{"grain","Grain","float",4,0,16,.1}};
    for(const auto &row:controls)[parameters addObject:@{@"name":@(row.name),@"label":@(row.label),@"type":@(row.type),@"default":@[@(row.value)],@"min":@(row.minimum),@"max":@(row.maximum),@"step":@(row.step),@"mode":@"dynamic",@"constant":@NO}];
    return @{@"schema":@1,@"format":@"libplacebo",@"imageFiltersAPI":@1,@"method":@"deband",@"parameters":parameters,@"stages":@[@"MAIN"],@"rgbCompatible":@YES,@"requiresDerivedPlanes":@NO,@"inputRepresentation":@"rgb",@"requirements":@{},@"upstream":@{@"name":@"libplacebo",@"version":@"7.360.1",@"url":@"https://libplacebo.org/"}};
}
void check(VkResult result,const char *message){if(result!=VK_SUCCESS)throw std::runtime_error(std::string(message)+" (Vulkan "+std::to_string(result)+").");}
struct Context {
    id<MTLDevice> device;
    id<MTLCommandQueue> repairQueue;
    id<MTLLibrary> repairLibrary;
    std::map<MTLPixelFormat,id<MTLRenderPipelineState>> repairPipelines;
    pl_log log=nullptr;pl_vk_inst instance=nullptr;pl_vulkan vulkan=nullptr;
    std::mutex lock,logLock;std::string failure;
    uint64_t derivedPlaneBytes=0;
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
    case MTLPixelFormatR16Float:return VK_FORMAT_R16_SFLOAT;case MTLPixelFormatR32Float:return VK_FORMAT_R32_SFLOAT;
    case MTLPixelFormatRG16Float:return VK_FORMAT_R16G16_SFLOAT;case MTLPixelFormatRG32Float:return VK_FORMAT_R32G32_SFLOAT;
    case MTLPixelFormatRGBA8Unorm:return VK_FORMAT_R8G8B8A8_UNORM;case MTLPixelFormatBGRA8Unorm:return VK_FORMAT_B8G8R8A8_UNORM;
    case MTLPixelFormatRGBA8Unorm_sRGB:return VK_FORMAT_R8G8B8A8_SRGB;case MTLPixelFormatBGRA8Unorm_sRGB:return VK_FORMAT_B8G8R8A8_SRGB;
    case MTLPixelFormatRGBA16Float:return VK_FORMAT_R16G16B16A16_SFLOAT;case MTLPixelFormatRGBA32Float:return VK_FORMAT_R32G32B32A32_SFLOAT;
    case MTLPixelFormatRGB10A2Unorm:return VK_FORMAT_A2B10G10R10_UNORM_PACK32;default:throw std::runtime_error("The shader provider does not support this Metal texture format.");}}
bool srgb(MTLPixelFormat format){return format==MTLPixelFormatRGBA8Unorm_sRGB||format==MTLPixelFormatBGRA8Unorm_sRGB;}
const char *formatName(MTLPixelFormat format){switch(format){
    case MTLPixelFormatR16Float:return "r16f";case MTLPixelFormatR32Float:return "r32f";case MTLPixelFormatRG16Float:return "rg16f";case MTLPixelFormatRG32Float:return "rg32f";
    case MTLPixelFormatRGBA8Unorm:case MTLPixelFormatRGBA8Unorm_sRGB:return "rgba8";case MTLPixelFormatBGRA8Unorm:case MTLPixelFormatBGRA8Unorm_sRGB:return "bgra8";
    case MTLPixelFormatRGBA16Float:return "rgba16f";case MTLPixelFormatRGBA32Float:return "rgba32f";case MTLPixelFormatRGB10A2Unorm:return "rgb10a2";
    default:throw std::runtime_error("The scene image format is unsupported by libplacebo.");}}
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
pl_frame frame(pl_tex tex,FrameOrigin origin,SpatialColor color,bool hardwareSRGB=false,bool importedSource=false,const ImageColorDescription *description=nullptr,bool opaque=false){
    pl_frame out{};out.num_planes=1;out.planes[0].texture=tex;out.planes[0].components=4;for(int i=0;i<4;++i)out.planes[0].component_mapping[i]=i;out.planes[0].flipped=origin==FrameOrigin::BottomLeft;
    // Imported source components follow their host storage order. libplacebo
    // uses sample_order to access them, then this mapping supplies their RGB
    // meaning. Render targets instead use canonical shader output components.
    if(importedSource)for(int i=0;i<4;++i)out.planes[0].component_mapping[i]=tex->params.format->sample_order[i];
    out.repr=pl_color_repr_rgb;out.repr.alpha=PL_ALPHA_INDEPENDENT;out.color=pl_color_space_srgb;
    if(description){
        out.color.primaries=description->primaries==ColorPrimaries::BT2020?PL_COLOR_PRIM_BT_2020:description->primaries==ColorPrimaries::DisplayP3?PL_COLOR_PRIM_DISPLAY_P3:PL_COLOR_PRIM_BT_709;
        out.color.transfer=description->transfer==ColorTransfer::Linear?PL_COLOR_TRC_LINEAR:description->transfer==ColorTransfer::PQ?PL_COLOR_TRC_PQ:description->transfer==ColorTransfer::HLG?PL_COLOR_TRC_HLG:PL_COLOR_TRC_SRGB;
        out.color.hdr.min_luma=description->blackLuminance;out.color.hdr.max_luma=description->peakLuminance;
        out.repr.levels=description->range==ColorRange::Full?PL_COLOR_LEVELS_FULL:PL_COLOR_LEVELS_LIMITED;
        out.repr.alpha=description->alpha==ColorAlpha::Opaque?PL_ALPHA_NONE:description->alpha==ColorAlpha::Premultiplied?PL_ALPHA_PREMULTIPLIED:PL_ALPHA_INDEPENDENT;
    }
    // An opaque display's storage alpha may be unused by the producer. Its
    // RGB remains meaningful even where that unused component is zero.
    if(opaque)out.repr.alpha=PL_ALPHA_NONE;
    if((!description&&color==SpatialColor::Linear)||hardwareSRGB)out.color.transfer=PL_COLOR_TRC_LINEAR;return out;
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
bool planeHook(const pl_hook *hook,const std::string &source){
    // The original parser includes execution, BIND and size/condition input
    // stages. Its prepared stage set excludes immutable false passes.
    return hook->stages&(PL_HOOK_LUMA_INPUT|PL_HOOK_CHROMA_INPUT|PL_HOOK_CHROMA_SCALED|PL_HOOK_ALPHA_INPUT|PL_HOOK_ALPHA_SCALED);
}
void render(pl_renderer renderer,const pl_hook *hook,const pl_frame &source,const pl_frame &target,const pl_filter_config *filter=nullptr,const pl_deband_params *deband=nullptr){
    auto parameters=pl_render_fast_params;parameters.hooks=hook?&hook:nullptr;parameters.num_hooks=hook?1:0;parameters.dither_params=nullptr;parameters.background=PL_CLEAR_SKIP;parameters.background_transparency=1;
    parameters.deband_params=deband;
    if(filter){
        const bool up=source.planes[0].texture->params.w<target.planes[0].texture->params.w||source.planes[0].texture->params.h<target.planes[0].texture->params.h;
        const bool down=source.planes[0].texture->params.w>target.planes[0].texture->params.w||source.planes[0].texture->params.h>target.planes[0].texture->params.h;
        if(up&&!(filter->allowed&PL_FILTER_UPSCALING)||down&&!(filter->allowed&PL_FILTER_DOWNSCALING))throw std::runtime_error("The selected libplacebo filter does not support this scaling direction.");
        parameters.upscaler=filter->allowed&PL_FILTER_UPSCALING?filter:nullptr;parameters.downscaler=filter->allowed&PL_FILTER_DOWNSCALING?filter:nullptr;parameters.antiringing_strength=filter->antiring;
    }
    if(!pl_render_image(renderer,&source,&target,&parameters)||pl_renderer_get_errors(renderer).errors!=PL_RENDER_ERR_NONE)throw std::runtime_error("The original shader renderer rejected this RGB frame.");
}
struct GpuQueries {
    std::shared_ptr<Context> owner;VkQueryPool query{};VkCommandPool pool{};VkCommandBuffer commands[2]{};VkQueue queue{};
    uint32_t family=0,bits=0;double period=0;
    explicit GpuQueries(std::shared_ptr<Context> value):owner(std::move(value)) {try{
        const auto vk=owner->vulkan;family=vk->queue_graphics.index;
        if(vk->queue_graphics.count!=1||
            vk->queue_compute.count&&vk->queue_compute.index!=family||
            vk->queue_transfer.count&&vk->queue_transfer.index!=family)
            throw std::runtime_error("The renderer does not expose one measurable GPU queue.");
        uint32_t count=0;vkGetPhysicalDeviceQueueFamilyProperties(vk->phys_device,&count,nullptr);
        std::vector<VkQueueFamilyProperties> families(count);vkGetPhysicalDeviceQueueFamilyProperties(vk->phys_device,&count,families.data());
        if(family>=count||!(bits=families[family].timestampValidBits))throw std::runtime_error("The renderer GPU queue has no timestamp support.");
        VkPhysicalDeviceProperties properties{};vkGetPhysicalDeviceProperties(vk->phys_device,&properties);period=properties.limits.timestampPeriod;
        if(!std::isfinite(period)||period<=0)throw std::runtime_error("The renderer GPU timestamp period is unavailable.");
        vkGetDeviceQueue(vk->device,family,0,&queue);if(!queue)throw std::runtime_error("The renderer GPU queue is unavailable.");
        VkQueryPoolCreateInfo qi{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};qi.queryType=VK_QUERY_TYPE_TIMESTAMP;qi.queryCount=2;
        check(vkCreateQueryPool(vk->device,&qi,nullptr,&query),"GPU timestamp allocation failed");
        VkCommandPoolCreateInfo pi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};pi.queueFamilyIndex=family;
        check(vkCreateCommandPool(vk->device,&pi,nullptr,&pool),"GPU timestamp command allocation failed");
        VkCommandBufferAllocateInfo ai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};ai.commandPool=pool;ai.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;ai.commandBufferCount=2;
        check(vkAllocateCommandBuffers(vk->device,&ai,commands),"GPU timestamp commands failed");
    }catch(...){destroy();throw;}}
    void destroy(){if(pool)vkDestroyCommandPool(owner->vulkan->device,pool,nullptr);if(query)vkDestroyQueryPool(owner->vulkan->device,query,nullptr);pool={};query={};}
    ~GpuQueries(){destroy();}
    void submit(unsigned index,VkSemaphore semaphore,uint64_t wait,uint64_t signal){
        VkTimelineSemaphoreSubmitInfo timeline{VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO};timeline.waitSemaphoreValueCount=wait?1:0;timeline.pWaitSemaphoreValues=&wait;timeline.signalSemaphoreValueCount=signal?1:0;timeline.pSignalSemaphoreValues=&signal;
        VkPipelineStageFlags stages=VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;VkSubmitInfo info{VK_STRUCTURE_TYPE_SUBMIT_INFO};info.pNext=&timeline;info.commandBufferCount=1;info.pCommandBuffers=&commands[index];info.waitSemaphoreCount=wait?1:0;info.pWaitSemaphores=&semaphore;info.pWaitDstStageMask=&stages;info.signalSemaphoreCount=signal?1:0;info.pSignalSemaphores=&semaphore;
        const auto vk=owner->vulkan;vk->lock_queue(vk,family,0);const auto result=vkQueueSubmit(queue,1,&info,VK_NULL_HANDLE);vk->unlock_queue(vk,family,0);check(result,"GPU timestamp submission failed");
    }
    void begin(VkSemaphore semaphore,uint64_t input){
        check(vkResetCommandPool(owner->vulkan->device,pool,0),"GPU timestamp reset failed");
        VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};bi.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        for(unsigned i=0;i<2;++i){check(vkBeginCommandBuffer(commands[i],&bi),"GPU timestamp recording failed");if(!i)vkCmdResetQueryPool(commands[i],query,0,2);vkCmdWriteTimestamp(commands[i],VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,query,i);check(vkEndCommandBuffer(commands[i]),"GPU timestamp recording failed");}
        submit(0,semaphore,input,0);
    }
    void end(VkSemaphore semaphore,uint64_t ready,uint64_t output){submit(1,semaphore,ready,output);}
    uint64_t duration()const noexcept{
        uint64_t values[4]{};const auto result=vkGetQueryPoolResults(owner->vulkan->device,query,0,2,sizeof(values),values,sizeof(uint64_t)*2,VK_QUERY_RESULT_64_BIT|VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
        if(result!=VK_SUCCESS||!values[1]||!values[3])return 0;
        const uint64_t mask=bits>=64?~uint64_t(0):(uint64_t(1)<<bits)-1,delta=(values[2]-values[0])&mask;const double ns=delta*period;
        return std::isfinite(ns)&&ns>0&&ns<double(UINT64_MAX)?uint64_t(ns):0;
    }
};
struct Slot {
    std::shared_ptr<Context> owner;id<MTLSharedEvent> event;VkSemaphore semaphore{};uint64_t counter=0;bool busy=false;
    std::shared_ptr<GpuQueries> timing;
    explicit Slot(std::shared_ptr<Context> value):owner(std::move(value)){
        event=[owner->device newSharedEvent];if(!event)throw std::runtime_error("A shared GPU event could not be created.");
        VkImportMetalSharedEventInfoEXT external{VK_STRUCTURE_TYPE_IMPORT_METAL_SHARED_EVENT_INFO_EXT};external.mtlSharedEvent=event;
        VkSemaphoreTypeCreateInfo type{VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO};type.pNext=&external;type.semaphoreType=VK_SEMAPHORE_TYPE_TIMELINE;
        VkSemaphoreCreateInfo info{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};info.pNext=&type;check(vkCreateSemaphore(owner->vulkan->device,&info,nullptr,&semaphore),"Shared GPU event import failed");
    }
    ~Slot(){if(semaphore)vkDestroySemaphore(owner->vulkan->device,semaphore,nullptr);}
};
struct State;
struct GpuMeasurement {
    RSLibplaceboGpuTimingRequest request;uint64_t frameId=0;std::atomic<bool> sent{false};
    void finish(uint64_t ns)noexcept{if(request.completed&&!sent.exchange(true))try{request.completed(request.context,request.token,frameId,ns);}catch(...){} }
    ~GpuMeasurement(){finish(0);}
};
struct Work:std::enable_shared_from_this<Work> {
    std::shared_ptr<State> state;std::shared_ptr<Slot> slot;std::shared_ptr<Imported> source,target;std::shared_ptr<const ShaderParameters> parameters;
    struct Guide {std::shared_ptr<Imported> image;uint64_t done=0;bool released=false,returned=false;};
    SceneContract sceneContract;std::vector<std::shared_ptr<Imported>> sceneTextures;std::vector<ExternalTexture> external;std::vector<Guide> guides;std::shared_ptr<SceneLease> sceneLease;
    bool sourceReleased=false,targetReleased=false,sourceReturned=false,targetReturned=false;
    FrameOrigin origin;SpatialColor color;bool opaque=false;std::shared_ptr<const ImageColorDescription> description;uint64_t input,sourceDone,output,renderDone=0,frameId=0;std::atomic<unsigned> phase{0};std::atomic<bool> finishing{false},metalDone{false},runDone{false},finishDone{false},retired{false},timingSent{false};
    std::shared_ptr<GpuMeasurement> timing;std::shared_ptr<GpuQueries> queries;
    ~Work();void run();void cancel();void complete(bool success=false);void retire();void finishFailed();void returnImages();void measured(uint64_t ns)noexcept;
};
struct State {
    std::shared_ptr<Context> owner;std::mutex lock;pl_renderer renderer=nullptr,converter=nullptr;const pl_hook *hook=nullptr;const pl_filter_config *filter=nullptr;
    bool derived=false,deband=false;pl_tex planes[3]{};uint64_t planeBytes=0;
    std::vector<std::shared_ptr<Slot>> slots;std::map<std::pair<void*,bool>,std::shared_ptr<Imported>> imports;std::string failure;
    explicit State(std::shared_ptr<Context> ctx,const std::string &source,const pl_filter_config *scaler=nullptr,bool useDeband=false):owner(std::move(ctx)),filter(scaler),deband(useDeband){
        std::lock_guard<std::mutex> guard(owner->lock);if(!filter&&!deband){hook=pl_mpv_user_shader_parse(owner->gpu(),source.data(),source.size());if(!hook)throw std::runtime_error("The original shader parser rejected this file.");
        derived=planeHook(hook,source);
        if(hook->stages&&!rgbHook(hook)&&!derived){pl_mpv_user_shader_destroy(&hook);throw std::runtime_error("This shader requires unavailable source-plane inputs.");}}
        renderer=pl_renderer_create(owner->log,owner->gpu());if(!renderer){if(hook)pl_mpv_user_shader_destroy(&hook);throw std::runtime_error("The shader renderer could not be created.");}
        if(derived){converter=pl_renderer_create(owner->log,owner->gpu());if(!converter){pl_renderer_destroy(&renderer);pl_mpv_user_shader_destroy(&hook);throw std::runtime_error("The color-plane converter could not be created.");}}
    }
    void clearPlanes(){for(auto &texture:planes)if(texture)pl_tex_destroy(owner->gpu(),&texture);owner->derivedPlaneBytes-=planeBytes;planeBytes=0;}
    pl_frame planar(unsigned width,unsigned height){
        if(!planes[0]||unsigned(planes[0]->params.w)!=width||unsigned(planes[0]->params.h)!=height){
            clearPlanes();
            pl_fmt formats[3]{};uint64_t bytes=0;
            for(unsigned i=0;i<3;++i){formats[i]=pl_find_fmt(owner->gpu(),PL_FMT_FLOAT,i==1?2:1,16,0,
                pl_fmt_caps(PL_FMT_CAP_SAMPLEABLE|PL_FMT_CAP_RENDERABLE|PL_FMT_CAP_LINEAR));
                if(!formats[i])throw std::runtime_error("The GPU cannot render the derived floating-point color planes.");
                const auto allocation=alignedImageBytes(width,height,formats[i]->texel_size);
                if(!allocation||!imageBytesAdd(bytes,allocation,bytes))throw std::runtime_error("Derived color-plane dimensions exceed the GPU image budget.");}
            const auto admission=admitImageBytes({owner->device.recommendedMaxWorkingSetSize,owner->device.currentAllocatedSize,owner->derivedPlaneBytes},bytes);
            if(!admission.admitted)throw std::runtime_error("The derived color planes exceed available GPU image memory.");
            // Prefer renderable FP16 to reduce image bandwidth. The provider
            // may select a wider format on devices lacking that capability;
            // virtual signal precision remains a separate color contract.
            try{for(unsigned i=0;i<3;++i){pl_tex_params p{};p.w=width;p.h=height;p.format=formats[i];p.sampleable=p.renderable=true;
                if(!p.format||(planes[i]=pl_tex_create(owner->gpu(),&p))==nullptr)throw std::runtime_error("The derived color-plane textures could not be allocated.");}
            }catch(...){for(auto &texture:planes)if(texture)pl_tex_destroy(owner->gpu(),&texture);throw;}
            planeBytes=bytes;owner->derivedPlaneBytes+=bytes;
        }
        pl_frame out{};out.num_planes=3;
        out.planes[0].texture=planes[0];out.planes[0].components=1;out.planes[0].component_mapping[0]=PL_CHANNEL_Y;
        out.planes[1].texture=planes[1];out.planes[1].components=2;out.planes[1].component_mapping[0]=PL_CHANNEL_CB;out.planes[1].component_mapping[1]=PL_CHANNEL_CR;
        out.planes[2].texture=planes[2];out.planes[2].components=1;out.planes[2].component_mapping[0]=PL_CHANNEL_A;
        out.repr.sys=PL_COLOR_SYSTEM_BT_709;out.repr.levels=PL_COLOR_LEVELS_FULL;out.repr.alpha=PL_ALPHA_INDEPENDENT;
        out.repr.bits.sample_depth=out.repr.bits.color_depth=16;out.color=pl_color_space_srgb;return out;
    }
    void process(pl_renderer selected,const pl_hook *selectedHook,const pl_frame &source,const pl_frame &target,const ShaderParameters *values=nullptr){
        if(!derived){const auto settings=deband?std::optional<pl_deband_params>(debandParameters(values?*values:ShaderParameters{})):std::nullopt;render(selected,selectedHook,source,target,filter,settings?&*settings:nullptr);return;}
        auto converted=planar(source.planes[0].texture->params.w,source.planes[0].texture->params.h);converted.color=source.color;
        if(source.repr.alpha==PL_ALPHA_NONE)converted.repr.alpha=PL_ALPHA_NONE;
        render(converter,nullptr,source,converted);render(selected,selectedHook,converted,target);
    }
    ~State(){std::lock_guard<std::mutex> guard(owner->lock);if(renderer)pl_renderer_destroy(&renderer);if(converter)pl_renderer_destroy(&converter);if(hook)pl_mpv_user_shader_destroy(&hook);clearPlanes();imports.clear();slots.clear();}
    std::shared_ptr<Imported> imported(id<MTLTexture> value,bool target){const auto key=std::make_pair((__bridge void*)value,target);const auto found=imports.find(key);if(found!=imports.end())return found->second;auto result=std::make_shared<Imported>(owner,value,target);if(imports.size()>=8*(RS_SHADER_SCENE_EXPOSURE+3))imports.clear();imports[key]=result;return result;}
};
MTLSharedEventListener *listener(){static MTLSharedEventListener *value=[[MTLSharedEventListener alloc] initWithDispatchQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE,0)];return value;}
Work::~Work(){measured(0);if(state&&slot&&!retired.exchange(true)){std::lock_guard<std::mutex> guard(state->lock);slot->busy=false;}}
void Work::measured(uint64_t ns)noexcept{if(timing&&!timingSent.exchange(true))timing->finish(ns);}
void Work::retire(){if(metalDone&&runDone&&(!finishing||finishDone)&&!retired.exchange(true)){std::lock_guard<std::mutex> guard(state->lock);slot->busy=false;}}
void Work::complete(bool success){if(phase==0)cancel();measured(success&&phase==1&&!finishing&&queries?queries->duration():0);metalDone=true;retire();}
void Work::returnImages(){
    const auto giveBack=[&](const std::shared_ptr<Imported>&image,uint64_t value,bool released,bool &returned){if(!released||returned)return;
        pl_vulkan_hold_params hold{};hold.layout=VK_IMAGE_LAYOUT_GENERAL;hold.qf=VK_QUEUE_FAMILY_IGNORED;hold.tex=image->texture;hold.semaphore={slot->semaphore,value};
        if(!pl_vulkan_hold_ex(state->owner->gpu(),&hold))throw std::runtime_error("A shared shader image could not be returned to Metal.");returned=true;};
    giveBack(source,sourceDone,sourceReleased,sourceReturned);
    for(auto &guide:guides)giveBack(guide.image,guide.done,guide.released,guide.returned);
    giveBack(target,queries?renderDone:output,targetReleased,targetReturned);
}
void Work::finishFailed(){if(finishing.exchange(true))return;auto retained=shared_from_this();dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
    try{std::lock_guard<std::mutex> guard(retained->state->owner->lock);auto &owner=*retained->state->owner;pl_gpu_finish(owner.gpu());
        retained->returnImages();pl_gpu_flush(owner.gpu());pl_gpu_finish(owner.gpu());
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
        if(queries){pl_gpu_flush(state->owner->gpu());queries->begin(slot->semaphore,input);}
        ExternalScope bindings(state->hook,external);
        pl_vulkan_release_params release{};release.layout=VK_IMAGE_LAYOUT_GENERAL;release.qf=VK_QUEUE_FAMILY_IGNORED;release.semaphore={slot->semaphore,input};release.tex=source->texture;pl_vulkan_release_ex(state->owner->gpu(),&release);sourceReleased=true;release.tex=target->texture;pl_vulkan_release_ex(state->owner->gpu(),&release);targetReleased=true;
        for(auto &guide:guides){release.tex=guide.image->texture;pl_vulkan_release_ex(state->owner->gpu(),&release);guide.released=true;}
        state->process(state->renderer,state->hook,frame(source->texture,origin,color,srgb(source->metal.pixelFormat),true,description.get(),opaque),frame(target->texture,origin,color,srgb(target->metal.pixelFormat),false,description.get(),opaque),parameters.get());
        returnImages();pl_gpu_flush(state->owner->gpu());
        if(queries)queries->end(slot->semaphore,renderDone,output);
    }catch(const std::exception &error){std::lock_guard<std::mutex> guard(state->lock);state->failure=error.what();finishFailed();}
    if(!finishing){runDone=true;retire();}
}
void warm(const std::shared_ptr<State> &state,const std::string &source,const ShaderParameters &parameters,unsigned sourceWidth,unsigned sourceHeight,unsigned targetWidth,unsigned targetHeight,FrameOrigin origin,SpatialColor color,const ImageColorDescription *description=nullptr,bool opaque=false,const SceneContract &scene={}){std::lock_guard<std::mutex> gpu(state->owner->lock);
            const pl_hook *test=state->filter||state->deband?nullptr:pl_mpv_user_shader_parse(state->owner->gpu(),source.data(),source.size());if(!state->filter&&!state->deband&&!test)throw std::runtime_error("The shader could not be prepared.");pl_renderer renderer=pl_renderer_create(state->owner->log,state->owner->gpu());pl_tex a=nullptr,b=nullptr;
            std::map<uint32_t,pl_tex> guides;std::vector<ExternalTexture> external;
            try{if(test)apply(test,parameters);uint64_t bytes=0;
                for(const auto &image:scene)if(!guides.count(image.role)){const auto format=pl_find_named_fmt(state->owner->gpu(),formatName(image.format));if(!format||!(format->caps&PL_FMT_CAP_LINEAR))throw std::runtime_error("The libplacebo BIND image format cannot be sampled.");
                    const auto allocation=alignedImageBytes(image.width,image.height,format->texel_size);if(!allocation||!imageBytesAdd(bytes,allocation,bytes))throw std::runtime_error("The shader preparation images exceed the GPU image budget.");guides.emplace(image.role,nullptr);}
                if(bytes&&!admitImageBytes({state->owner->device.recommendedMaxWorkingSetSize,state->owner->device.currentAllocatedSize},bytes).admitted)throw std::runtime_error("The shader preparation images exceed available GPU memory.");
                for(const auto &image:scene){auto &texture=guides.at(image.role);if(!texture){pl_tex_params p{};p.w=image.width;p.h=image.height;p.format=pl_find_named_fmt(state->owner->gpu(),formatName(image.format));p.sampleable=p.blit_dst=true;texture=pl_tex_create(state->owner->gpu(),&p);if(!texture)throw std::runtime_error("The shader preparation guide could not be allocated.");const float zero[4]{};pl_tex_clear(state->owner->gpu(),texture,zero);}external.push_back(externalTexture(image,texture));}
                ExternalScope bindings(test,external);
                pl_tex_params p{};p.w=sourceWidth;p.h=sourceHeight;p.format=pl_find_named_fmt(state->owner->gpu(),"rgba8");p.sampleable=true;p.renderable=true;a=pl_tex_create(state->owner->gpu(),&p);p.w=targetWidth;p.h=targetHeight;b=pl_tex_create(state->owner->gpu(),&p);if(!a||!b||!renderer)throw std::runtime_error("The shader preparation textures could not be allocated.");state->process(renderer,test,frame(a,origin,color,false,false,description,opaque),frame(b,origin,color,false,false,description,opaque),&parameters);pl_gpu_flush(state->owner->gpu());}
            catch(...){for(auto &[role,texture]:guides)if(texture)pl_tex_destroy(state->owner->gpu(),&texture);if(a)pl_tex_destroy(state->owner->gpu(),&a);if(b)pl_tex_destroy(state->owner->gpu(),&b);if(renderer)pl_renderer_destroy(&renderer);if(test)pl_mpv_user_shader_destroy(&test);throw;}
            for(auto &[role,texture]:guides)if(texture)pl_tex_destroy(state->owner->gpu(),&texture);
            pl_tex_destroy(state->owner->gpu(),&a);pl_tex_destroy(state->owner->gpu(),&b);pl_renderer_destroy(&renderer);if(test)pl_mpv_user_shader_destroy(&test);
        }

class Node final:public ShaderNode {
    std::string source;const pl_filter_config *filter=nullptr;bool deband=false;mutable std::mutex lock;std::shared_ptr<State> state;std::shared_ptr<const ShaderParameters> parameters;std::shared_ptr<const ImageColorDescription> description;
    SceneContract preparedScene;
    unsigned preparedWidth=0,preparedHeight=0,preparedSourceWidth=0,preparedSourceHeight=0;MTLPixelFormat preparedFormat=MTLPixelFormatInvalid,preparedSourceFormat=MTLPixelFormatInvalid;FrameOrigin preparedOrigin{};SpatialColor preparedColor{};bool preparedOpaque=false;
    const RSShaderSceneInputsV1 *sceneInputs(const ShaderFrame &frame)const{
        if(sceneScope.node!=this||!sceneScope.inputs)return nullptr;const auto *p=sceneScope.inputs;
        if(p->commandBuffer!=(__bridge void*)frame.commands||p->source!=(__bridge void*)frame.source||p->target!=(__bridge void*)frame.target||p->frameId!=frame.frameId)
            throw std::runtime_error("The libplacebo scene inputs belong to another frame or command buffer.");return p;
    }
    SceneContract sceneContract(const ShaderFrame &frame)const{
        SceneContract result;const auto *p=sceneInputs(frame);if(!p||!p->bindingCount)return result;
        if(filter||deband)throw std::runtime_error("Named scene images require an authored libplacebo hook with BIND resources.");
        for(unsigned i=0;i<p->bindingCount;++i){const auto &binding=p->bindings[i];
            if(binding.role>=RS_SHADER_SCENE_VIEW_MATRIX)throw std::runtime_error("Libplacebo BIND resources are images; matrix inputs require a declared uniform interface.");
            const auto &value=p->values[binding.role];id<MTLTexture> texture=(__bridge id<MTLTexture>)value.texture;
            if(!texture||texture.device.registryID!=frame.commands.device.registryID||texture.textureType!=MTLTextureType2D||texture.sampleCount!=1||texture.width!=value.width||texture.height!=value.height||!value.width||!value.height||value.origin>1||value.reserved||
               (texture.usage!=MTLTextureUsageUnknown&&!(texture.usage&MTLTextureUsageShaderRead)))throw std::runtime_error("The libplacebo BIND image is not a compatible resolved texture on this frame's GPU: "+std::string(binding.name));
            id<MTLTexture> root=texture;while(root.parentTexture)root=root.parentTexture;id<MTLTexture> target=frame.target;while(target.parentTexture)target=target.parentTexture;
            if(root==target)throw std::runtime_error("A libplacebo scene BIND image cannot alias the writable output.");
            pixelFormat(texture.pixelFormat);result.push_back({binding.name,binding.role,value.width,value.height,value.origin,value.encoding,value.space,texture.pixelFormat});
        }return result;
    }
public:
    explicit Node(const ShaderSpec &spec):source(readSource(spec.selection.file.c_str())),deband(debandSource(source)),parameters(std::make_shared<const ShaderParameters>(spec.parameters)){if(deband)debandParameters(*parameters);}
    explicit Node(const char *name):filter(filterConfig(name)),parameters(std::make_shared<const ShaderParameters>()){}
    Node(const Node &previous,const ShaderParameters &requested){
        std::lock_guard<std::mutex>guard(previous.lock);source=previous.source;filter=previous.filter;deband=previous.deband;state=previous.state;description=previous.description;
        parameters=std::make_shared<const ShaderParameters>(requested);
        preparedWidth=previous.preparedWidth;preparedHeight=previous.preparedHeight;preparedSourceWidth=previous.preparedSourceWidth;preparedSourceHeight=previous.preparedSourceHeight;
        preparedFormat=previous.preparedFormat;preparedSourceFormat=previous.preparedSourceFormat;preparedOrigin=previous.preparedOrigin;preparedColor=previous.preparedColor;preparedOpaque=previous.preparedOpaque;
        preparedScene=previous.preparedScene;
        if(filter){if(!requested.empty())throw std::runtime_error("This scaling filter uses its original built-in parameters.");return;}
        if(deband){debandParameters(requested);bool failed=false;if(state){std::lock_guard<std::mutex>gate(state->lock);failed=!state->failure.empty();}if(failed)state.reset();return;}
        if(!state)return;
        bool recompile=false;
        {std::lock_guard<std::mutex>gpu(state->owner->lock);apply(state->hook,requested,false);
            for(int i=0;i<state->hook->num_parameters;++i){const auto &p=state->hook->parameters[i];if(p.mode!=PL_HOOK_PAR_CONSTANT&&p.mode!=PL_HOOK_PAR_DEFINE)continue;
                const auto before=previous.parameters->find(p.name),after=requested.find(p.name);
                const float initial=p.type==PL_VAR_FLOAT?p.initial.f:p.type==PL_VAR_UINT?p.initial.u:p.initial.i;
                recompile|=(before==previous.parameters->end()?initial:before->second[0])!=(after==requested.end()?initial:after->second[0]);}}
        {std::lock_guard<std::mutex>gate(state->lock);recompile|=!state->failure.empty();}
        if(recompile)state.reset();
    }
    void setColor(const ImageColorDescription &value){
        if(!value.valid())throw std::runtime_error("Invalid shader color metadata.");
        if(value.transfer==ColorTransfer::BT709)throw std::runtime_error("Convert camera BT.709 to linear RGB before the libplacebo stage.");
        std::lock_guard<std::mutex>guard(lock);
        if(description&&description->primaries==value.primaries&&description->transfer==value.transfer&&description->range==value.range&&description->alpha==value.alpha&&description->referenceWhite==value.referenceWhite&&description->peakLuminance==value.peakLuminance&&description->blackLuminance==value.blackLuminance&&description->hlgSystemGamma==value.hlgSystemGamma&&description->sceneReferred==value.sceneReferred)return;
        description=std::make_shared<const ImageColorDescription>(value);state.reset();
    }
    ShaderResult completion()const{
        std::lock_guard<std::mutex>guard(lock);
        if(!state)return {false,"The shader provider has no prepared frame.",false};
        std::lock_guard<std::mutex>gate(state->lock);
        return {state->failure.empty(),state->failure,false};
    }
    void prepareTiming(){
        std::lock_guard<std::mutex>guard(lock);if(!state)throw std::runtime_error("Prepare the shader before its GPU timing resources.");
        std::lock_guard<std::mutex>gate(state->lock);std::lock_guard<std::mutex>gpu(state->owner->lock);
        while(state->slots.size()<8)state->slots.push_back(std::make_shared<Slot>(state->owner));
        for(auto&slot:state->slots)if(!slot->timing)slot->timing=std::make_shared<GpuQueries>(state->owner);
    }
    void setParameters(const ShaderParameters &value)override{std::lock_guard<std::mutex> guard(lock);if(*parameters==value)return;
        if(filter)throw std::runtime_error("This scaling filter uses its original built-in parameters.");
        if(deband){debandParameters(value);parameters=std::make_shared<const ShaderParameters>(value);return;}
        if(state){bool compile=false;{std::lock_guard<std::mutex> gpu(state->owner->lock);apply(state->hook,value,false);
            for(int i=0;i<state->hook->num_parameters;++i){const auto &p=state->hook->parameters[i];if(p.mode!=PL_HOOK_PAR_CONSTANT&&p.mode!=PL_HOOK_PAR_DEFINE)continue;
                const auto previous=parameters->find(p.name),next=value.find(p.name);const float initial=p.type==PL_VAR_FLOAT?p.initial.f:p.type==PL_VAR_UINT?p.initial.u:p.initial.i;
                compile|=(previous==parameters->end()?initial:previous->second[0])!=(next==value.end()?initial:next->second[0]);}}
            if(compile)warm(state,source,value,preparedSourceWidth,preparedSourceHeight,preparedWidth,preparedHeight,preparedOrigin,preparedColor,description.get(),preparedOpaque,preparedScene);
        }parameters=std::make_shared<const ShaderParameters>(value);
    }
    ShaderResult prepare(const ShaderFrame &input)override{try{
        if(!input.commands||!input.source||!input.target)return {false,"A shader needs separate input and output textures.",false};
        if(input.source.device.registryID!=input.target.device.registryID)return {false,"The shader input and output belong to different GPUs.",false};
        pixelFormat(input.source.pixelFormat);pixelFormat(input.target.pixelFormat);const auto scene=sceneContract(input);std::lock_guard<std::mutex> guard(lock);
        if(state&&preparedScene==scene&&state->owner->device.registryID==input.source.device.registryID&&preparedSourceWidth==input.source.width&&preparedSourceHeight==input.source.height&&preparedSourceFormat==input.source.pixelFormat&&preparedOrigin==input.origin&&preparedColor==input.color&&preparedOpaque==input.opaqueDisplay&&preparedWidth==input.target.width&&preparedHeight==input.target.height&&preparedFormat==input.target.pixelFormat)return {true,{},false};
        auto candidate=std::make_shared<State>(context(input.source.device),source,filter,deband);
        warm(candidate,source,*parameters,input.source.width,input.source.height,input.target.width,input.target.height,input.origin,input.color,description.get(),input.opaqueDisplay,scene);
        state=std::move(candidate);preparedScene=scene;preparedWidth=input.target.width;preparedHeight=input.target.height;preparedFormat=input.target.pixelFormat;preparedSourceWidth=input.source.width;preparedSourceHeight=input.source.height;preparedSourceFormat=input.source.pixelFormat;preparedOrigin=input.origin;preparedColor=input.color;preparedOpaque=input.opaqueDisplay;return {true,{},false};
    }catch(const std::exception &error){return {false,error.what(),false};}}
    ShaderResult encode(const ShaderFrame &input)override{return encodeImpl(input,{});}
    ShaderResult encodeImpl(const ShaderFrame &input,const std::shared_ptr<GpuMeasurement>&timing){if(input.source==input.target)return {false,"A shader needs separate input and output textures.",false};if(!input.commands||input.commands.status>=MTLCommandBufferStatusCommitted||!input.commands.retainedReferences)return {false,"Shaders require a retaining, unsubmitted command buffer.",false};auto ready=prepare(input);if(!ready.encoded)return ready;try{
        {std::lock_guard<std::mutex>guard(lock);if(deband){const auto controls=debandParameters(*parameters);if(!controls.iterations&&!controls.grain){std::lock_guard<std::mutex>gpu(state->owner->lock);state->owner->passthrough(input.commands,input.source,input.target);if(timing)timing->finish(0);return {true,{},false};}}}
        std::shared_ptr<Work> work=std::make_shared<Work>();work->timing=timing;work->frameId=input.frameId;{std::lock_guard<std::mutex> guard(lock);work->state=state;work->parameters=parameters;work->description=description;work->sceneContract=preparedScene;
            const auto *p=sceneInputs(input);if(!work->sceneContract.empty()){if(!p||!p->storage||!p->retain||!p->release)throw std::runtime_error("Libplacebo scene images require a retained frame lease.");work->sceneLease=std::make_shared<SceneLease>(*p);}
            std::lock_guard<std::mutex> gate(state->lock);if(!state->failure.empty())return {false,state->failure,false};
            for(auto &slot:state->slots)if(!slot->busy){work->slot=slot;break;}if(!work->slot){if(state->slots.size()>=8)return {false,"The shader GPU frame capacity is busy.",true};work->slot=std::make_shared<Slot>(state->owner);state->slots.push_back(work->slot);}work->slot->busy=true;
            {std::lock_guard<std::mutex> gpu(state->owner->lock);work->source=state->imported(input.source,false);work->target=state->imported(input.target,true);
                for(const auto &image:work->sceneContract){const auto &value=p->values[image.role];auto imported=state->imported((__bridge id<MTLTexture>)value.texture,false);work->sceneTextures.push_back(imported);
                    if(imported!=work->source&&std::none_of(work->guides.begin(),work->guides.end(),[&](const auto &guide){return guide.image==imported;}))work->guides.push_back({imported});
                    work->external.push_back(externalTexture(image,imported->texture));}
                state->owner->passthrough(input.commands,input.source,input.target);}
            work->queries=timing?work->slot->timing:nullptr;work->input=++work->slot->counter;work->sourceDone=++work->slot->counter;for(auto &guide:work->guides)guide.done=++work->slot->counter;if(work->queries)work->renderDone=++work->slot->counter;work->output=++work->slot->counter;work->origin=input.origin;work->color=input.color;work->opaque=input.opaqueDisplay;
        }
        struct Cancellation {std::shared_ptr<Work> work;std::atomic<bool> completed{false};~Cancellation(){if(!completed){work->cancel();work->complete();}}};
        auto cancellation=std::make_shared<Cancellation>();cancellation->work=work;
        [input.commands addCompletedHandler:^(id<MTLCommandBuffer> commands){if(commands.status!=MTLCommandBufferStatusCompleted)work->cancel();work->complete(commands.status==MTLCommandBufferStatusCompleted);cancellation->completed=true;}];
        // Register before commit: the CPU notification must not depend on a
        // scheduled-handler callback while this buffer waits for its result.
        // Cancellation releases an unsubmitted notification without GPU work.
        [work->slot->event notifyListener:listener() atValue:work->input block:^(id<MTLSharedEvent>,uint64_t){work->run();}];
        [input.commands encodeSignalEvent:work->slot->event value:work->input];[input.commands encodeWaitForEvent:work->slot->event value:work->output];return {true,{},false};
    }catch(const std::exception &error){return {false,error.what(),false};}}
};
}
extern "C" uint32_t rsLibplaceboNodeABI(){return 1;}
extern "C" uint32_t rsLibplaceboImageFiltersABI(){return 1;}
extern "C" uint32_t rsLibplaceboSceneInputsAPI(){
#if defined(MACFX_LIBPLACEBO_SCENE_INPUTS)
    return pl_mpv_user_shader_external_textures_api()==1?1:0;
#else
    return 0;
#endif
}
extern "C" int rsLibplaceboBindSceneInputs(macfx::ShaderNode *node,const RSShaderSceneInputsV1 *p){try{
    if(!p){sceneScope={};lastError.clear();return 0;}
    if(!rsLibplaceboSceneInputsAPI())throw std::runtime_error("This libplacebo provider has no named scene texture resolver.");
    if(!dynamic_cast<Node*>(node)||p->size<sizeof(*p)||p->version!=RS_SHADER_SCENE_ABI_VERSION||p->bindingCount>128||p->bindingCount&&(!p->bindings||!p->values)||!p->commandBuffer||!p->source||!p->target)
        throw std::runtime_error("The libplacebo scene input companion is invalid.");
    std::set<std::string> names;for(unsigned i=0;i<p->bindingCount;++i){const auto &binding=p->bindings[i];
        if(!binding.name||!binding.name[0]||strnlen(binding.name,513)>512||binding.role>=RS_SHADER_SCENE_ROLE_COUNT||binding.reserved||!names.insert(binding.name).second)throw std::runtime_error("The libplacebo scene resource declaration is invalid.");
        for(size_t n=0;binding.name[n];++n){const auto c=binding.name[n];if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||c=='_'||(n&&c>='0'&&c<='9')))throw std::runtime_error("A libplacebo BIND resource requires a GLSL identifier: "+std::string(binding.name));}
        if(binding.role>=RS_SHADER_SCENE_VIEW_MATRIX)throw std::runtime_error("Libplacebo BIND resources are images; matrix inputs require a declared uniform interface.");
    }sceneScope={node,p};lastError.clear();return 0;
}catch(const std::exception &error){sceneScope={};lastError=error.what();return 1;}}
extern "C" uint32_t rsLibplaceboGpuTimingABI(){return 1;}
extern "C" int rsPrepareLibplaceboNodeGpuTiming(macfx::ShaderNode *node){try{auto*value=dynamic_cast<Node*>(node);if(!value)throw std::runtime_error("The GPU timing request belongs to another shader provider.");value->prepareTiming();lastError.clear();return 0;}catch(const std::exception&error){lastError=error.what();return 1;}}
extern "C" int rsEncodeLibplaceboNodeGpuTimed(macfx::ShaderNode *node,const macfx::ShaderFrame *frame,const RSLibplaceboGpuTimingRequest *request,char*error,size_t capacity){
    if(error&&capacity)error[0]=0;
    const auto outcome=[&](const macfx::ShaderResult&value){if(error&&capacity)std::snprintf(error,capacity,"%s",value.reason.c_str());return value.encoded?0:value.busy?2:1;};
    if(!frame||!request||request->size!=sizeof(*request)||request->version!=1||!request->token||!request->completed)return outcome({false,"Invalid shader GPU timing request",false});
    auto*value=dynamic_cast<Node*>(node);if(!value){request->completed(request->context,request->token,frame->frameId,0);return outcome({false,"The GPU timing request belongs to another shader provider",false});}
    std::shared_ptr<GpuMeasurement>measurement;
    try{measurement=std::make_shared<GpuMeasurement>();measurement->request=*request;measurement->frameId=frame->frameId;return outcome(value->encodeImpl(*frame,measurement));}
    catch(const std::exception&problem){if(measurement)measurement->finish(0);else request->completed(request->context,request->token,frame->frameId,0);return outcome({false,problem.what(),false});}
}
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
extern "C" macfx::ShaderNode *rsCloneLibplaceboShaderNode(const macfx::ShaderNode *source,const macfx::ShaderParameters *parameters){try{const auto *previous=dynamic_cast<const Node*>(source);if(!previous||!parameters)throw std::runtime_error("The parameter view belongs to another shader provider.");lastError.clear();return new Node(*previous,*parameters);}catch(const std::exception &error){lastError=error.what();return nullptr;}}
extern "C" int rsSetLibplaceboNodeColor(macfx::ShaderNode *node,const macfx::ImageColorDescription *description){try{auto *selected=dynamic_cast<Node*>(node);if(!selected||!description)throw std::runtime_error("The color metadata belongs to another shader provider.");selected->setColor(*description);lastError.clear();return 0;}catch(const std::exception &error){lastError=error.what();return 1;}}
extern "C" macfx::ShaderNode *rsCreateLibplaceboScalerNode(const char *name){try{lastError.clear();return new Node(name);}catch(const std::exception &error){lastError=error.what();return nullptr;}}
extern "C" const char *rsLibplaceboFilters(){@autoreleasepool{try{
    NSMutableArray *filters=[NSMutableArray new];
    for(const auto *const *item=pl_filter_configs;*item;++item){const auto &config=**item;if(!config.name||!(config.allowed&PL_FILTER_SCALING))continue;
        NSString *name=[NSString stringWithUTF8String:config.name];NSMutableDictionary *row=[@{@"id":[@"libplacebo:" stringByAppendingString:name],@"name":name,@"label":[NSString stringWithUTF8String:config.description?:config.name],@"upscale":@((config.allowed&PL_FILTER_UPSCALING)!=0),@"downscale":@((config.allowed&PL_FILTER_DOWNSCALING)!=0),@"recommendedUpscaling":@((config.recommended&PL_FILTER_UPSCALING)!=0),@"recommendedDownscaling":@((config.recommended&PL_FILTER_DOWNSCALING)!=0),@"polar":@(config.polar),@"radius":@(config.radius?config.radius:config.kernel?config.kernel->radius:0)}mutableCopy];
        if(config.kernel&&config.kernel->name)row[@"kernel"]=[NSString stringWithUTF8String:config.kernel->name];if(config.window&&config.window->name)row[@"window"]=[NSString stringWithUTF8String:config.window->name];[filters addObject:row];
    }
    NSMutableArray *roles=[NSMutableArray new];if(rsLibplaceboSceneInputsAPI())for(unsigned i=0;i<RS_SHADER_SCENE_VIEW_MATRIX;++i)[roles addObject:@(rsShaderSceneRoleNames[i])];
    NSDictionary *result=@{@"schema":@1,@"provider":@"libplacebo",@"version":@"7.360.1",@"filters":filters,@"imageFiltersAPI":@(rsLibplaceboImageFiltersABI()),@"imageFilters":@[@"deband"],@"sceneInputsAPI":@(rsLibplaceboSceneInputsAPI()),@"sceneInputRoles":roles};NSData *data=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];if(!data)throw std::runtime_error("The scaling filter catalog could not be encoded.");inspection.assign(static_cast<const char*>(data.bytes),data.length);lastError.clear();return inspection.c_str();
}catch(const std::exception &error){lastError=error.what();return nullptr;}}}
extern "C" const char *rsLibplaceboInspect(const char *file){@autoreleasepool{try{
    auto source=readSource(file);if(debandSource(source)){NSData *data=[NSJSONSerialization dataWithJSONObject:debandMetadata() options:NSJSONWritingSortedKeys error:nil];if(!data)throw std::runtime_error("The libplacebo filter metadata could not be encoded.");inspection.assign(static_cast<const char*>(data.bytes),data.length);lastError.clear();return inspection.c_str();}auto owner=context(MTLCreateSystemDefaultDevice());std::lock_guard<std::mutex> guard(owner->lock);
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
        const bool derived=planeHook(hook,source);
        NSDictionary *metadata=@{@"schema":@1,@"format":@"libplacebo",@"parameters":parameters,@"stages":stages,@"rgbCompatible":@(!hook->stages||rgbHook(hook)||derived),@"requiresDerivedPlanes":@(derived),@"inputRepresentation":derived?@"derived-ycbcr444":@"rgb",@"requirements":@{},@"upstream":@{@"name":@"libplacebo",@"version":@"7.360.1",@"url":@"https://libplacebo.org/custom-shaders/"}};
        NSData *data=[NSJSONSerialization dataWithJSONObject:metadata options:NSJSONWritingSortedKeys error:nil];if(!data)throw std::runtime_error("The shader metadata could not be encoded.");inspection.assign(static_cast<const char*>(data.bytes),data.length);pl_mpv_user_shader_destroy(&hook);lastError.clear();return inspection.c_str();
    }catch(...){pl_mpv_user_shader_destroy(&hook);throw;}
}catch(const std::exception &error){lastError=error.what();return nullptr;}}}
