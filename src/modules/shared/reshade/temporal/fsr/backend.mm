#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "../frame.h"
#include "../command-order.hpp"
#include "sdk-compat.hpp"
#include "projection.hpp"
#include <algorithm>
#include <atomic>
#include <array>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
struct Resource {
    id<MTLTexture> texture;
    id<MTLBuffer> atomicBuffer;
    std::vector<id<MTLTexture>> mips;
    FfxResourceDescription description{};
    bool external = false;
};
struct Binding { unsigned index; std::string name; unsigned resourceIndex=0; };
struct Pipeline {
    id<MTLComputePipelineState> state;
    MTLSize threads;
    std::vector<Binding> atomicBuffers, samplers;
    std::array<unsigned,FFX_MAX_NUM_UAVS> spdMipBindings{};
};
struct Context {
    id<MTLDevice> device;
    id<MTLSamplerState> pointSampler, linearSampler;
    id<MTLComputePipelineState> clearFloat, clearUint;
    FfxFsr2Context sdk{};
    std::vector<Resource> resources{1};
    std::vector<FfxGpuJobDescription> jobs;
    std::vector<std::unique_ptr<Pipeline>> pipelines;
    std::vector<std::vector<uint32_t>> constants;
    size_t constantCursor=0;
#if RS_FSR3
    FfxResourceInternal sharedDepth{},sharedMotion{},sharedReconstructedDepth{};
#endif
    std::atomic<uint32_t> outstanding{0};
    __weak id<MTLCommandBuffer> tail;
    std::atomic<bool> failed{false};
    bool created = false;
    uint64_t lastFrame = 0;
    uint32_t flags = 0, maxWidth = 0, maxHeight = 0, width = 0, height = 0;
    unsigned activeSpdMips = 0;
    std::string shaderDirectory, error;
    ~Context() { if (created) ffxFsr2ContextDestroy(&sdk); }
};
struct FrameLease {
    std::shared_ptr<Context> context;
    std::array<id<MTLTexture>,7> textures;
    bool counted=false,completed=false;
    void retire(bool success) {
        if(!counted||completed)return;
        completed=true;
        if(!success)context->failed.store(true,std::memory_order_release);
        context->outstanding.fetch_sub(1,std::memory_order_acq_rel);
    }
    ~FrameLease() {
        // Metal releases handlers when an uncommitted buffer is discarded.
        // Its advanced CPU schedule must not become the next history frame.
        retire(false);
    }
};
struct Owner {
    std::mutex mutex;
    std::atomic<bool> released{false};
    std::shared_ptr<Context> context;
};
struct ProviderState {
    std::mutex ownersMutex, schedulerMutex;
    std::unordered_map<void *, std::shared_ptr<Owner>> owners;
};
ProviderState &state() {
    // Deferred native-owner retirement can run during process shutdown. Keep
    // the registry and its locks alive; explicit release still retires each
    // owner's history normally, including pending command-buffer leases.
    static auto *value=new ProviderState;
    return *value;
}
std::shared_ptr<Owner> ownerFor(void *identity) {
    auto &s=state(); std::lock_guard lock(s.ownersMutex);
    auto &entry=s.owners[identity];
    if(!entry)entry=std::make_shared<Owner>();
    return entry;
}
Context &get(FfxFsr2Interface *api) { return *static_cast<Context *>(api->scratchBuffer); }
FfxErrorCode fail(Context &c, const std::string &message) { c.error = message; return FFX_ERROR_BACKEND_API_ERROR; }
std::string narrow(NSString *value) { return value ? value.UTF8String : ""; }

