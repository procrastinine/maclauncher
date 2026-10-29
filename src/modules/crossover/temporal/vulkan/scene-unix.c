/* Copyright (c) MacLauncher contributors. MIT license. */
#if 0
#pragma makedep unix
#endif
#include "config.h"
#include <math.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "vulkan_private.h"
#include "scene-request.h"
#include "macfx-shared/reshade/native/recorded-scene.h"

_Static_assert(WINE_VULKAN_DRIVER_VERSION == 47, "Matched Wine Vulkan driver required");
_Static_assert(RS_VULKAN_SCENE_IMAGE_COUNT == RS_WINE_VULKAN_SCENE_IMAGE_COUNT, "Scene roles changed");
_Static_assert(sizeof(struct RSImageColorDescription) == sizeof(RSWineVulkanSceneColorV1), "Scene color changed");
_Static_assert(RS_WINE_SCENE_AOV_FIRST == RS_VULKAN_SCENE_AOV_FIRST, "Scene slot layout changed");

struct scene_provider {
    atomic_uint references;
    RSWineVulkanSceneProviderV1 value;
};
static pthread_mutex_t provider_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct scene_provider *current_provider;
struct scene_context {
    atomic_uint references;
    uint64_t observer,identity,generation;
    RSWineVulkanSceneDeviceV1 device;
    RSRecordedSceneConsumerV1 consumer;
    RSVulkanSceneCallbacksV1 callbacks;
    RSRecordedSceneImageDemand1 demand;
    BOOL staging;
    void *library;
    struct scene_context *next;
};
static struct scene_context *contexts;
struct retired_context {uint64_t observer,identity;struct retired_context *next;};
static struct retired_context *retired_contexts;
static BOOL context_retired(uint64_t observer,uint64_t identity)
{
    struct retired_context *value;
    for(value=retired_contexts;value;value=value->next)
        if(value->observer==observer&&(!value->identity||value->identity==identity))return TRUE;
    return FALSE;
}
static atomic_uint_fast64_t next_generation = 1;
#define NATIVE_CONSUMER_ID UINT64_C(0x4d434c53434e0001)
static void release_context(struct scene_context *value)
{
    if (value && atomic_fetch_sub_explicit(&value->references,1,memory_order_acq_rel)==1)
    {
        if (value->callbacks.release) value->callbacks.release(value->callbacks.storage);
        if (value->library) dlclose(value->library);
        free(value);
    }
}
static struct scene_context *find_context(uint64_t observer,uint64_t identity)
{
    struct scene_context *value;
    for (value=contexts;value;value=value->next)
        if (value->observer==observer && value->identity==identity) return value;
    return NULL;
}
static VkResult create_context(const RSWineVulkanSceneContextV1 *request,struct scene_context **output)
{
    typedef int (*CreateBoundary)(const RSVulkanSceneCallbacksV1*,RSVulkanSceneCallbacksV1*);
    RSRecordedSceneConsumerAPI api;
    RSCreateRecordedSceneConsumer1 create;
    CreateBoundary boundary;
    PFN_rsMoltenVKSceneStagingAPI staging;
    Dl_info info;
    struct scene_context *value;
    VkResult status;
    if (!(api=(RSRecordedSceneConsumerAPI)dlsym(RTLD_DEFAULT,"rsRecordedSceneConsumerAPI")) ||
        !dladdr((void*)api,&info) || !info.dli_fname) return VK_ERROR_FEATURE_NOT_PRESENT;
    if (!(value=calloc(1,sizeof(*value)))) return VK_ERROR_OUT_OF_HOST_MEMORY;
    atomic_init(&value->references,1);
    value->library=dlopen(info.dli_fname,RTLD_NOW|RTLD_LOCAL|RTLD_NODELETE);
    if (!value->library) { release_context(value);return VK_ERROR_FEATURE_NOT_PRESENT; }
    api=(RSRecordedSceneConsumerAPI)dlsym(value->library,"rsRecordedSceneConsumerAPI");
    create=(RSCreateRecordedSceneConsumer1)dlsym(value->library,"rsCreateRecordedSceneConsumer1");
    boundary=(CreateBoundary)dlsym(value->library,"rsCreateVulkanSceneBoundary1");
    value->demand=(RSRecordedSceneImageDemand1)dlsym(value->library,"rsRecordedSceneImageDemand1");
    if (!api || api()!=1 || !create || !boundary || !value->demand)
    { release_context(value);return VK_ERROR_FEATURE_NOT_PRESENT; }
    value->device.size=sizeof(value->device);value->device.version=1;
    status=rsWineVulkanResolveSceneDevice1(request->device,&value->device);
    if (status!=VK_SUCCESS) { release_context(value);return status; }
    value->generation=atomic_fetch_add_explicit(&next_generation,1,memory_order_relaxed);
    if (!value->generation) { release_context(value);return VK_ERROR_TOO_MANY_OBJECTS; }
    value->consumer.size=sizeof(value->consumer);value->consumer.version=1;
    if (!create(value->generation,&value->consumer))
    { release_context(value);return VK_NOT_READY; }
    if (value->consumer.size!=sizeof(value->consumer)||value->consumer.version!=1||!value->consumer.owner || value->consumer.callbacks.size!=sizeof(value->consumer.callbacks) ||
        value->consumer.callbacks.version!=1 || !value->consumer.callbacks.retain ||
        !value->consumer.callbacks.release || !value->consumer.callbacks.encode)
    { if(value->consumer.callbacks.release)value->consumer.callbacks.release(value->consumer.callbacks.storage);release_context(value);return VK_ERROR_INITIALIZATION_FAILED; }
    if (!boundary(&value->consumer.callbacks,&value->callbacks))
    { value->consumer.callbacks.release(value->consumer.callbacks.storage);release_context(value);return VK_NOT_READY; }
    value->consumer.callbacks.release(value->consumer.callbacks.storage);
    staging=(PFN_rsMoltenVKSceneStagingAPI)vk_funcs->p_vkGetDeviceProcAddr(value->device.device,"rsMoltenVKSceneStagingAPI");
    value->staging=staging && staging()==1;
    value->observer=request->observerId;value->identity=request->contextId;*output=value;
    return VK_SUCCESS;
}
static VkResult context_control(RSWineVulkanSceneContextV1 *request,BOOL wow64)
{
    struct scene_context *old,*next=NULL,**cursor,*retired=NULL;
    struct retired_context *mark=NULL,**marks,*removed;
    VkResult status;
    if (!request || request->size!=sizeof(*request) || request->version!=1 ||
        request->profile!=RS_WINE_VULKAN_SCENE_PROFILE || !request->observerId ||
        request->reserved[0] || request->reserved[1] || request->operation<1 || request->operation>4)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (request->operation==RS_WINE_SCENE_CONTEXT_UNREGISTER)
    {
        if(request->contextId||request->device||request->generation||request->consumerId)return VK_ERROR_INITIALIZATION_FAILED;
        if(!(mark=calloc(1,sizeof(*mark))))return VK_ERROR_OUT_OF_HOST_MEMORY;
        mark->observer=request->observerId;
        pthread_mutex_lock(&provider_mutex);
        for(marks=&retired_contexts;*marks;)if((*marks)->observer==request->observerId){removed=*marks;*marks=removed->next;free(removed);}else marks=&(*marks)->next;
        mark->next=retired_contexts;retired_contexts=mark;
        for(cursor=&contexts;*cursor;)if((*cursor)->observer==request->observerId){old=*cursor;*cursor=old->next;old->next=retired;retired=old;}else cursor=&(*cursor)->next;
        pthread_mutex_unlock(&provider_mutex);
        while(retired){old=retired;retired=old->next;release_context(old);}return VK_SUCCESS;
    }
    if(!request->contextId||!request->device||(wow64&&request->device>>32))return VK_ERROR_INITIALIZATION_FAILED;
    if(request->operation==RS_WINE_SCENE_CONTEXT_DESTROY){if(!(mark=calloc(1,sizeof(*mark))))return VK_ERROR_OUT_OF_HOST_MEMORY;mark->observer=request->observerId;mark->identity=request->contextId;}
    pthread_mutex_lock(&provider_mutex);old=find_context(request->observerId,request->contextId);
    if(context_retired(request->observerId,request->contextId)){pthread_mutex_unlock(&provider_mutex);free(mark);return request->operation==RS_WINE_SCENE_CONTEXT_DESTROY?VK_SUCCESS:VK_ERROR_FEATURE_NOT_PRESENT;}
    if(request->operation==RS_WINE_SCENE_CONTEXT_BEGIN){
        if(request->generation||request->consumerId){pthread_mutex_unlock(&provider_mutex);return VK_ERROR_INITIALIZATION_FAILED;}
        if(old){if(old->device.wineDevice!=request->device){pthread_mutex_unlock(&provider_mutex);return VK_ERROR_INITIALIZATION_FAILED;}request->generation=old->generation;request->consumerId=NATIVE_CONSUMER_ID;pthread_mutex_unlock(&provider_mutex);return VK_SUCCESS;}
    }else if(!old||old->generation!=request->generation||old->device.wineDevice!=request->device||request->consumerId!=NATIVE_CONSUMER_ID){pthread_mutex_unlock(&provider_mutex);free(mark);return VK_ERROR_INITIALIZATION_FAILED;}
    if(old)atomic_fetch_add_explicit(&old->references,1,memory_order_relaxed);
    pthread_mutex_unlock(&provider_mutex);
    if(request->operation!=RS_WINE_SCENE_CONTEXT_DESTROY){status=create_context(request,&next);if(status!=VK_SUCCESS){release_context(old);return status;}}
    pthread_mutex_lock(&provider_mutex);
    if(context_retired(request->observerId,request->contextId)||find_context(request->observerId,request->contextId)!=old){pthread_mutex_unlock(&provider_mutex);release_context(old);release_context(next);free(mark);return VK_NOT_READY;}
    if(old){for(cursor=&contexts;*cursor&&*cursor!=old;cursor=&(*cursor)->next){}if(*cursor)*cursor=old->next;}
    if(next){next->next=contexts;contexts=next;request->generation=next->generation;request->consumerId=NATIVE_CONSUMER_ID;}
    if(mark){mark->next=retired_contexts;retired_contexts=mark;}
    pthread_mutex_unlock(&provider_mutex);
    if(old){release_context(old);release_context(old);}return VK_SUCCESS;
}

