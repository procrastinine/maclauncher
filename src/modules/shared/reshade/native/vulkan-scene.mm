// Copyright (c) MacLauncher contributors. MIT license.
#include "vulkan-scene.h"
#include "image-admission.hpp"
#include <array>
#include <atomic>
#include <cstring>
#include <mutex>
#include <new>
#include <dispatch/dispatch.h>

namespace macfx { dispatch_queue_t effectPreparationQueue(); }
namespace {
constexpr unsigned count=RS_VULKAN_SCENE_IMAGE_COUNT;
constexpr uint32_t required=(1u<<RS_VULKAN_SCENE_COLOR)|(1u<<RS_VULKAN_SCENE_OUTPUT);
constexpr std::array<void* RSTemporalFrame::*,RS_VULKAN_SCENE_AOV_FIRST> fields={
    &RSTemporalFrame::color,&RSTemporalFrame::depth,&RSTemporalFrame::motion,
    &RSTemporalFrame::output,&RSTemporalFrame::exposure,&RSTemporalFrame::reactive,
    &RSTemporalFrame::transparency};
struct Region {
    uint32_t x=0,y=0,width=0,height=0;
};
struct ImageKey {
    uint32_t width=0,height=0;MTLPixelFormat format=MTLPixelFormatInvalid;
    MTLTextureUsage usage=MTLTextureUsageUnknown;
    bool operator==(const ImageKey& b)const{return width==b.width&&height==b.height&&format==b.format&&usage==b.usage;}
    bool covers(const ImageKey& b)const{return width>=b.width&&height>=b.height&&format==b.format&&usage==b.usage;}
};
struct Key {
    id<MTLDevice> device=nil;id<MTLCommandQueue> queue=nil;
    std::array<ImageKey,count> images{};uint32_t mask=0;
    bool operator==(const Key& b)const{return device==b.device&&queue==b.queue&&mask==b.mask&&images==b.images;}
    bool covers(const Key& b)const{
        if(device!=b.device||queue!=b.queue||mask!=b.mask)return false;
        for(unsigned i=0;i<count;++i)if(!images[i].covers(b.images[i]))return false;
        return true;
    }
};
struct Images {
    std::array<macfx::PooledImage,count> held{};
};
struct Prepared {
    Key key;macfx::ImagePoolClient client;
    std::array<macfx::PreparedImageLease,count> images{};
    explicit Prepared(const Key& value):key(value),client(value.device){
        for(unsigned i=0;i<count;++i)if(key.mask&(1u<<i)){
            const auto& image=key.images[i];
            auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:image.format width:image.width height:image.height mipmapped:NO];
            descriptor.storageMode=MTLStorageModePrivate;
            descriptor.hazardTrackingMode=MTLHazardTrackingModeTracked;
            descriptor.usage=image.usage;
            const auto role=std::string("vulkan-scene-")+std::to_string(i);
            images[i]=client.prepare(descriptor,role,4);
        }
    }
    void warm(){for(const auto& image:images)if(image&&!image.prepare())throw macfx::TransientBusy("The prepared Vulkan image queue is full");}
    bool acquire(Images& use)const{
        for(unsigned i=0;i<count;++i)if(images[i]&&!(use.held[i]=images[i].acquire()))return false;
        return true;
    }
};
struct Boundary {
    std::atomic<unsigned> references{1};RSVulkanSceneCallbacksV1 consumer;
    std::mutex mutex;std::shared_ptr<Prepared> prepared;Key failureKey;RSTemporalResult failure{};
    std::atomic<bool> warming{false};
    explicit Boundary(const RSVulkanSceneCallbacksV1& value):consumer(value){consumer.retain(consumer.storage);}
    ~Boundary(){consumer.release(consumer.storage);}
    void retain(){references.fetch_add(1,std::memory_order_relaxed);}
    void release(){if(references.fetch_sub(1,std::memory_order_acq_rel)==1)delete this;}
    void preparationFailed(const Key& key,uint32_t status,const char* reason){
        std::lock_guard guard(mutex);failureKey=key;failure={};failure.size=sizeof(failure);failure.version=1;failure.status=status;
        std::strncpy(failure.reason,reason,sizeof(failure.reason)-1);
    }
    // Called under mutex. An older descriptor's failure cannot reject a new key.
    bool failureFor(const Key& key,RSTemporalResult& result)const{
        if(!failure.version||!(failureKey==key))return false;
        result=failure;return true;
    }
    void warm(Key key,std::shared_ptr<Prepared> current){
        if(warming.exchange(true,std::memory_order_acq_rel))return;
        retain();
        dispatch_async(macfx::effectPreparationQueue(),^{@autoreleasepool{
            @try{try{
                auto next=current?:std::make_shared<Prepared>(key);next->warm();
                std::lock_guard guard(mutex);prepared=std::move(next);failure={};
            }catch(const macfx::TransientBusy& error){preparationFailed(key,error.structurallyImpossible?RS_TEMPORAL_UNAVAILABLE:RS_TEMPORAL_BUSY,error.what());}
             catch(const std::bad_alloc&){preparationFailed(key,RS_TEMPORAL_BUSY,"The Vulkan boundary preparation needs memory");}
             catch(const std::exception& error){preparationFailed(key,RS_TEMPORAL_FAILED,error.what());}
             catch(...){preparationFailed(key,RS_TEMPORAL_FAILED,"The Vulkan boundary preparation failed");}}
            @catch(NSException* error){preparationFailed(key,RS_TEMPORAL_FAILED,error.reason.UTF8String?:"Metal rejected the Vulkan boundary preparation");}
            warming.store(false,std::memory_order_release);release();
        }});
    }
};
int reject(RSTemporalResult* result,uint32_t status,const char* reason){
    result->status=status;result->encoded=0;
    std::strncpy(result->reason,reason,sizeof(result->reason)-1);
    return 0;
}
bool regionValid(id<MTLTexture> image,const Region& region){
    return image&&region.width&&region.height&&region.x<=image.width&&region.y<=image.height&&
        region.width<=image.width-region.x&&region.height<=image.height-region.y;
}
bool describe(const RSVulkanSceneEncodingV1& input,Key& key,
              std::array<id<MTLTexture>,count>& source,std::array<Region,count>& regions,bool& untracked){
    const auto& frame=input.frame;auto commands=(__bridge id<MTLCommandBuffer>)frame.commandBuffer;
    if(!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||frame.commandBufferKind||
       !frame.renderWidth||!frame.renderHeight||!frame.outputWidth||!frame.outputHeight)return false;
    const auto maxWidth=frame.maxRenderWidth?:frame.renderWidth,maxHeight=frame.maxRenderHeight?:frame.renderHeight;
    if(maxWidth<frame.renderWidth||maxHeight<frame.renderHeight)return false;
    key.device=commands.device;key.queue=commands.commandQueue;
    const auto mask=input.imageMask?input.imageMask:required;
    if(mask>>count)return false;
    for(unsigned i=0;i<fields.size();++i)if(mask&(1u<<i))source[i]=(__bridge id<MTLTexture>)(frame.*fields[i]);
    if(input.aovs)for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)if(mask&(1u<<(RS_VULKAN_SCENE_AOV_FIRST+i)))source[RS_VULKAN_SCENE_AOV_FIRST+i]=(__bridge id<MTLTexture>)input.aovs->images[i].texture;
    regions[RS_VULKAN_SCENE_COLOR]={frame.colorX,frame.colorY,frame.renderWidth,frame.renderHeight};
    regions[RS_VULKAN_SCENE_OUTPUT]={frame.outputX,frame.outputY,frame.outputWidth,frame.outputHeight};
    regions[RS_VULKAN_SCENE_DEPTH]={frame.depthX,frame.depthY,frame.renderWidth,frame.renderHeight};
    regions[RS_VULKAN_SCENE_MOTION]={frame.motionX,frame.motionY,frame.flags&RS_TEMPORAL_OUTPUT_MOTION?frame.outputWidth:frame.renderWidth,frame.flags&RS_TEMPORAL_OUTPUT_MOTION?frame.outputHeight:frame.renderHeight};
    regions[RS_VULKAN_SCENE_EXPOSURE]={0,0,1,1};
    regions[RS_VULKAN_SCENE_REACTIVE]=regions[RS_VULKAN_SCENE_TRANSPARENCY]=regions[RS_VULKAN_SCENE_COLOR];
    if(input.aovs)for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)if(source[RS_VULKAN_SCENE_AOV_FIRST+i]){const auto& image=input.aovs->images[i];regions[RS_VULKAN_SCENE_AOV_FIRST+i]={image.x,image.y,image.width,image.height};}
    if(!source[RS_VULKAN_SCENE_COLOR]||!source[RS_VULKAN_SCENE_OUTPUT])return false;
    for(unsigned i=0;i<count;++i)if(auto image=source[i]){
        if(image.device!=key.device||image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly||
           image.storageMode==MTLStorageModeMemoryless||!regionValid(image,regions[i]))return false;
        untracked|=image.hazardTrackingMode!=MTLHazardTrackingModeTracked;
        const auto usage=i==RS_VULKAN_SCENE_OUTPUT?(image.usage?:MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite):MTLTextureUsageShaderRead;
        const bool renderCapacity=i==RS_VULKAN_SCENE_COLOR||i==RS_VULKAN_SCENE_DEPTH||i==RS_VULKAN_SCENE_REACTIVE||i==RS_VULKAN_SCENE_TRANSPARENCY||(i==RS_VULKAN_SCENE_MOTION&&!(frame.flags&RS_TEMPORAL_OUTPUT_MOTION));
        key.mask|=1u<<i;key.images[i]={renderCapacity?maxWidth:regions[i].width,renderCapacity?maxHeight:regions[i].height,image.pixelFormat,usage};
    }
    return true;
}
void copyInputs(id<MTLCommandBuffer> commands,const RSVulkanSceneDependenciesV1& dependencies,
                const std::array<id<MTLTexture>,count>& source,const std::array<Region,count>& regions,const Images& images){
    auto encoder=[commands blitCommandEncoder];if(!encoder)throw macfx::TransientBusy("The Vulkan input boundary encoder is unavailable");
    @try{
        dependencies.before(dependencies.scope,(__bridge void*)encoder,RS_VULKAN_SCENE_BLIT_ENCODER);
        // ORIGINAL_OUTPUT_RETAINED is part of this operation: its exact output
        // is also an input to suffix processing and output-alpha preservation.
        for(unsigned i=0;i<count;++i)if(images.held[i]){
            const auto& region=regions[i];
            [encoder copyFromTexture:source[i] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(region.x,region.y,0) sourceSize:MTLSizeMake(region.width,region.height,1) toTexture:images.held[i].texture() destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
        }
    }@finally{
        dependencies.after(dependencies.scope,(__bridge void*)encoder,RS_VULKAN_SCENE_BLIT_ENCODER);[encoder endEncoding];
    }
}
int invoke(Boundary& boundary,const RSVulkanSceneEncodingV1* input,RSTemporalResult* result){
    const auto accepted=boundary.consumer.encode(boundary.consumer.storage,input,result);
    if(accepted&&result->status==RS_TEMPORAL_OK&&result->encoded)return 1;
    result->encoded=0;
    if(result->status==RS_TEMPORAL_OK)return reject(result,RS_TEMPORAL_UNAVAILABLE,"The prepared Vulkan consumer did not encode a complete output");
    return 0;
}
int encode(void* storage,const RSVulkanSceneEncodingV1* input,RSTemporalResult* result){
    if(!input||input->size!=sizeof(*input)||input->version!=1||!result||result->size!=sizeof(*result))return 0;
    auto& boundary=*static_cast<Boundary*>(storage);
    *result={};result->size=sizeof(*result);result->version=1;result->method=input->frame.method;
    Key key;std::array<id<MTLTexture>,count> source{};std::array<Region,count> regions{};bool untracked=false;
    if(!describe(*input,key,source,regions,untracked))return reject(result,RS_TEMPORAL_INVALID,"The Vulkan boundary needs valid declared image regions on the recording device");
    if(!untracked)return invoke(boundary,input,result);
    const auto dependencies=input->dependencies;
    if(!dependencies.before||!dependencies.after)return reject(result,RS_TEMPORAL_UNAVAILABLE,"Untracked Vulkan images require translator-owned boundary dependencies");
    std::shared_ptr<Prepared> prepared;RSTemporalResult failure{};
    {std::unique_lock guard(boundary.mutex,std::try_to_lock);if(!guard.owns_lock())return reject(result,RS_TEMPORAL_BUSY,"The Vulkan boundary preparation is publishing");prepared=boundary.prepared;boundary.failureFor(key,failure);}
    const auto preparationError=[&]{return failure.version&&failure.status!=RS_TEMPORAL_BUSY;};
    if(!prepared||!prepared->key.covers(key)){
        if(preparationError())return reject(result,failure.status,failure.reason);
        boundary.warm(key,{});return reject(result,RS_TEMPORAL_BUSY,failure.version?failure.reason:"The tracked Vulkan boundary images are preparing");
    }
    Images images;
    if(!prepared->acquire(images)){
        if(preparationError())return reject(result,failure.status,failure.reason);
        boundary.warm(key,prepared);return reject(result,RS_TEMPORAL_BUSY,failure.version?failure.reason:"The tracked Vulkan boundary images are in flight");
    }
    auto commands=(__bridge id<MTLCommandBuffer>)input->frame.commandBuffer;
    // Completion-block disposal is also the abandonment witness. It owns only
    // pooled images, never the command buffer or the external Vulkan textures.
    __block Images retained=images;
    [commands addCompletedHandler:^(id<MTLCommandBuffer>){for(auto& image:retained.held)image.reset();}];
    @try{try{
        copyInputs(commands,dependencies,source,regions,images);
        auto staged=*input;auto frame=input->frame;
        for(unsigned i=0;i<fields.size();++i)frame.*fields[i]=(__bridge void*)images.held[i].texture();
        frame.colorX=frame.colorY=frame.depthX=frame.depthY=frame.motionX=frame.motionY=frame.outputX=frame.outputY=0;
        staged.frame=frame;
        RSSceneAovs aovs{};
        if(input->aovs){aovs=*input->aovs;for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i){auto& image=aovs.images[i];image.texture=(__bridge void*)images.held[RS_VULKAN_SCENE_AOV_FIRST+i].texture();if(image.texture)image.x=image.y=0;}staged.aovs=&aovs;}
        if(!invoke(boundary,&staged,result))return 0;
        auto encoder=[commands blitCommandEncoder];if(!encoder)return reject(result,RS_TEMPORAL_BUSY,"The Vulkan output boundary encoder is unavailable");
        @try{
            dependencies.before(dependencies.scope,(__bridge void*)encoder,RS_VULKAN_SCENE_BLIT_ENCODER);
            const auto& region=regions[RS_VULKAN_SCENE_OUTPUT];
            [encoder copyFromTexture:images.held[RS_VULKAN_SCENE_OUTPUT].texture() sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(region.width,region.height,1) toTexture:source[RS_VULKAN_SCENE_OUTPUT] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(region.x,region.y,0)];
        }@finally{
            dependencies.after(dependencies.scope,(__bridge void*)encoder,RS_VULKAN_SCENE_BLIT_ENCODER);[encoder endEncoding];
        }
        return 1;
    }catch(const macfx::TransientBusy& error){return reject(result,error.structurallyImpossible?RS_TEMPORAL_UNAVAILABLE:RS_TEMPORAL_BUSY,error.what());}
     catch(const std::exception& error){return reject(result,RS_TEMPORAL_FAILED,error.what());}}
    @catch(NSException*){return reject(result,RS_TEMPORAL_FAILED,"Metal rejected the prepared Vulkan image boundary");}
}
}
extern "C" __attribute__((visibility("default"))) int rsCreateVulkanSceneBoundary1(const RSVulkanSceneCallbacksV1* consumer,RSVulkanSceneCallbacksV1* output){
    if(!consumer||!output||consumer->size!=sizeof(*consumer)||consumer->version!=1||!consumer->retain||!consumer->release||!consumer->encode)return 0;
    try{
        auto storage=new Boundary(*consumer);*output={};output->size=sizeof(*output);output->version=1;output->storage=storage;
        output->retain=[](void* value){static_cast<Boundary*>(value)->retain();};
        output->release=[](void* value){static_cast<Boundary*>(value)->release();};
        output->encode=encode;
        output->completed=[](void* value,uint64_t frame,uint32_t completion,const RSTemporalResult* result){auto& callback=static_cast<Boundary*>(value)->consumer;if(callback.completed)callback.completed(callback.storage,frame,completion,result);};
        return 1;
    }catch(...){return 0;}
}