MTLPixelFormat pixelFormat(FfxSurfaceFormat f) {
    switch (f) {
        case FFX_SURFACE_FORMAT_R32G32B32A32_TYPELESS: case FFX_SURFACE_FORMAT_R32G32B32A32_FLOAT: return MTLPixelFormatRGBA32Float;
        case FFX_SURFACE_FORMAT_R16G16B16A16_FLOAT: return MTLPixelFormatRGBA16Float;
#if !RS_FSR3
        case FFX_SURFACE_FORMAT_R16G16B16A16_UNORM: return MTLPixelFormatRGBA16Unorm;
#endif
        case FFX_SURFACE_FORMAT_R32G32_FLOAT: return MTLPixelFormatRG32Float;
        case FFX_SURFACE_FORMAT_R32_UINT: return MTLPixelFormatR32Uint;
        case FFX_SURFACE_FORMAT_R8G8B8A8_TYPELESS: case FFX_SURFACE_FORMAT_R8G8B8A8_UNORM: return MTLPixelFormatRGBA8Unorm;
        case FFX_SURFACE_FORMAT_R11G11B10_FLOAT: return MTLPixelFormatRG11B10Float;
        case FFX_SURFACE_FORMAT_R16G16_FLOAT: return MTLPixelFormatRG16Float;
        case FFX_SURFACE_FORMAT_R16G16_UINT: return MTLPixelFormatRG16Uint;
        case FFX_SURFACE_FORMAT_R16_FLOAT: return MTLPixelFormatR16Float;
        case FFX_SURFACE_FORMAT_R16_UINT: return MTLPixelFormatR16Uint;
        case FFX_SURFACE_FORMAT_R16_UNORM: return MTLPixelFormatR16Unorm;
        case FFX_SURFACE_FORMAT_R16_SNORM: return MTLPixelFormatR16Snorm;
        case FFX_SURFACE_FORMAT_R8_UNORM: return MTLPixelFormatR8Unorm;
        case FFX_SURFACE_FORMAT_R8_UINT: return MTLPixelFormatR8Uint;
        case FFX_SURFACE_FORMAT_R8G8_UNORM: return MTLPixelFormatRG8Unorm;
        case FFX_SURFACE_FORMAT_R32_FLOAT: return MTLPixelFormatR32Float;
        default: return MTLPixelFormatInvalid;
    }
}
FfxSurfaceFormat surfaceFormat(MTLPixelFormat f) {
    for (unsigned i=1; i<=FFX_SURFACE_FORMAT_R32_FLOAT; ++i) if (pixelFormat((FfxSurfaceFormat)i)==f) return (FfxSurfaceFormat)i;
    if (f==MTLPixelFormatDepth32Float || f==MTLPixelFormatDepth32Float_Stencil8) return FFX_SURFACE_FORMAT_R32_FLOAT;
    if(f==MTLPixelFormatBGRA8Unorm || f==MTLPixelFormatBGRA8Unorm_sRGB || f==MTLPixelFormatRGBA8Unorm_sRGB) return FFX_SURFACE_FORMAT_R8G8B8A8_UNORM;
    return FFX_SURFACE_FORMAT_UNKNOWN;
}
FfxResourceDescription describe(id<MTLTexture> t) {
    return {FFX_RESOURCE_TYPE_TEXTURE2D, surfaceFormat(t.pixelFormat), (uint32_t)t.width, (uint32_t)t.height, 1, (uint32_t)t.mipmapLevelCount, FFX_RESOURCE_FLAGS_NONE};
}
FfxResource external(void *p, bool depth=false) {
    FfxResource r{}; r.resource=p; r.state=FFX_RESOURCE_STATE_COMPUTE_READ;
#if !RS_FSR3
    r.isDepth=depth;
#endif
    if (p) r.description=describe((__bridge id<MTLTexture>)p);
    return r;
}

FfxErrorCode createResource(FfxFsr2Interface *api, const FfxCreateResourceDescription *desc, FfxResourceInternal *out) {
    Context &c=get(api); Resource r; r.description=desc->resourceDescription;
    const auto d=r.description; const auto format=pixelFormat(d.format);
    if (format==MTLPixelFormatInvalid || d.type!=FFX_RESOURCE_TYPE_TEXTURE2D || !d.width || !d.height) return fail(c,"Unsupported FSR2 resource format.");
    MTLTextureDescriptor *td=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:d.width height:d.height mipmapped:d.mipCount!=1];
    if (d.mipCount) td.mipmapLevelCount=d.mipCount;
#if RS_FSR3
    std::vector<unsigned char> fill;
    const void *initData=nullptr; size_t initDataSize=desc->initData.size;
    if(desc->initData.type==FFX_RESOURCE_INIT_DATA_TYPE_BUFFER)initData=desc->initData.buffer;
    else if(desc->initData.type==FFX_RESOURCE_INIT_DATA_TYPE_VALUE){fill.assign(initDataSize,desc->initData.value);initData=fill.data();}
#else
    const void *initData=desc->initData; size_t initDataSize=desc->initDataSize;