static void release_provider(struct scene_provider *provider)
{
    if (provider && atomic_fetch_sub_explicit(&provider->references, 1, memory_order_acq_rel) == 1)
    {
        provider->value.release(provider->value.storage);
        free(provider);
    }
}

__attribute__((visibility("default"))) uint32_t rsWineVulkanSceneNativeAPI(void)
{
    return RS_WINE_VULKAN_SCENE_VERSION;
}

__attribute__((visibility("default"))) int32_t rsWineVulkanResolveSceneDevice1(uint64_t handle, RSWineVulkanSceneDeviceV1 *binding)
{
    struct vulkan_device *device;
    RSWineVulkanSceneDeviceV1 result = {0};
    if (!binding || binding->size != sizeof(*binding) || binding->version != 1 || !handle)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (!vk_funcs) return VK_ERROR_FEATURE_NOT_PRESENT;
    device = vulkan_device_from_handle((VkDevice)(UINT_PTR)handle);
    if (!device || !device->host.device) return VK_ERROR_INITIALIZATION_FAILED;
    result.size = sizeof(result); result.version = 1;
    result.wineDevice = handle; result.device = device->host.device;
    result.api = (PFN_rsMoltenVKSceneOperationAPI)vk_funcs->p_vkGetDeviceProcAddr(result.device, "rsMoltenVKSceneOperationAPI");
    result.record = (PFN_rsMoltenVKRecordSceneOperation)vk_funcs->p_vkGetDeviceProcAddr(result.device, "rsMoltenVKRecordSceneOperation");
    if (!result.api || !result.record || result.api() != 1) return VK_ERROR_FEATURE_NOT_PRESENT;
    *binding = result;
    return VK_SUCCESS;
}

