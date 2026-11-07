// SPDX-License-Identifier: MIT
// Included in MVKCommandPool.mm. This adapter only forwards scene information;
// the loaded graphics pipeline owns provider selection, history and encoding.
#include "MVKImage.h"
#include "temporal-map.hpp"
#include "temporal-scene.hpp"
#include <dlfcn.h>
#include <mutex>
#include <unordered_map>
#include <array>
#include <atomic>
#include <chrono>
#import <MetalFX/MetalFX.h>
struct MVKTemporalPipeline {
    int (*process)(const RSTemporalFrame*,RSTemporalResult*)=nullptr;
    int (*matrices)(const RSTemporalFrame*,const RSSceneMatrices*)=nullptr;
    int (*aovs)(const RSTemporalFrame*,const RSSceneAovs*)=nullptr;
    uint32_t (*method)()=nullptr;
    void (*release)(void*)=nullptr;
    MVKTemporalPipeline() {
        void* address=dlsym(RTLD_DEFAULT,"rsProcessTemporalFrame"); Dl_info info{};
        if(!address||!dladdr(address,&info)||!info.dli_fname)return;
        // Keep the exact graphics library loaded while its histories exist.
        void* library=dlopen(info.dli_fname,RTLD_NOW|RTLD_LOCAL|RTLD_NODELETE|RTLD_NOLOAD);
        if(!library)return;
        process=(decltype(process))dlsym(library,"rsProcessTemporalFrame");
        matrices=(decltype(matrices))dlsym(library,"rsBindTemporalSceneMatrices");
        aovs=(decltype(aovs))dlsym(library,"rsBindTemporalSceneAovs");
        method=(decltype(method))dlsym(library,"rsGetTemporalMethod");
        release=(decltype(release))dlsym(library,"rsReleaseTemporalOwner");
        if(!process||!method||!release)process=nullptr;
    }
};
static const MVKTemporalPipeline& mvkTemporalPipeline(){static MVKTemporalPipeline pipeline;return pipeline;}
const char* mvkTemporalDriverInfo(id<MTLDevice> device){
    if(!mvkTemporalPipeline().process)return "";
    static void* framework=dlopen("/System/Library/Frameworks/MetalFX.framework/MetalFX",RTLD_LAZY|RTLD_LOCAL);
    Class descriptor=framework?NSClassFromString(@"MTLFXTemporalScalerDescriptor"):Nil;
    return descriptor&&[descriptor supportsDevice:device]?" temporal-sr":"";
}
struct MVKTemporalOwner {
    std::atomic<bool> reported{false};
    std::mutex mutex;
    id<MTLTexture> output=nil;
    bool hasOutput=false;
    bool metadataReported=false;
    double previousTime=0;
    ~MVKTemporalOwner(){mvkTemporalPipeline().release(this);[output release];}
};
struct MVKTemporalState {
    std::mutex mutex;
    std::unordered_map<uint64_t,std::shared_ptr<MVKTemporalOwner>> owners;
};
static std::mutex mvkTemporalStateMutex;
void mvkTemporalFinish(MVKDevice* device){delete device->_temporal;device->_temporal=nullptr;}
struct MVKTemporalRecord {
    RSTemporalFrame frame{};
    RSSceneMatrices matrices{};
    uint64_t featureId=0;
    uint32_t featureType=0,sceneFlags=0;
    bool roughnessAlias=false;
    std::array<id<MTLTexture>,TEMPORAL_IMAGES> textures{};
    std::shared_ptr<MVKTemporalOwner> owner;
    ~MVKTemporalRecord(){for(auto texture:textures)[texture release];}
};
VkResult MVKCmdTemporalFrame::setContent(MVKCommandBuffer* commands,const VkTemporalFrameInfoMVK* info){
    _frame.reset();
    if(!mvkTemporalPipeline().process||(info->featureType!=TEMPORAL_SUPER_RESOLUTION&&info->featureType!=TEMPORAL_RAY_RECONSTRUCTION))
        return VK_ERROR_FEATURE_NOT_PRESENT;
    if(!info->images[TEMPORAL_OUTPUT] || info->images[TEMPORAL_OUTPUT]==info->images[TEMPORAL_COLOR] ||
       info->images[TEMPORAL_OUTPUT]==info->images[TEMPORAL_DEPTH] ||
       info->images[TEMPORAL_OUTPUT]==info->images[TEMPORAL_MOTION])return VK_ERROR_INITIALIZATION_FAILED;
    auto record=std::make_shared<MVKTemporalRecord>();
    record->matrices=mvkTemporalScene_matrices(info);record->featureId=info->featureId;
    record->featureType=info->featureType;record->sceneFlags=info->flags;
    record->roughnessAlias=info->images[TEMPORAL_NORMALS]&&info->images[TEMPORAL_NORMALS]==info->images[TEMPORAL_ROUGHNESS];
    auto device=commands->getDevice();
    for(unsigned n=0;n<TEMPORAL_IMAGES;n++){
        if(!info->images[n])continue;
        auto image=(MVKImage*)info->images[n];
        if(image->getDevice()!=device||image->getPlaneCount()!=1||image->getSampleCount()!=VK_SAMPLE_COUNT_1_BIT)
            return VK_ERROR_FEATURE_NOT_PRESENT;
        auto texture=image->getMTLTexture();
        if(!texture||texture.textureType!=MTLTextureType2D||texture.framebufferOnly)
            return VK_ERROR_FEATURE_NOT_PRESENT;
        const auto format=info->formats[n]==VK_FORMAT_UNDEFINED?texture.pixelFormat:
            image->getPixelFormats()->getMTLPixelFormat(info->formats[n]);
        if(format==MTLPixelFormatInvalid)return VK_ERROR_FORMAT_NOT_SUPPORTED;
        if(format!=texture.pixelFormat){
            if(!(texture.usage&MTLTextureUsagePixelFormatView))return VK_ERROR_FORMAT_NOT_SUPPORTED;
            record->textures[n]=[texture newTextureViewWithPixelFormat:format];
        }else record->textures[n]=[texture retain];
        if(!record->textures[n])return VK_ERROR_FORMAT_NOT_SUPPORTED;
    }
    auto color=record->textures[TEMPORAL_COLOR],depth=record->textures[TEMPORAL_DEPTH];
    auto motion=record->textures[TEMPORAL_MOTION],output=record->textures[TEMPORAL_OUTPUT];
    if(!color||!depth||!motion||!output||color==output||depth==output||motion==output||
       !mvkTemporalMap(*info,color.width,color.height,depth.width,depth.height,motion.width,motion.height,
                       output.width,output.height,record->frame))return VK_ERROR_INITIALIZATION_FAILED;
    {
        std::lock_guard<std::mutex> lock(mvkTemporalStateMutex);
        if(!device->_temporal)device->_temporal=new MVKTemporalState;
    }
    {
        auto state=device->_temporal;std::lock_guard<std::mutex> lock(state->mutex);
        if(info->releaseFeatureIdCount&&!info->pReleaseFeatureIds)return VK_ERROR_INITIALIZATION_FAILED;
        for(uint32_t n=0;n<info->releaseFeatureIdCount;n++)state->owners.erase(info->pReleaseFeatureIds[n]);
        auto& owner=state->owners[info->featureId];if(!owner)owner=std::make_shared<MVKTemporalOwner>();
        record->owner=owner;
    }
    auto& f=record->frame;f.owner=record->owner.get();f.color=color;f.depth=depth;f.motion=motion;
    f.output=output;f.exposure=record->textures[TEMPORAL_EXPOSURE];
    commands->_hasTemporalFrame=true;
    _frame=std::move(record);return VK_SUCCESS;
}
void MVKCmdTemporalFrame::encode(MVKCommandEncoder* encoder){
    if(!_frame)return;
    auto commands=encoder->_mtlCmdBuffer;
    if(!commands||encoder->isInRenderPass()||commands.status>=MTLCommandBufferStatusCommitted){
        encoder->_cmdBuffer->setConfigurationResult(VK_ERROR_INITIALIZATION_FAILED);return;
    }
    encoder->endCurrentMetalEncoding();
    std::lock_guard<std::mutex> lock(_frame->owner->mutex);
    auto& owner=*_frame->owner;
    auto f=_frame->frame;f.commandBuffer=commands;f.commandBufferKind=0;
    id<MTLTexture> requested=_frame->textures[TEMPORAL_OUTPUT];
    if(!owner.output||owner.output.width!=f.outputWidth||owner.output.height!=f.outputHeight||owner.output.pixelFormat!=requested.pixelFormat){
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:requested.pixelFormat width:f.outputWidth height:f.outputHeight mipmapped:NO];
        descriptor.storageMode=MTLStorageModePrivate;descriptor.hazardTrackingMode=MTLHazardTrackingModeTracked;
        descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
        id<MTLTexture> made=[requested.device newTextureWithDescriptor:descriptor];
        if(!made){encoder->_cmdBuffer->setConfigurationResult(VK_ERROR_OUT_OF_DEVICE_MEMORY);return;}
        [owner.output release];owner.output=made;owner.hasOutput=false;
    }
    f.output=owner.output;f.outputX=f.outputY=0;
    const double now=std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
    // Match the existing driver/pipeline observation fallback only when the
    // producer supplies no timing. The first frame has no prior real pair.
    if(!(f.frameTimeMs>0))f.frameTimeMs=(float)std::clamp(owner.previousTime>0?(now-owner.previousTime)*1000.:1000./60.,.001,1000.);
    owner.previousTime=now;
    const auto& pipeline=mvkTemporalPipeline();const auto selected=pipeline.method();
    f.method=selected?selected:(_frame->featureType==TEMPORAL_RAY_RECONSTRUCTION?RS_TEMPORAL_METALFX_DENOISED:RS_TEMPORAL_METALFX);
    void* textures[TEMPORAL_IMAGES];uint32_t widths[TEMPORAL_IMAGES],heights[TEMPORAL_IMAGES];
    for(unsigned i=0;i<TEMPORAL_IMAGES;i++){textures[i]=_frame->textures[i];widths[i]=_frame->textures[i].width;heights[i]=_frame->textures[i].height;}
    RSSceneAovs aovs;const bool hasAovs=mvkTemporalScene_aovs(&f,_frame->featureId,_frame->featureType,_frame->sceneFlags,_frame->roughnessAlias,textures,widths,heights,&aovs);
    const int matricesStatus=!_frame->matrices.flags?RS_TEMPORAL_OK:pipeline.matrices?pipeline.matrices(&f,&_frame->matrices):RS_TEMPORAL_UNAVAILABLE;
    const int aovsStatus=!hasAovs?RS_TEMPORAL_OK:pipeline.aovs?pipeline.aovs(&f,&aovs):RS_TEMPORAL_UNAVAILABLE;
    if(!owner.metadataReported&&(matricesStatus||aovsStatus)){MVKLogWarn("Temporal scene bindings: matrices %d, AOVs %d",matricesStatus,aovsStatus);owner.metadataReported=true;}
    RSTemporalResult result{};result.size=sizeof(result);result.version=1;
    const auto status=pipeline.process(&f,&result);
    if(!_frame->owner->reported.load(std::memory_order_relaxed)){
        MVKLogInfo("Temporal frame %llu: method %u, %ux%u to %ux%u, status %d encoded %u (%s)",
            (unsigned long long)f.frameId,f.method,f.renderWidth,f.renderHeight,f.outputWidth,f.outputHeight,
            status,result.encoded,result.reason);
        _frame->owner->reported.store(status==RS_TEMPORAL_OK&&result.encoded,std::memory_order_relaxed);
    }
    if(status==RS_TEMPORAL_OK&&result.encoded)owner.hasOutput=true;
    else if(status!=RS_TEMPORAL_BUSY||!owner.hasOutput){
        // Without a previous complete image, BUSY cannot produce an output.
        encoder->_cmdBuffer->setConfigurationResult(VK_ERROR_INITIALIZATION_FAILED);return;
    }
    // The pipeline sees one complete tracked image. Preserve the actual SDK
    // target/subregion with a copy on this same MoltenVK command buffer.
    auto blit=encoder->getMTLBlitEncoder(kMVKCommandUseCopyImage);
    [blit copyFromTexture:owner.output sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)
              sourceSize:MTLSizeMake(f.outputWidth,f.outputHeight,1) toTexture:requested destinationSlice:0
        destinationLevel:0 destinationOrigin:MTLOriginMake(_frame->frame.outputX,_frame->frame.outputY,0)];
    encoder->endCurrentMetalEncoding();
}
MVKCommandTypePool<MVKCommand>* MVKCmdTemporalFrame::getTypePool(MVKCommandPool* pool){
    _frame.reset();return (MVKCommandTypePool<MVKCommand>*)&pool->_cmdTemporalFramePool;
}