#endif
    td.storageMode=initData ? MTLStorageModeShared : MTLStorageModePrivate;
    td.usage=MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite | MTLTextureUsagePixelFormatView;
    if (format==MTLPixelFormatR32Uint) {
        // SPIRV-Cross preserves image atomic operations using a buffer alias.
        // Its alignment function constant matches this exact row pitch.
        const NSUInteger alignment=[c.device minimumLinearTextureAlignmentForPixelFormat:format];
        const NSUInteger row=(d.width*4+alignment-1)&~(alignment-1);
        td.storageMode=MTLStorageModeShared;
        r.atomicBuffer=[c.device newBufferWithLength:row*d.height options:MTLResourceStorageModeShared];
        r.texture=[r.atomicBuffer newTextureWithDescriptor:td offset:0 bytesPerRow:row];
    } else r.texture=[c.device newTextureWithDescriptor:td];
    if (!r.texture) return fail(c,"Metal could not allocate an FSR2 texture.");
    if (initData) {
        const NSUInteger bytesPerRow=initDataSize/d.height;
        [r.texture replaceRegion:MTLRegionMake2D(0,0,d.width,d.height) mipmapLevel:0 withBytes:initData bytesPerRow:bytesPerRow];
    }
    r.description.mipCount=(uint32_t)r.texture.mipmapLevelCount;
    for (NSUInteger mip=0;mip<r.texture.mipmapLevelCount;++mip) {
        id<MTLTexture> view=r.texture.mipmapLevelCount==1 ? r.texture : [r.texture newTextureViewWithPixelFormat:format textureType:MTLTextureType2D levels:NSMakeRange(mip,1) slices:NSMakeRange(0,1)];
        if (!view) return fail(c,"Metal could not create an FSR2 mip view.");
        r.mips.push_back(view);
    }
    out->internalIndex=(int)c.resources.size(); c.resources.push_back(std::move(r)); return FFX_OK;
}
FfxErrorCode registerResource(FfxFsr2Interface *api,const FfxResource *r,FfxResourceInternal *out) {
    Context &c=get(api);
    if (!r->resource) { out->internalIndex=0; return FFX_OK; }
    for(size_t n=1;n<c.resources.size();++n)if((__bridge void *)c.resources[n].texture==r->resource){out->internalIndex=(int)n;return FFX_OK;}
    Resource value; value.texture=(__bridge id<MTLTexture>)r->resource; value.description=r->description; value.external=true;
    out->internalIndex=(int)c.resources.size(); c.resources.push_back(std::move(value)); return FFX_OK;
}
FfxErrorCode unregisterResources(FfxFsr2Interface *api) {
    auto &resources=get(api).resources;
    while (resources.size()>1 && resources.back().external) resources.pop_back();
    return FFX_OK;
}
FfxErrorCode destroyResource(FfxFsr2Interface *api,FfxResourceInternal r) { auto &c=get(api); if(r.internalIndex>0 && (size_t)r.internalIndex<c.resources.size()) c.resources[r.internalIndex]=Resource{}; return FFX_OK; }
FfxResourceDescription resourceDescription(FfxFsr2Interface *api,FfxResourceInternal r) { auto &c=get(api); return c.resources.at(r.internalIndex).description; }
void bindingName(FfxResourceBinding &b,const std::string &name,unsigned index) {
    b.slotIndex=index;
    for(size_t n=0;n<name.size() && n<63;++n) b.name[n]=(wchar_t)(unsigned char)name[n];
}
FfxErrorCode createPipeline(FfxFsr2Interface *api,FfxFsr2Pass pass,const FfxPipelineDescription *description,FfxPipelineState *out) {
    Context &c=get(api); auto p=std::make_unique<Pipeline>();
    const uint32_t f=description->contextFlags;
    unsigned variant=(f&FFX_FSR2_ENABLE_HIGH_DYNAMIC_RANGE?1:0)|(f&FFX_FSR2_ENABLE_DEPTH_INVERTED?2:0)|(f&FFX_FSR2_ENABLE_DISPLAY_RESOLUTION_MOTION_VECTORS?4:0)|(f&FFX_FSR2_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION?8:0);
    NSString *base=[NSString stringWithFormat:@"%s/%s/%u/%u",c.shaderDirectory.c_str(),shaderGroup,variant,(unsigned)pass];
    NSError *error=nil;
    NSString *source=[NSString stringWithContentsOfFile:[base stringByAppendingString:@".metal"] encoding:NSUTF8StringEncoding error:&error];
    NSData *metadata=[NSData dataWithContentsOfFile:[base stringByAppendingString:@".json"]];
    NSDictionary *info=metadata?[NSJSONSerialization JSONObjectWithData:metadata options:0 error:&error]:nil;
    if(!source || !info) return fail(c,"FidelityFX shader resources are unavailable.");
    MTLCompileOptions *options=[MTLCompileOptions new]; options.languageVersion=MTLLanguageVersion2_3;
    id<MTLLibrary> library=[c.device newLibraryWithSource:source options:options error:&error];
    if(!library) return fail(c,"FidelityFX Metal compilation failed: "+narrow(error.localizedDescription));
    MTLFunctionConstantValues *constants=[MTLFunctionConstantValues new];
    uint32_t alignment=(uint32_t)[c.device minimumLinearTextureAlignmentForPixelFormat:MTLPixelFormatR32Uint];
    [constants setConstantValue:&alignment type:MTLDataTypeUInt atIndex:65535];
    id<MTLFunction> function=[library newFunctionWithName:info[@"entry"] constantValues:constants error:&error];
    if(!function) return fail(c,"FidelityFX Metal function creation failed: "+narrow(error.localizedDescription));
    p->state=[c.device newComputePipelineStateWithFunction:function error:&error];
    if(!p->state) return fail(c,"FidelityFX Metal pipeline creation failed: "+narrow(error.localizedDescription));
    NSArray *threads=info[@"threads"]; p->threads=MTLSizeMake([threads[0] unsignedIntegerValue],[threads[1] unsignedIntegerValue],[threads[2] unsignedIntegerValue]);
    if(p->threads.width*p->threads.height*p->threads.depth>p->state.maxTotalThreadsPerThreadgroup) return fail(c,"FidelityFX thread group exceeds this Metal device's limit.");
    *out={};
    for(NSDictionary *item in info[@"bindings"]) {
        const std::string name=narrow(item[@"name"]),kind=narrow(item[@"kind"]); const unsigned index=[item[@"index"] unsignedIntValue];
        if(kind=="texture") {
            if(name.rfind("rw_",0)==0) {
                if(out->uavCount>=FFX_MAX_NUM_UAVS)return fail(c,"Too many FSR2 output bindings.");
                const auto binding=out->uavCount++;
                bindingName(out->uavResourceBindings[binding],name,index);
#if RS_FSR3
                if(name.size()==11 && name.compare(0,10,"rw_spd_mip")==0 && name.back()>='0' && name.back()<='5')p->spdMipBindings[binding]=unsigned(name.back()-'0')+1;
#else
                if(name=="rw_img_mip_shading_change")p->spdMipBindings[binding]=5;
                else if(name=="rw_img_mip_5")p->spdMipBindings[binding]=6;
#endif
            }
            else { if(out->srvCount>=FFX_MAX_NUM_SRVS)return fail(c,"Too many FSR2 input bindings."); bindingName(out->srvResourceBindings[out->srvCount++],name,index); }
        } else if(kind=="buffer" && name.size()>7 && name.compare(name.size()-7,7,"_atomic")==0) p->atomicBuffers.push_back({index,name.substr(0,name.size()-7)});
        else if(kind=="buffer") { if(out->constCount>=FFX_MAX_NUM_CONST_BUFFERS)return fail(c,"Too many FSR2 constant bindings."); bindingName(out->cbResourceBindings[out->constCount++],name,index); }
        else if(kind=="sampler") p->samplers.push_back({index,name});
    }
    for(auto &binding:p->atomicBuffers){
        const std::wstring name(binding.name.begin(),binding.name.end()); bool found=false;
        for(unsigned n=0;n<out->uavCount;++n)if(name==out->uavResourceBindings[n].name){binding.resourceIndex=n;found=true;break;}
        if(!found)return fail(c,"FidelityFX atomic texture binding is missing.");
    }
    out->pipeline=p.get(); c.pipelines.push_back(std::move(p)); return FFX_OK;
}
FfxErrorCode destroyPipeline(FfxFsr2Interface *,FfxPipelineState *) { return FFX_OK; }
FfxErrorCode schedule(FfxFsr2Interface *api,const FfxGpuJobDescription *job) { get(api).jobs.push_back(*job); return FFX_OK; }
Resource *resource(Context &c,FfxResourceInternal index) { return index.internalIndex>0 && (size_t)index.internalIndex<c.resources.size()?&c.resources[index.internalIndex]:nullptr; }
FfxErrorCode execute(FfxFsr2Interface *api,FfxCommandList list) {
    Context &c=get(api); id<MTLCommandBuffer> command=(__bridge id<MTLCommandBuffer>)list;
    for(const auto &job:c.jobs) {
        if(job.jobType==FFX_GPU_JOB_CLEAR_FLOAT) {
            const auto &clear=job.clearJobDescriptor; Resource *r=resource(c,clear.target);
            if(!r)return fail(c,"FidelityFX clear references a missing texture.");
            for(id<MTLTexture> texture:r->mips) {
                id<MTLComputeCommandEncoder> encoder=[command computeCommandEncoder];
                [encoder setComputePipelineState:texture.pixelFormat==MTLPixelFormatR32Uint?c.clearUint:c.clearFloat];
                [encoder setTexture:texture atIndex:0]; [encoder setBytes:clear.color length:sizeof(clear.color) atIndex:0];
                [encoder dispatchThreads:MTLSizeMake(texture.width,texture.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)]; [encoder endEncoding];
            }
        } else if(job.jobType==FFX_GPU_JOB_COMPUTE) {
            const auto &compute=job.computeJobDescriptor; Pipeline &p=*static_cast<Pipeline *>(compute.pipeline.pipeline);
            id<MTLComputeCommandEncoder> encoder=[command computeCommandEncoder]; [encoder setComputePipelineState:p.state];
            for(unsigned n=0;n<compute.pipeline.srvCount;++n) {
                Resource *r=resource(c,inputResource(compute,n)); if(!r){[encoder endEncoding];return fail(c,"FidelityFX input resource is missing.");}
                [encoder setTexture:r->texture atIndex:compute.pipeline.srvResourceBindings[n].slotIndex];
            }
            for(unsigned n=0;n<compute.pipeline.uavCount;++n) {
                Resource *r=resource(c,outputResource(compute,n)); const unsigned mip=outputMip(compute,n);
                unsigned viewMip=mip;
                if(r && !r->external && mip>=r->mips.size() && !r->mips.empty() && p.spdMipBindings[n]==mip+1 && mip>=c.activeSpdMips && c.activeSpdMips>=3) {
                    // The fixed SPD descriptor set includes mip slots beyond a
                    // small pyramid. Those stores/loads are inactive under the
                    // original SPD mip count; bind a valid view without changing
                    // that count, resource dimensions or any active mip.
                    viewMip=(unsigned)r->mips.size()-1;
                }
                if(!r || (r->external?mip!=0:viewMip>=r->mips.size())){[encoder endEncoding];return fail(c,"FidelityFX output mip is missing.");}
                [encoder setTexture:r->external?r->texture:r->mips[viewMip] atIndex:compute.pipeline.uavResourceBindings[n].slotIndex];
            }
            for(const auto &binding:p.atomicBuffers){
                Resource *r=resource(c,outputResource(compute,binding.resourceIndex));
                if(!r || !r->atomicBuffer){[encoder endEncoding];return fail(c,"FidelityFX atomic buffer is missing.");}
                [encoder setBuffer:r->atomicBuffer offset:0 atIndex:binding.index];
            }
            for(unsigned n=0;n<compute.pipeline.constCount;++n) [encoder setBytes:compute.cbs[n].data length:compute.cbs[n].uint32Size*4 atIndex:constantSlot(compute,n)];
            for(const auto &binding:p.samplers) [encoder setSamplerState:binding.name.find("Linear")!=std::string::npos?c.linearSampler:c.pointSampler atIndex:binding.index];
            [encoder dispatchThreadgroups:MTLSizeMake(compute.dimensions[0],compute.dimensions[1],compute.dimensions[2]) threadsPerThreadgroup:p.threads]; [encoder endEncoding];
        } else if(job.jobType==FFX_GPU_JOB_COPY) {
            Resource *src=resource(c,job.copyJobDescriptor.src),*dst=resource(c,job.copyJobDescriptor.dst);
            if(!src || !dst)return fail(c,"FidelityFX copy resource is missing.");
            id<MTLBlitCommandEncoder> encoder=[command blitCommandEncoder]; [encoder copyFromTexture:src->texture toTexture:dst->texture]; [encoder endEncoding];
        }
#if RS_FSR3
        else if(job.jobType==FFX_GPU_JOB_DISCARD) { /* Private textures have no preservation cost to discard. */ }
#endif
        else return fail(c,"FidelityFX issued an unsupported GPU command.");
    }
    c.jobs.clear(); c.constantCursor=0; return FFX_OK;
}
bool initialize(Context &c,const RSTemporalFrame &frame) {
    const char *root=std::getenv("RESHADE_FSR_SHADER_DIRECTORY");
    if(!root || !*root){c.error="FidelityFX shader resources are unavailable.";return false;}
    c.shaderDirectory=root; c.flags=frame.flags&~RS_TEMPORAL_RESET;
    c.maxWidth=frame.maxRenderWidth?frame.maxRenderWidth:frame.renderWidth; c.maxHeight=frame.maxRenderHeight?frame.maxRenderHeight:frame.renderHeight;
    c.width=frame.outputWidth; c.height=frame.outputHeight;
    c.jobs.reserve(32); c.resources.reserve(96); c.pipelines.reserve(9);
    MTLSamplerDescriptor *sampler=[MTLSamplerDescriptor new]; sampler.sAddressMode=sampler.tAddressMode=sampler.rAddressMode=MTLSamplerAddressModeClampToEdge;
    sampler.minFilter=sampler.magFilter=MTLSamplerMinMagFilterNearest; c.pointSampler=[c.device newSamplerStateWithDescriptor:sampler];
    sampler.minFilter=sampler.magFilter=MTLSamplerMinMagFilterLinear; c.linearSampler=[c.device newSamplerStateWithDescriptor:sampler];
    NSString *source=@"#include <metal_stdlib>\nusing namespace metal;\n"
        "kernel void clearFloat(texture2d<float,access::write> out [[texture(0)]],constant float4 &value [[buffer(0)]],uint2 p [[thread_position_in_grid]]) { if(p.x<out.get_width()&&p.y<out.get_height())out.write(value,p); }\n"
        "kernel void clearUint(texture2d<uint,access::write> out [[texture(0)]],constant float4 &value [[buffer(0)]],uint2 p [[thread_position_in_grid]]) { if(p.x<out.get_width()&&p.y<out.get_height())out.write(as_type<uint4>(value),p); }\n";
    NSError *error=nil; id<MTLLibrary> library=[c.device newLibraryWithSource:source options:nil error:&error];
    c.clearFloat=[c.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"clearFloat"] error:&error];
    c.clearUint=[c.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"clearUint"] error:&error];
    if(!c.clearFloat || !c.clearUint){c.error=narrow(error.localizedDescription);return false;}
    FfxFsr2ContextDescription desc{};
    desc.maxRenderSize={c.maxWidth,c.maxHeight};