__attribute__((visibility("default"))) int32_t rsWineVulkanSetSceneProvider1(const RSWineVulkanSceneProviderV1 *value)
{
    struct scene_provider *next = NULL, *previous;
    if (value)
    {
        if (value->size != sizeof(*value) || value->version != 1 ||
            value->profile != RS_WINE_VULKAN_SCENE_PROFILE || value->reserved ||
            !value->consumerId || !value->retain || !value->release || !value->acquire)
            return VK_ERROR_INITIALIZATION_FAILED;
        if (!(next = malloc(sizeof(*next)))) return VK_ERROR_OUT_OF_HOST_MEMORY;
        atomic_init(&next->references, 1);
        next->value = *value;
        next->value.retain(next->value.storage);
    }
    pthread_mutex_lock(&provider_mutex);
    previous = current_provider;
    current_provider = next;
    pthread_mutex_unlock(&provider_mutex);
    release_provider(previous);
    return VK_SUCCESS;
}

static void copy_frame(RSTemporalFrame *frame, const RSWineVulkanSceneRequestV1 *request, void *owner)
{
    const RSWineVulkanSceneFrameV1 *s = &request->frame;
    memset(frame, 0, sizeof(*frame));
    frame->size = sizeof(*frame); frame->version = 1;
    frame->owner = owner; frame->frameId = request->frameId;
    frame->method = s->method; frame->flags = s->flags;
    frame->renderWidth = s->renderWidth; frame->renderHeight = s->renderHeight;
    frame->outputWidth = s->outputWidth; frame->outputHeight = s->outputHeight;
    frame->maxRenderWidth = s->maxRenderWidth; frame->maxRenderHeight = s->maxRenderHeight;
    frame->colorX = s->colorX; frame->colorY = s->colorY;
    frame->depthX = s->depthX; frame->depthY = s->depthY;
    frame->motionX = s->motionX; frame->motionY = s->motionY;
    frame->outputX = s->outputX; frame->outputY = s->outputY;
    frame->jitterX = s->jitterX; frame->jitterY = s->jitterY;
    frame->motionScaleX = s->motionScaleX; frame->motionScaleY = s->motionScaleY;
    frame->preExposure = s->preExposure; frame->sharpness = s->sharpness;
    frame->frameTimeMs = s->frameTimeMs; frame->nearPlane = s->nearPlane;
    frame->farPlane = s->farPlane; frame->verticalFov = s->verticalFov;
    frame->reserved = s->profile;
}

