// Copyright (c) MacLauncher contributors. MIT license.
// Included by the original command-pool translation unit (manual ObjC retain).
#include "MVKImage.h"
#include "scene-command.hpp"
#include <array>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <optional>
namespace macfxMvkScene {
dispatch_queue_t retirementQueue(){static auto queue=dispatch_queue_create("org.maclauncher.vulkan.scene-retirement",DISPATCH_QUEUE_SERIAL);return queue;}
struct Operation {
    RSTemporalFrame frame{};
    std::optional<RSImageColorDescription>color;
    std::optional<RSSceneAovs>aovs;
    std::optional<RSSceneMatrices>matrices;
    std::array<id<MTLTexture>,RS_VULKAN_SCENE_IMAGE_COUNT>textures{};
    std::array<RSVulkanSceneImageV1,RS_VULKAN_SCENE_IMAGE_COUNT>images{};
    uint32_t imageMask=0;
    RSVulkanSceneCallbacksV1 callbacks{};
    double sourceTimeSeconds=0;
    bool retained=false,staging=false;
    ~Operation(){for(auto image:textures)[image release];if(retained)callbacks.release(callbacks.storage);}
};
struct Flight {
    std::shared_ptr<Operation>operation;
    RSTemporalResult result{};
    std::atomic<bool>completed{false};
    explicit Flight(std::shared_ptr<Operation>value):operation(std::move(value)){result.size=sizeof(result);result.version=1;result.status=RS_TEMPORAL_UNAVAILABLE;result.method=operation->frame.method;}
    void finish(uint32_t status){if(completed.exchange(true))return;if(operation->callbacks.completed)operation->callbacks.completed(operation->callbacks.storage,operation->frame.frameId,status,&result);}
    ~Flight(){finish(RS_VULKAN_SCENE_ABANDONED);}
};
struct Dependencies {MVKCommandEncoder*encoder;};
void before(void*value,void*metal,uint32_t kind){auto*scope=static_cast<Dependencies*>(value);scope->encoder->setBarrier((1ull<<kMVKBarrierStageCount)-1,1ull<<kMVKBarrierStageCompute);if(kind==RS_VULKAN_SCENE_COMPUTE_ENCODER)scope->encoder->barrierWait(kMVKBarrierStageCompute,(id<MTLComputeCommandEncoder>)metal);else if(kind==RS_VULKAN_SCENE_BLIT_ENCODER)scope->encoder->barrierWait(kMVKBarrierStageCompute,(id<MTLBlitCommandEncoder>)metal);}
void after(void*value,void*metal,uint32_t kind){auto*scope=static_cast<Dependencies*>(value);if(kind==RS_VULKAN_SCENE_COMPUTE_ENCODER)scope->encoder->barrierUpdate(kMVKBarrierStageCompute,(id<MTLComputeCommandEncoder>)metal);else if(kind==RS_VULKAN_SCENE_BLIT_ENCODER)scope->encoder->barrierUpdate(kMVKBarrierStageCompute,(id<MTLBlitCommandEncoder>)metal);scope->encoder->setBarrier(1ull<<kMVKBarrierStageCompute,(1ull<<kMVKBarrierStageCount)-1);}
constexpr std::array<void*RSTemporalFrame::*,RS_VULKAN_SCENE_AOV_FIRST>frameImages={&RSTemporalFrame::color,&RSTemporalFrame::depth,&RSTemporalFrame::motion,&RSTemporalFrame::output,&RSTemporalFrame::exposure,&RSTemporalFrame::reactive,&RSTemporalFrame::transparency};
bool nativePointersClear(const RSTemporalFrame&frame){if(frame.commandBuffer)return false;for(auto field:frameImages)if(frame.*field)return false;return true;}
VkResult resolve(MVKDevice*device,const RSVulkanSceneImageV1&binding,id<MTLTexture>&result,bool staging){
    if(!binding.image){if(binding.aspect||binding.mipLevel||binding.arrayLayer)return VK_ERROR_INITIALIZATION_FAILED;return VK_SUCCESS;}
    auto*image=(MVKImage*)binding.image;
    if(image->getDevice()!=device||image->getSampleCount()!=VK_SAMPLE_COUNT_1_BIT||!binding.aspect||(binding.aspect&(binding.aspect-1)))return VK_ERROR_FEATURE_NOT_PRESENT;
    const auto plane=MVKImage::getPlaneFromVkImageAspectFlags(binding.aspect);
    if(plane>=image->getPlaneCount())return VK_ERROR_FEATURE_NOT_PRESENT;
    auto texture=image->getMTLTexture(plane);if(!texture||texture.framebufferOnly||(!staging&&texture.hazardTrackingMode!=MTLHazardTrackingModeTracked)||binding.mipLevel>=texture.mipmapLevelCount||binding.arrayLayer>=texture.arrayLength)return VK_ERROR_FEATURE_NOT_PRESENT;
    if(texture.textureType!=MTLTextureType2D&&texture.textureType!=MTLTextureType2DArray)return VK_ERROR_FEATURE_NOT_PRESENT;
    if(binding.mipLevel||binding.arrayLayer||texture.textureType!=MTLTextureType2D){result=[texture newTextureViewWithPixelFormat:texture.pixelFormat textureType:MTLTextureType2D levels:NSMakeRange(binding.mipLevel,1) slices:NSMakeRange(binding.arrayLayer,1)];}
    else result=[texture retain];
    return result?VK_SUCCESS:VK_ERROR_FEATURE_NOT_PRESENT;
}
}
VkResult MVKCmdMacfxScene::setContent(MVKCommandBuffer*commands,const RSVulkanSceneOperationV1*input){
    discardMacfxSceneOperation();
    if(!input||input->size!=sizeof(*input)||input->version!=1||!(input->flags&RS_VULKAN_SCENE_ORIGINAL_OUTPUT_RETAINED)||(input->flags&~uint32_t(RS_VULKAN_SCENE_ORIGINAL_OUTPUT_RETAINED|RS_VULKAN_SCENE_PREPARED_TRACKED_BOUNDARY))||input->frame.size!=sizeof(input->frame)||input->frame.version!=1||!input->frame.owner||!input->frame.frameId||!macfxMvkScene::nativePointersClear(input->frame))return VK_ERROR_INITIALIZATION_FAILED;
    const bool staging=input->flags&RS_VULKAN_SCENE_PREPARED_TRACKED_BOUNDARY;
    const auto&callbacks=input->callbacks;
    if(callbacks.size!=sizeof(callbacks)||callbacks.version!=1||!callbacks.retain||!callbacks.release||!callbacks.encode)return VK_ERROR_INITIALIZATION_FAILED;
    if(input->color&&(input->color->size!=sizeof(*input->color)||input->color->version!=1))return VK_ERROR_FEATURE_NOT_PRESENT;
    if(input->aovs&&(input->aovs->size!=sizeof(*input->aovs)||input->aovs->version!=1||input->aovs->frameId!=input->frame.frameId))return VK_ERROR_FEATURE_NOT_PRESENT;
    if(input->matrices&&(input->matrices->size!=sizeof(*input->matrices)||input->matrices->version!=1||input->matrices->frameId!=input->frame.frameId))return VK_ERROR_FEATURE_NOT_PRESENT;
    if(!input->images[RS_VULKAN_SCENE_COLOR].image||!input->images[RS_VULKAN_SCENE_OUTPUT].image)return VK_ERROR_INITIALIZATION_FAILED;
    auto value=std::shared_ptr<macfxMvkScene::Operation>(new macfxMvkScene::Operation,[](macfxMvkScene::Operation*value){dispatch_async(macfxMvkScene::retirementQueue(),^{delete value;});});
    value->frame=input->frame;value->frame.commandBufferKind=0;value->sourceTimeSeconds=input->sourceTimeSeconds;value->callbacks=callbacks;value->imageMask=input->imageMask?input->imageMask:((1u<<RS_VULKAN_SCENE_COLOR)|(1u<<RS_VULKAN_SCENE_OUTPUT));if(value->imageMask>>RS_VULKAN_SCENE_IMAGE_COUNT)return VK_ERROR_FEATURE_NOT_PRESENT;value->imageMask|=(1u<<RS_VULKAN_SCENE_COLOR)|(1u<<RS_VULKAN_SCENE_OUTPUT);std::copy(std::begin(input->images),std::end(input->images),value->images.begin());
    if(input->color)value->color=*input->color;if(input->aovs)value->aovs=*input->aovs;if(input->matrices)value->matrices=*input->matrices;
    for(unsigned i=0;i<RS_VULKAN_SCENE_IMAGE_COUNT;++i){if(!(value->imageMask&(1u<<i)))continue;const auto status=macfxMvkScene::resolve(commands->getDevice(),input->images[i],value->textures[i],staging);if(status!=VK_SUCCESS)return status;}
    value->staging=std::any_of(value->textures.begin(),value->textures.end(),[](id<MTLTexture> image){return image&&image.hazardTrackingMode!=MTLHazardTrackingModeTracked;});
    if(value->staging){if(!commands->canRecordMacfxSceneStaging())return VK_ERROR_FEATURE_NOT_PRESENT;for(unsigned i=0;i<kMVKBarrierStageCount;++i)if(!commands->getDevice()->getFence((MVKBarrierStage)i,1))return VK_ERROR_FEATURE_NOT_PRESENT;}
    for(unsigned i=0;i<macfxMvkScene::frameImages.size();++i)value->frame.*macfxMvkScene::frameImages[i]=(void*)value->textures[i];
    if(value->aovs)for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i){if(value->aovs->images[i].texture)return VK_ERROR_INITIALIZATION_FAILED;value->aovs->images[i].texture=(void*)value->textures[RS_VULKAN_SCENE_AOV_FIRST+i];}
    callbacks.retain(callbacks.storage);value->retained=true;if(value->staging)commands->_macfxSceneStaging=true;_operation=std::move(value);_sceneDevice=commands->getDevice();_sceneDevice->_macfxSceneRecordingCount.fetch_add(1,std::memory_order_release);return VK_SUCCESS;
}
MVKCmdMacfxScene::~MVKCmdMacfxScene(){discardMacfxSceneOperation();}
void MVKCmdMacfxScene::discardMacfxSceneOperation(){if(_sceneDevice){_sceneDevice->_macfxSceneRecordingCount.fetch_sub(1,std::memory_order_release);_sceneDevice=nullptr;}_operation.reset();}
void MVKCmdMacfxScene::encode(MVKCommandEncoder*encoder){
    auto operation=_operation;auto commands=encoder->_mtlCmdBuffer;if(!operation||!commands)return;
    auto flight=std::make_shared<macfxMvkScene::Flight>(operation);
    if(encoder->isInRenderPass()){std::strncpy(flight->result.reason,"The optional scene operation requires a compute boundary outside a render pass",sizeof(flight->result.reason)-1);}
    else if(commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||commands.device!=operation->textures[RS_VULKAN_SCENE_COLOR].device||(operation->staging&&(!encoder->_cmdBuffer->_macfxSceneStaging||encoder->_cmdBuffer->_macfxSceneStagingEscaped))){std::strncpy(flight->result.reason,"The exact retaining native scene recording is unavailable",sizeof(flight->result.reason)-1);}
    else{
        // Preserve original encoder retirement. Opted-in untracked images use
        // the translator dependencies only at the common tracked boundary.
        encoder->endCurrentMetalEncoding();
        macfxMvkScene::Dependencies scope{encoder};RSVulkanSceneEncodingV1 frame{};frame.size=sizeof(frame);frame.version=1;frame.frame=operation->frame;frame.frame.commandBuffer=(void*)commands;frame.color=operation->color?&*operation->color:nullptr;frame.aovs=operation->aovs?&*operation->aovs:nullptr;frame.matrices=operation->matrices?&*operation->matrices:nullptr;frame.sourceTimeSeconds=operation->sourceTimeSeconds;frame.dependencies={&scope,macfxMvkScene::before,macfxMvkScene::after};frame.images=operation->images.data();frame.imageMask=operation->imageMask;
        @try{try{const auto accepted=operation->callbacks.encode(operation->callbacks.storage,&frame,&flight->result);if(!accepted||flight->result.status!=RS_TEMPORAL_OK){flight->result.encoded=0;if(flight->result.status==RS_TEMPORAL_OK)flight->result.status=RS_TEMPORAL_UNAVAILABLE;}}catch(...){flight->result.status=RS_TEMPORAL_FAILED;flight->result.encoded=0;std::strncpy(flight->result.reason,"The optional prepared scene callback failed",sizeof(flight->result.reason)-1);}}
        @catch(NSException*){flight->result.status=RS_TEMPORAL_FAILED;flight->result.encoded=0;std::strncpy(flight->result.reason,"Metal rejected the optional prepared scene callback",sizeof(flight->result.reason)-1);}
    }
    // Capture the owning flight value, never an encoder/command object or a
    // borrowed shared_ptr reference. Reusable recordings retain separate uses.
    [commands addCompletedHandler:^(id<MTLCommandBuffer>done){if(done.status!=MTLCommandBufferStatusCompleted){flight->result.status=RS_TEMPORAL_FAILED;flight->result.encoded=0;flight->finish(RS_VULKAN_SCENE_GPU_FAILED);}else flight->finish(RS_VULKAN_SCENE_GPU_COMPLETED);}];
}
MVKCommandTypePool<MVKCommand>*MVKCmdMacfxScene::getTypePool(MVKCommandPool*pool){
    // This existing lifecycle hook is called when recording/reset returns the
    // command to its pool. GPU flights keep their own immutable operation lease.
    discardMacfxSceneOperation();return (MVKCommandTypePool<MVKCommand>*)&pool->_cmdMacfxScenePool;
}
extern "C" __attribute__((visibility("default"))) uint32_t rsMoltenVKSceneOperationAPI(void){return 1;}
extern "C" __attribute__((visibility("default"))) uint32_t rsMoltenVKSceneStagingAPI(void){return 1;}
extern "C" __attribute__((visibility("default"))) VkResult rsMoltenVKRecordSceneOperation(VkCommandBuffer handle,const RSVulkanSceneOperationV1*input){
    if(!handle||!input)return VK_ERROR_INITIALIZATION_FAILED;
    @try{try{auto*commands=MVKCommandBuffer::getMVKCommandBuffer(handle);if(!commands->canRecordMacfxSceneOperation())return VK_NOT_READY;auto*pool=commands->getCommandPool();auto*command=pool->_cmdMacfxScenePool.acquireObject();struct Reservation{MVKCommandPool*pool;MVKCmdMacfxScene*command;bool kept=false;~Reservation(){if(!kept){command->discardMacfxSceneOperation();pool->_cmdMacfxScenePool.returnObject(command);}}}reservation{pool,command};const auto result=command->setContent(commands,input);if(result!=VK_SUCCESS)return result;reservation.kept=true;commands->addCommand(command);return VK_SUCCESS;}catch(const std::bad_alloc&){return VK_ERROR_OUT_OF_HOST_MEMORY;}catch(...){return VK_ERROR_INITIALIZATION_FAILED;}}
    @catch(NSException*){return VK_ERROR_INITIALIZATION_FAILED;}
}