#if RS_FSR3
    desc.maxUpscaleSize={c.width,c.height}; desc.backendInterface.device=(__bridge void *)c.device;
#else
    desc.displaySize={c.width,c.height}; desc.device=(__bridge void *)c.device;
#endif
    desc.flags=FFX_FSR2_ENABLE_DYNAMIC_RESOLUTION;
    if(frame.flags&RS_TEMPORAL_HDR)desc.flags|=FFX_FSR2_ENABLE_HIGH_DYNAMIC_RANGE;
    if(frame.flags&RS_TEMPORAL_DEPTH_REVERSED)desc.flags|=FFX_FSR2_ENABLE_DEPTH_INVERTED;
    if(frame.flags&RS_TEMPORAL_DEPTH_INFINITE)desc.flags|=FFX_FSR2_ENABLE_DEPTH_INFINITE;
    if(frame.flags&RS_TEMPORAL_OUTPUT_MOTION)desc.flags|=FFX_FSR2_ENABLE_DISPLAY_RESOLUTION_MOTION_VECTORS;
    if(frame.flags&RS_TEMPORAL_JITTERED_MOTION)desc.flags|=FFX_FSR2_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION;
    if(frame.flags&RS_TEMPORAL_AUTO_EXPOSURE)desc.flags|=FFX_FSR2_ENABLE_AUTO_EXPOSURE;