static VkResult record_scene(const RSWineVulkanSceneRequestV1 *request, BOOL wow64)
{
    struct vulkan_device *device;
    struct vulkan_command_buffer *commands;
    struct scene_provider *provider;
    struct scene_context *owned = NULL;
    uint32_t owned_demand = 0;
    RSWineVulkanSceneConsumerV1 consumer = {0};
    RSVulkanSceneOperationV1 operation = {0};
    struct RSImageColorDescription color;
    VkResult result;
    unsigned int i;

    if (!request || request->size != sizeof(*request) || request->version != 1 ||
        request->profile != RS_WINE_VULKAN_SCENE_PROFILE ||
        request->flags != RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED ||
        request->reserved[0] || request->reserved[1] || request->frame.reserved ||
        request->colorKnown > 1 || !request->device || !request->commandBuffer ||
        !request->ownerId || !request->frameId || !request->consumerId ||
        !isfinite(request->sourceTimeSeconds) || request->sourceTimeSeconds < 0 ||
        request->imageMask & ~((1u << RS_WINE_VULKAN_SCENE_IMAGE_COUNT) - 1) ||
        !request->images[RS_VULKAN_SCENE_COLOR].image || !request->images[RS_VULKAN_SCENE_OUTPUT].image)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (wow64 && ((request->device >> 32) || (request->commandBuffer >> 32)))
        return VK_ERROR_INITIALIZATION_FAILED;
    if (!vk_funcs) return VK_ERROR_FEATURE_NOT_PRESENT;

    /* These are the matched Wine owner's helpers, not native-pointer casts. */
    device = vulkan_device_from_handle((VkDevice)(UINT_PTR)request->device);
    commands = vulkan_command_buffer_from_handle((VkCommandBuffer)(UINT_PTR)request->commandBuffer);
    if (!device || !commands || commands->device != device || !device->host.device || !commands->host.command_buffer)
        return VK_ERROR_INITIALIZATION_FAILED;
    pthread_mutex_lock(&provider_mutex);
    provider = current_provider;
    if (provider && provider->value.consumerId != request->consumerId) provider = NULL;
    if (provider) atomic_fetch_add_explicit(&provider->references, 1, memory_order_relaxed);
    else if(request->consumerId==NATIVE_CONSUMER_ID)
        for(owned=contexts;owned;owned=owned->next)if(owned->generation==request->ownerId){atomic_fetch_add_explicit(&owned->references,1,memory_order_relaxed);break;}
    pthread_mutex_unlock(&provider_mutex);
    if (!provider && !owned) return VK_ERROR_FEATURE_NOT_PRESENT;
    if(owned && !(owned_demand=owned->demand())){release_context(owned);return VK_ERROR_FEATURE_NOT_PRESENT;}
    consumer.size = sizeof(consumer); consumer.version = 1;
    if(owned){consumer.ownerId=owned->generation;consumer.owner=owned->consumer.owner;consumer.device=&owned->device;consumer.callbacks=owned->callbacks;result=VK_SUCCESS;}
    else result = provider->value.acquire(provider->value.storage, request, &consumer);
    if (result != VK_SUCCESS) { release_provider(provider);release_context(owned);return result; }
    if (consumer.size != sizeof(consumer) || consumer.version != 1 ||
        consumer.ownerId != request->ownerId || !consumer.owner ||
        !consumer.device || consumer.device->size != sizeof(*consumer.device) || consumer.device->version != 1 ||
        consumer.device->wineDevice != request->device || consumer.device->device != device->host.device ||
        !consumer.device->api || !consumer.device->record ||
        consumer.callbacks.size != sizeof(consumer.callbacks) || consumer.callbacks.version != 1 ||
        !consumer.callbacks.retain || !consumer.callbacks.release || !consumer.callbacks.encode)
    { release_provider(provider);release_context(owned);return VK_ERROR_INITIALIZATION_FAILED; }

    consumer.callbacks.retain(consumer.callbacks.storage);
    operation.size = sizeof(operation); operation.version = 1;
    operation.flags = RS_VULKAN_SCENE_ORIGINAL_OUTPUT_RETAINED;
    if(owned&&owned->staging)operation.flags|=RS_VULKAN_SCENE_PREPARED_TRACKED_BOUNDARY;
    operation.imageMask = owned ? request->imageMask & owned_demand : request->imageMask;
    if(owned)operation.imageMask |= (1u<<RS_VULKAN_SCENE_COLOR)|(1u<<RS_VULKAN_SCENE_OUTPUT);
    copy_frame(&operation.frame, request, consumer.owner);
    for (i = 0; i < RS_WINE_VULKAN_SCENE_IMAGE_COUNT; ++i)
    {
        operation.images[i].image = (VkImage)request->images[i].image;
        operation.images[i].aspect = request->images[i].aspect;
        operation.images[i].mipLevel = request->images[i].mipLevel;
        operation.images[i].arrayLayer = request->images[i].arrayLayer;
    }
    if (request->colorKnown) { memcpy(&color, &request->color, sizeof(color)); operation.color = &color; }
    operation.aovs = consumer.aovs; operation.matrices = consumer.matrices;
    operation.sourceTimeSeconds = request->sourceTimeSeconds;
    operation.callbacks = consumer.callbacks;
    result = consumer.device->record(commands->host.command_buffer, &operation);
    consumer.callbacks.release(consumer.callbacks.storage);
    release_provider(provider);
    release_context(owned);
    return result;
}

NTSTATUS maclauncher_scene_record64(void *args)
{
    struct maclauncher_scene_record_params *params = args;
    params->result = params->reserved==1 ? context_control((RSWineVulkanSceneContextV1 *)(UINT_PTR)params->request,FALSE) :
        params->reserved ? VK_ERROR_INITIALIZATION_FAILED : record_scene((const RSWineVulkanSceneRequestV1 *)(UINT_PTR)params->request, FALSE);
    return STATUS_SUCCESS;
}

NTSTATUS maclauncher_scene_record32(void *args)
{
    struct maclauncher_scene_record_params *params = args;
    params->result = params->request >> 32 ? VK_ERROR_INITIALIZATION_FAILED : params->reserved==1 ?
        context_control((RSWineVulkanSceneContextV1 *)UlongToPtr((UINT32)params->request),TRUE) :
        params->reserved ? VK_ERROR_INITIALIZATION_FAILED : record_scene((const RSWineVulkanSceneRequestV1 *)UlongToPtr((UINT32)params->request), TRUE);
    return STATUS_SUCCESS;
}