#if RS_FSR3
    auto &a=desc.backendInterface; a.scratchBuffer=&c; a.scratchBufferSize=sizeof(c);
    a.fpGetSDKVersion=[](FfxInterface *)->FfxVersionNumber{return FFX_SDK_MAKE_VERSION(1,1,4);};
    a.fpCreateBackendContext=[](FfxInterface *,FfxEffect,FfxEffectBindlessConfig *,FfxUInt32 *id)->FfxErrorCode{*id=0;return FFX_OK;};
    a.fpDestroyBackendContext=[](FfxInterface *,FfxUInt32)->FfxErrorCode{return FFX_OK;};
    a.fpGetDeviceCapabilities=[](FfxInterface *,FfxDeviceCapabilities *caps)->FfxErrorCode{*caps={};caps->maximumSupportedShaderModel=FFX_SHADER_MODEL_6_0;caps->waveLaneCountMin=caps->waveLaneCountMax=32;return FFX_OK;};
    a.fpCreateResource=[](FfxInterface *a,const FfxCreateResourceDescription *d,FfxUInt32,FfxResourceInternal *r){return createResource(a,d,r);};
    a.fpRegisterResource=[](FfxInterface *a,const FfxResource *r,FfxUInt32,FfxResourceInternal *o){return registerResource(a,r,o);};
    a.fpUnregisterResources=[](FfxInterface *a,FfxCommandList,FfxUInt32){return unregisterResources(a);};
    a.fpGetResourceDescription=resourceDescription;
    a.fpDestroyResource=[](FfxInterface *a,FfxResourceInternal r,FfxUInt32){return destroyResource(a,r);};
    a.fpCreatePipeline=[](FfxInterface *a,FfxEffect,FfxPass pass,uint32_t,const FfxPipelineDescription *d,FfxUInt32,FfxPipelineState *p){return createPipeline(a,pass,d,p);};
    a.fpDestroyPipeline=[](FfxInterface *a,FfxPipelineState *p,FfxUInt32){return destroyPipeline(a,p);};
    a.fpScheduleGpuJob=schedule;
    a.fpExecuteGpuJobs=[](FfxInterface *a,FfxCommandList list,FfxUInt32){return execute(a,list);};
    a.fpStageConstantBufferDataFunc=[](FfxInterface *a,void *data,FfxUInt32 size,FfxConstantBuffer *b)->FfxErrorCode{
        auto &c=get(a);if(c.constantCursor==c.constants.size())c.constants.emplace_back();
        auto &v=c.constants[c.constantCursor++];v.resize((size+3)/4);std::memcpy(v.data(),data,size);b->data=v.data();b->num32BitEntries=(size+3)/4;return FFX_OK;
    };
#else
    auto &a=desc.callbacks; a.scratchBuffer=&c; a.scratchBufferSize=sizeof(c);
    a.fpCreateBackendContext=[](FfxFsr2Interface *,FfxDevice){return FFX_OK;};
    a.fpDestroyBackendContext=[](FfxFsr2Interface *){return FFX_OK;};
    a.fpGetDeviceCapabilities=[](FfxFsr2Interface *,FfxDeviceCapabilities *caps,FfxDevice){*caps={FFX_SHADER_MODEL_6_0,32,32,false,false};return FFX_OK;};
    a.fpCreateResource=createResource; a.fpRegisterResource=registerResource; a.fpUnregisterResources=unregisterResources; a.fpGetResourceDescription=resourceDescription; a.fpDestroyResource=destroyResource;
    a.fpCreatePipeline=createPipeline; a.fpDestroyPipeline=destroyPipeline; a.fpScheduleGpuJob=schedule; a.fpExecuteGpuJobs=execute;
#endif
    const auto status=ffxFsr2ContextCreate(&c.sdk,&desc);
    if(status!=FFX_OK){if(c.error.empty())c.error="FidelityFX context initialization failed.";return false;}
    c.created=true;
#if RS_FSR3
    FfxFsr3UpscalerSharedResourceDescriptions shared{};
    if(ffxFsr3UpscalerGetSharedResourceDescriptions(&c.sdk,&shared)!=FFX_OK ||
       createResource(&a,&shared.dilatedDepth,&c.sharedDepth)!=FFX_OK ||
       createResource(&a,&shared.dilatedMotionVectors,&c.sharedMotion)!=FFX_OK ||
       createResource(&a,&shared.reconstructedPrevNearestDepth,&c.sharedReconstructedDepth)!=FFX_OK)return false;
#endif
    return true;
}
int result(RSTemporalResult *out,int status,const std::string &reason,bool encoded=false,bool reset=false) {
    if(out){out->status=status;out->encoded=encoded;out->method=temporalMethod;out->reset=reset;std::snprintf(out->reason,sizeof(out->reason),"%s",reason.c_str());}return status;
}
int process(const RSTemporalFrame *frame,RSTemporalResult *out,bool prepareOnly) {
    @autoreleasepool {
        if(!frame || frame->size<sizeof(*frame) || frame->version!=1 || frame->method!=temporalMethod || !frame->owner || frame->commandBufferKind!=0)
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires a version 1 Metal command-buffer frame.");
        if(!(frame->flags&RS_TEMPORAL_CAMERA_VALID) || !std::isfinite(frame->nearPlane) || frame->nearPlane<=0 ||
           !std::isfinite(frame->verticalFov) || frame->verticalFov<=0 || frame->verticalFov>=3.14159265f ||
           (!(frame->flags&RS_TEMPORAL_DEPTH_INFINITE) && (!std::isfinite(frame->farPlane) || frame->farPlane<=frame->nearPlane)))
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires the frame's near plane, far plane and vertical field of view.");
        if(frame->colorX || frame->colorY || frame->depthX || frame->depthY || frame->motionX || frame->motionY || frame->outputX || frame->outputY)
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires textures whose scene region starts at the origin.");
        if(!frame->commandBuffer || !frame->color || !frame->depth || !frame->motion || !frame->output || !frame->renderWidth || !frame->renderHeight || !frame->outputWidth || !frame->outputHeight)
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires color, depth, motion and output textures.");
        id<MTLCommandBuffer> command=(__bridge id<MTLCommandBuffer>)frame->commandBuffer;
        if(command.status>=MTLCommandBufferStatusCommitted)return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires an uncommitted command buffer.");
        for(void *value:{frame->color,frame->depth,frame->motion,frame->output,frame->exposure,frame->reactive,frame->transparency}) {
            if(!value)continue; id<MTLTexture> t=(__bridge id<MTLTexture>)value;
            if(t.device!=command.device || t.textureType!=MTLTextureType2D || t.sampleCount!=1 || surfaceFormat(t.pixelFormat)==FFX_SURFACE_FORMAT_UNKNOWN)
                return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires supported 2D textures on the command buffer's Metal device.");
        }
        id<MTLTexture> color=(__bridge id<MTLTexture>)frame->color,depth=(__bridge id<MTLTexture>)frame->depth,motion=(__bridge id<MTLTexture>)frame->motion,output=(__bridge id<MTLTexture>)frame->output;
        const unsigned mw=frame->flags&RS_TEMPORAL_OUTPUT_MOTION?frame->outputWidth:frame->renderWidth,mh=frame->flags&RS_TEMPORAL_OUTPUT_MOTION?frame->outputHeight:frame->renderHeight;
        if(color.width<frame->renderWidth || color.height<frame->renderHeight || depth.width<frame->renderWidth || depth.height<frame->renderHeight || motion.width<mw || motion.height<mh || output.width!=frame->outputWidth || output.height!=frame->outputHeight || !(output.usage&MTLTextureUsageShaderWrite))
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX texture dimensions or output write usage are incompatible.");
        if(!std::isfinite(frame->preExposure) || frame->preExposure<=0 || !std::isfinite(frame->frameTimeMs) || frame->frameTimeMs<=0 || !std::isfinite(frame->motionScaleX) || !std::isfinite(frame->motionScaleY) || !std::isfinite(frame->jitterX) || !std::isfinite(frame->jitterY))
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX requires finite jitter, motion scale, exposure and frame timing.");
#if !RS_FSR3
        // The original FSR2 shading-change pass consumes renderSize / 32 in
        // both axes. A smaller footprint has zero-sized luminance coordinates;
        // let the shared executor retain its other usable processing instead.
        if(frame->renderWidth<32 || frame->renderHeight<32)
            return result(out,RS_TEMPORAL_INVALID,"FSR 2 requires a scene region of at least 32 by 32 for its luminance pyramid.");
#endif
        auto owner=ownerFor(frame->owner);
        std::unique_lock ownerLock(owner->mutex,std::try_to_lock);
        if(!ownerLock.owns_lock() || owner->released.load())return result(out,RS_TEMPORAL_BUSY,"The FidelityFX owner is preparing or retiring.");
        auto &slot=owner->context;
        const unsigned maxWidth=frame->maxRenderWidth?frame->maxRenderWidth:frame->renderWidth,maxHeight=frame->maxRenderHeight?frame->maxRenderHeight:frame->renderHeight;
        if(frame->renderWidth>maxWidth || frame->renderHeight>maxHeight || maxWidth>frame->outputWidth || maxHeight>frame->outputHeight)
            return result(out,RS_TEMPORAL_INVALID,"FidelityFX render dimensions exceed the context's output or maximum render size.");
        const bool changed=slot&&(slot->device!=command.device || slot->flags!=(frame->flags&~RS_TEMPORAL_RESET) || slot->maxWidth!=maxWidth || slot->maxHeight!=maxHeight || slot->width!=frame->outputWidth || slot->height!=frame->outputHeight);
        if(slot && slot->outstanding.load(std::memory_order_acquire) &&
           (changed || slot->failed.load(std::memory_order_acquire) || (!prepareOnly && !macfx::orderedTemporalCommands(slot->tail,command))))
            return result(out,RS_TEMPORAL_BUSY,"The previous FidelityFX frames require ordered completion.");
        if(slot && (changed || slot->failed.load(std::memory_order_acquire)))slot.reset();
        if(!slot){auto fresh=std::make_shared<Context>();fresh->device=command.device;if(!initialize(*fresh,*frame))return result(out,RS_TEMPORAL_FAILED,fresh->error);slot=std::move(fresh);}
        if(owner->released.load())return result(out,RS_TEMPORAL_BUSY,"The FidelityFX owner was released during preparation.");
        if(prepareOnly)return result(out,RS_TEMPORAL_OK,"");
        // AMD's 2.2 scheduler uses shared CPU constant-buffer storage. Serialize
        // encoding only, keeping shader preparation independent of other owners
        // and never waiting on another producer or submitted GPU work.
        std::unique_lock schedulerLock(state().schedulerMutex,std::try_to_lock);
        if(!schedulerLock.owns_lock())return result(out,RS_TEMPORAL_BUSY,"Another FidelityFX owner is encoding.");
        auto context=slot; const bool reset=(frame->flags&RS_TEMPORAL_RESET)||!context->lastFrame||frame->frameId!=context->lastFrame+1;
        FfxFsr2DispatchDescription desc{}; desc.commandList=frame->commandBuffer;
        desc.color=external(frame->color);desc.depth=external(frame->depth,true);desc.motionVectors=external(frame->motion);desc.output=external(frame->output);
        desc.exposure=external(frame->exposure);desc.reactive=external(frame->reactive);desc.transparencyAndComposition=external(frame->transparency);
        desc.jitterOffset={frame->jitterX,frame->jitterY};desc.motionVectorScale={frame->motionScaleX,frame->motionScaleY};desc.renderSize={frame->renderWidth,frame->renderHeight};
#if RS_FSR3
        desc.upscaleSize={frame->outputWidth,frame->outputHeight};
        desc.dilatedDepth=external((__bridge void *)context->resources[context->sharedDepth.internalIndex].texture);
        desc.dilatedMotionVectors=external((__bridge void *)context->resources[context->sharedMotion.internalIndex].texture);
        desc.reconstructedPrevNearestDepth=external((__bridge void *)context->resources[context->sharedReconstructedDepth.internalIndex].texture);
#endif
        desc.enableSharpening=frame->sharpness>0;desc.sharpness=std::clamp(frame->sharpness,0.f,1.f);desc.frameTimeDelta=frame->frameTimeMs;desc.preExposure=frame->preExposure;desc.reset=reset;
        rsFsrCameraPlanes(*frame,desc.cameraNear,desc.cameraFar);desc.cameraFovAngleVertical=frame->verticalFov;desc.viewSpaceToMetersFactor=1.f;
        // The retained context protects history resources until completion even
        // when the caller releases its owner before committing this buffer.
        // Install the exact flight before dispatch: a failed partial encode
        // still owns its resources until completion or command abandonment.
        auto lease=std::make_shared<FrameLease>();lease->context=context;
        lease->textures={color,depth,motion,output,(__bridge id<MTLTexture>)frame->exposure,(__bridge id<MTLTexture>)frame->reactive,(__bridge id<MTLTexture>)frame->transparency};
        context->outstanding.fetch_add(1,std::memory_order_relaxed);lease->counted=true;
        context->tail=command;
        [command addCompletedHandler:^(id<MTLCommandBuffer> completed){
            lease->retire(completed.status==MTLCommandBufferStatusCompleted);
        }];
        context->error.clear();
        context->activeSpdMips=31u-(unsigned)__builtin_clz(std::max(frame->renderWidth,frame->renderHeight));
        const auto status=ffxFsr2ContextDispatch(&context->sdk,&desc);
        if(status!=FFX_OK || !context->error.empty()){context->failed=true;return result(out,RS_TEMPORAL_FAILED,context->error.empty()?"FidelityFX frame encoding failed.":context->error);}
        context->lastFrame=frame->frameId;
        return result(out,RS_TEMPORAL_OK,"",true,reset);
    }
}
int encode(const RSTemporalFrame *frame,RSTemporalResult *out) { return process(frame,out,false); }
void release(void *identity) {
    std::shared_ptr<Owner> retired;
    auto &s=state();
    {
        std::lock_guard lock(s.ownersMutex);
        const auto found=s.owners.find(identity);
        if(found==s.owners.end())return;
        retired=std::move(found->second); s.owners.erase(found);
        retired->released=true;
    }
}
}
extern "C" __attribute__((visibility("default"))) const RSTemporalProvider *rsGetTemporalProvider(uint32_t version) {
    static const RSTemporalProvider provider={sizeof(RSTemporalProvider),1,1u<<temporalMethod,0,encode,release};
    return version==1?&provider:nullptr;
}
extern "C" __attribute__((visibility("default"))) int rsPrepareTemporalResources(const RSTemporalFrame *frame,RSTemporalResult *out) {
    return process(frame,out,true);
}
