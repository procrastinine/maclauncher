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
#include "scene-metadata.h"
#include "macfx-shared/reshade/native/recorded-scene.h"
#include "scene-metadata-native.h"
#include "scene-admission.h"

_Static_assert(WINE_VULKAN_DRIVER_VERSION == 47, "Matched Wine Vulkan driver required");
_Static_assert(RS_VULKAN_SCENE_IMAGE_COUNT == RS_WINE_VULKAN_SCENE_IMAGE_COUNT, "Scene roles changed");
_Static_assert(sizeof(struct RSImageColorDescription) == sizeof(RSWineVulkanSceneColorV1), "Scene color changed");
_Static_assert((unsigned)RS_WINE_SCENE_AOV_FIRST == (unsigned)RS_VULKAN_SCENE_AOV_FIRST, "Scene slot layout changed");

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
    RSVulkanSceneCallbacksV3 callbacks3;
    int (*setDestination)(void*,void*);
    uint64_t destinationWindow;
    pthread_mutex_t destinationMutex;
    pthread_mutex_t admissionMutex;
    struct scene_admission admission;
    RSPrepareRecordedSceneOperation3 prepare;
    PFN_rsVulkanPrepareSceneOperation3 prepareDevice;
    RSQueryRecordedSceneFeature3 query;
    PFN_rsVulkanQuerySceneFeature3 queryDevice;
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
static atomic_uint_fast64_t next_admission = UINT64_C(0x4d434c4100000001);
static VkResult prepare_scene_destination(struct scene_context *,uint64_t);
static void release_context(struct scene_context *value)
{
    if (value && atomic_fetch_sub_explicit(&value->references,1,memory_order_acq_rel)==1)
    {
        if(value->destinationWindow)prepare_scene_destination(value,0);
        scene_admission_clear(&value->admission);
        pthread_mutex_destroy(&value->admissionMutex);
        pthread_mutex_destroy(&value->destinationMutex);
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
    RSCreateRecordedSceneConsumer2 create2;
    typedef int (*Create3)(uint64_t,uint32_t,RSRecordedSceneConsumerV3*);
    typedef int (*Boundary3)(const RSVulkanSceneCallbacksV3*,RSVulkanSceneCallbacksV3*);
    Create3 create3;Boundary3 boundary3;
    uint32_t version;
    CreateBoundary boundary;
    PFN_rsVulkanSceneStagingAPI staging;
    Dl_info info;
    struct scene_context *value;
    VkResult status;
    if (!(api=(RSRecordedSceneConsumerAPI)dlsym(RTLD_DEFAULT,"rsRecordedSceneConsumerAPI")) ||
        !dladdr((void*)api,&info) || !info.dli_fname) return VK_ERROR_FEATURE_NOT_PRESENT;
    if (!(value=calloc(1,sizeof(*value)))) return VK_ERROR_OUT_OF_HOST_MEMORY;
    atomic_init(&value->references,1);
    if(pthread_mutex_init(&value->destinationMutex,NULL)){free(value);return VK_ERROR_OUT_OF_HOST_MEMORY;}
    if(pthread_mutex_init(&value->admissionMutex,NULL)){pthread_mutex_destroy(&value->destinationMutex);free(value);return VK_ERROR_OUT_OF_HOST_MEMORY;}
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
    version=value->device.api();
    if(version==3){
        create3=(Create3)dlsym(value->library,"rsCreateRecordedSceneConsumer3");
        boundary3=(Boundary3)dlsym(value->library,"rsCreateVulkanSceneBoundary3");
        if(create3&&boundary3){
            RSRecordedSceneConsumerV3 consumer3={0};
            RSVulkanSceneCallbacksV1 *callbacks=&consumer3.callbacks.base;
            consumer3.size=sizeof(consumer3);consumer3.version=3;
            if(!create3(value->generation,1,&consumer3)){release_context(value);return VK_NOT_READY;}
            if(consumer3.size!=sizeof(consumer3)||consumer3.version!=3||!consumer3.owner||
               callbacks->size!=sizeof(RSVulkanSceneCallbacksV3)||callbacks->version!=3||
               !callbacks->storage||!callbacks->retain||!callbacks->release||!callbacks->encode||!callbacks->completed||!consumer3.callbacks.submitted){
                if(callbacks->release)callbacks->release(callbacks->storage);
                release_context(value);return VK_ERROR_INITIALIZATION_FAILED;
            }
            if(!boundary3(&consumer3.callbacks,&value->callbacks3)){
                callbacks->release(callbacks->storage);release_context(value);return VK_NOT_READY;
            }
            callbacks->release(callbacks->storage);
            value->consumer.size=sizeof(value->consumer);value->consumer.version=3;
            value->consumer.owner=consumer3.owner;value->callbacks=value->callbacks3.base;
            value->setDestination=(int(*)(void*,void*))dlsym(value->library,"rsSetRecordedSceneDestination3");
            value->prepare=(RSPrepareRecordedSceneOperation3)dlsym(value->library,"rsPrepareRecordedSceneOperation3");
            value->prepareDevice=(PFN_rsVulkanPrepareSceneOperation3)vk_funcs->p_vkGetDeviceProcAddr(value->device.device,"rsVulkanPrepareSceneOperation3");
            value->query=(RSQueryRecordedSceneFeature3)dlsym(value->library,"rsQueryRecordedSceneFeature3");
            value->queryDevice=(PFN_rsVulkanQuerySceneFeature3)vk_funcs->p_vkGetDeviceProcAddr(value->device.device,"rsVulkanQuerySceneFeature3");
            if(value->callbacks.size!=sizeof(value->callbacks3)||value->callbacks.version!=3||
               !value->callbacks.storage||!value->callbacks.retain||!value->callbacks.release||!value->callbacks.encode||
               !value->callbacks.completed||!value->callbacks3.submitted){release_context(value);return VK_ERROR_INITIALIZATION_FAILED;}
            value->observer=request->observerId;value->identity=request->contextId;*output=value;
            return VK_SUCCESS;
        }
        // API3 explicitly retains API2 original-output operations. An absent
        // paired factory does not authorize a submission-dependent output.
        version=2;
    }
    if(version==2){
        create2=(RSCreateRecordedSceneConsumer2)dlsym(value->library,"rsCreateRecordedSceneConsumer2");
        boundary=(CreateBoundary)dlsym(value->library,"rsCreateVulkanSceneBoundary2");
        if(!create2||!boundary){release_context(value);return VK_ERROR_FEATURE_NOT_PRESENT;}
    }
    value->consumer.size=sizeof(value->consumer);value->consumer.version=version;
    if (!(version==2?create2(value->generation,1,&value->consumer):create(value->generation,&value->consumer)))
    { release_context(value);return VK_NOT_READY; }
    if (value->consumer.size!=sizeof(value->consumer)||value->consumer.version!=version||!value->consumer.owner || value->consumer.callbacks.size!=sizeof(value->consumer.callbacks) ||
        value->consumer.callbacks.version!=version || !value->consumer.callbacks.retain ||
        !value->consumer.callbacks.release || !value->consumer.callbacks.encode)
    { if(value->consumer.callbacks.release)value->consumer.callbacks.release(value->consumer.callbacks.storage);release_context(value);return VK_ERROR_INITIALIZATION_FAILED; }
    if (!boundary(&value->consumer.callbacks,&value->callbacks))
    { value->consumer.callbacks.release(value->consumer.callbacks.storage);release_context(value);return VK_NOT_READY; }
    value->consumer.callbacks.release(value->consumer.callbacks.storage);
    if(value->callbacks.size!=sizeof(value->callbacks)||value->callbacks.version!=version||!value->callbacks.retain||!value->callbacks.release||!value->callbacks.encode||(version==2&&!value->callbacks.completed))
    {release_context(value);return VK_ERROR_INITIALIZATION_FAILED;}
    staging=(PFN_rsVulkanSceneStagingAPI)vk_funcs->p_vkGetDeviceProcAddr(value->device.device,"rsVulkanSceneStagingAPI");
    if (!staging || staging()!=1)
        staging=(PFN_rsVulkanSceneStagingAPI)vk_funcs->p_vkGetDeviceProcAddr(value->device.device,"rsMoltenVKSceneStagingAPI");
    value->staging=version==1 && staging && staging()==1;
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
    result.api = (PFN_rsVulkanSceneOperationAPI)vk_funcs->p_vkGetDeviceProcAddr(result.device, "rsVulkanSceneOperationAPI");
    result.record = (PFN_rsVulkanRecordSceneOperation)vk_funcs->p_vkGetDeviceProcAddr(result.device, "rsVulkanRecordSceneOperation");
    if (!result.api || !result.record || (result.api() != 1 && result.api() != 2 && result.api() != 3))
    {
        result.api = (PFN_rsVulkanSceneOperationAPI)vk_funcs->p_vkGetDeviceProcAddr(result.device, "rsMoltenVKSceneOperationAPI");
        result.record = (PFN_rsVulkanRecordSceneOperation)vk_funcs->p_vkGetDeviceProcAddr(result.device, "rsMoltenVKRecordSceneOperation");
        if (!result.api || !result.record || result.api()!=1) return VK_ERROR_FEATURE_NOT_PRESENT;
    }
    if (!result.api || !result.record || (result.api() != 1 && result.api() != 2 && result.api() != 3)) return VK_ERROR_FEATURE_NOT_PRESENT;
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

// All pointers here remain native. The matched macdrv helper owns synchronous
// UI dispatch and holds the actual window during this metadata-only callback.
struct scene_destination_call { struct scene_context *owner; int result; BOOL clearOnly; };
static void bind_scene_window(void *storage,void *window)
{
    struct scene_destination_call *call=storage;
    call->result=call->owner->setDestination(call->owner->consumer.owner,NULL);
    if(call->result==RS_TEMPORAL_OK&&!call->clearOnly)
        call->result=call->owner->setDestination(call->owner->consumer.owner,window);
}
static VkResult prepare_scene_destination(struct scene_context *owner,uint64_t hwnd)
{
    typedef int (*WithWindow)(uint64_t,void(*)(void*,void*),void*);
    struct scene_destination_call call={owner,RS_TEMPORAL_UNAVAILABLE,!hwnd};
    WithWindow with_window;
    const char *module_path;
    void *library=NULL;
    int invoked;
    VkResult result=VK_ERROR_FEATURE_NOT_PRESENT;
    if(!owner || !owner->callbacks3.submitted || !owner->setDestination)
        return result;
    // This local try-lock is never acquired by the Cocoa callback; no driver
    // map/common/provider lock is held while the existing UI dispatch runs.
    if(pthread_mutex_trylock(&owner->destinationMutex))return VK_NOT_READY;
    // Clearing also belongs on the existing Wine Cocoa/UI thread. The exact
    // old HWND can deliver that callback; a closed window is never replaced
    // by a global lookup. Owner destruction independently retires its leases.
    if(!hwnd&&!owner->destinationWindow){result=VK_SUCCESS;goto done;}
    if(hwnd&&owner->destinationWindow&&owner->destinationWindow!=hwnd)goto done;
    module_path=getenv("MACLAUNCHER_NGX_WINEMAC_LIBRARY");
    if(!module_path || module_path[0]!='/')goto done;
    // Open only the exact selected module already loaded by this Wine launch.
    // Never load a foreign profile or search global symbols for a substitute.
    library=dlopen(module_path,RTLD_NOW|RTLD_LOCAL|RTLD_NOLOAD);
    if(!library)goto done;
    with_window=(WithWindow)dlsym(library,"MacLauncherWineMacWithWindow1");
    invoked=with_window?with_window(hwnd?hwnd:owner->destinationWindow,bind_scene_window,&call):0;
    if(!invoked)goto done;
    if(call.result==RS_TEMPORAL_BUSY){result=VK_NOT_READY;goto done;}
    if(call.result!=RS_TEMPORAL_OK)goto done;
    if(hwnd)owner->destinationWindow=hwnd;
    // Clear-only cleanup is not an admission of an unspecified destination.
    result=hwnd?VK_SUCCESS:VK_ERROR_FEATURE_NOT_PRESENT;
 done:
    if(library)dlclose(library);
    pthread_mutex_unlock(&owner->destinationMutex);return result;
}

static void scene_operation(const RSWineVulkanSceneRequestV1 *request,
    const RSWineSceneMetadataV2 *metadata, void *owner,
    const RSVulkanSceneCallbacksV3 *callbacks, RSVulkanSceneOperationV3 *operation,
    struct RSImageColorDescription *color, RSSceneAovs *aovs, RSSceneMatrices *matrices)
{
    unsigned i;
    memset(operation,0,sizeof(*operation));
    operation->base.size=sizeof(*operation);operation->base.version=3;
    operation->base.flags=request->flags;operation->base.imageMask=request->imageMask;
    copy_frame(&operation->base.frame,request,owner);
    operation->base.frame.commandBufferKind=1;
    for(i=0;i<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++i){
        operation->base.images[i].image=(VkImage)request->images[i].image;
        operation->base.images[i].aspect=request->images[i].aspect;
        operation->base.images[i].mipLevel=request->images[i].mipLevel;
        operation->base.images[i].arrayLayer=request->images[i].arrayLayer;
    }
    if(request->colorKnown){memcpy(color,&request->color,sizeof(*color));operation->base.color=color;}
    operation->base.aovs=metadata->aovMask?aovs:NULL;
    operation->base.matrices=metadata->matrixFlags?matrices:NULL;
    operation->base.sourceTimeSeconds=request->sourceTimeSeconds;
    operation->base.callbacks=callbacks->base;operation->submitted=callbacks->submitted;
}

/* PREPARE and CANCEL are separately probed selectors over the same fixed-width
 * request. Only PREPARE uses reserved[0] as the feature control word. Ordinary
 * recording still requires both control words zero. */
static VkResult prepare_scene(RSWineVulkanSceneRequestV2 *packet,BOOL wow64,BOOL cancel)
{
    struct scene_context *owner;
    struct vulkan_device *device;
    RSWineVulkanSceneRequestV2 request;
    RSRecordedSceneConsumerV3 admitted={0};
    RSVulkanSceneOperationV3 operation;
    struct RSImageColorDescription color;
    RSSceneAovs aovs;RSSceneMatrices matrices;
    RSTemporalResult result={.size=sizeof(result),.version=1};
    VkResult status=VK_ERROR_INITIALIZATION_FAILED;
    uint32_t feature;
    uint64_t identity;
    int ready;
    if(!packet)return status;
    request=*packet;feature=request.base.reserved[0];
    if(request.base.size!=sizeof(request.base)||request.base.version!=1||
       request.base.profile!=RS_WINE_VULKAN_SCENE_PROFILE||request.base.reserved[1]||
       request.base.frame.reserved||!request.base.device||!request.base.ownerId||!request.base.frameId||
       !request.base.commandBuffer||!request.base.consumerId||request.base.colorKnown>1||
       (request.base.imageMask&~((1u<<RS_WINE_VULKAN_SCENE_IMAGE_COUNT)-1))||
       !request.base.images[RS_WINE_SCENE_COLOR].image||!request.base.images[RS_WINE_SCENE_OUTPUT].image||
       !isfinite(request.base.sourceTimeSeconds)||request.base.sourceTimeSeconds<0||
       (wow64&&(request.base.device>>32||request.base.commandBuffer>>32))||
       !rsWineSceneMetadataDecode(&request.base,&request.metadata,&aovs,&matrices))return status;
    if(cancel ? (feature||request.base.flags) :
        (request.base.flags!=RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED||request.base.consumerId!=NATIVE_CONSUMER_ID))return status;
    if(!cancel&&feature!=RS_RECORDED_RECONSTRUCTION)return VK_ERROR_FEATURE_NOT_PRESENT;
    if(!vk_funcs)return VK_ERROR_FEATURE_NOT_PRESENT;
    device=vulkan_device_from_handle((VkDevice)(UINT_PTR)request.base.device);
    if(!device||!device->host.device)return status;
    pthread_mutex_lock(&provider_mutex);
    for(owner=contexts;owner;owner=owner->next)if(owner->generation==request.base.ownerId){atomic_fetch_add_explicit(&owner->references,1,memory_order_relaxed);break;}
    pthread_mutex_unlock(&provider_mutex);
    if(!owner)return VK_ERROR_FEATURE_NOT_PRESENT;
    if(owner->device.wineDevice!=request.base.device||owner->device.device!=device->host.device)goto done;
    if(!owner->callbacks3.submitted||!owner->prepare||!owner->prepareDevice||owner->device.api()!=3){status=VK_ERROR_FEATURE_NOT_PRESENT;goto done;}
    if(!cancel){status=prepare_scene_destination(owner,request.metadata.destinationWindow);if(status!=VK_SUCCESS)goto done;}
    if(pthread_mutex_trylock(&owner->admissionMutex)){status=VK_NOT_READY;goto done;}
    if(cancel){
        if(!scene_admission_matches(&owner->admission,&request))status=VK_ERROR_INITIALIZATION_FAILED;
        else{scene_admission_clear(&owner->admission);status=VK_SUCCESS;}
        goto unlock;
    }
    scene_admission_clear(&owner->admission);
    request.base.reserved[0]=0;request.base.flags=0;
    scene_operation(&request.base,&request.metadata,owner->consumer.owner,&owner->callbacks3,&operation,&color,&aovs,&matrices);
    admitted.size=sizeof(admitted);admitted.version=3;
    ready=owner->prepareDevice(device->host.device,&operation.base,owner->consumer.owner,feature,
        NULL,NULL,owner->prepare,&admitted,&result);
    if(!ready||result.status!=RS_TEMPORAL_OK||result.encoded||!scene_admission_valid(&admitted)){
        if(admitted.callbacks.base.release)admitted.callbacks.base.release(admitted.callbacks.base.storage);
        status=result.status==RS_TEMPORAL_BUSY?VK_NOT_READY:
            result.status==RS_TEMPORAL_UNAVAILABLE?VK_ERROR_FEATURE_NOT_PRESENT:
            result.status==RS_TEMPORAL_INVALID?VK_ERROR_INITIALIZATION_FAILED:VK_ERROR_UNKNOWN;
        goto unlock;
    }
    identity=atomic_fetch_add_explicit(&next_admission,1,memory_order_relaxed);
    if(!identity||identity==NATIVE_CONSUMER_ID){admitted.callbacks.base.release(admitted.callbacks.base.storage);status=VK_ERROR_TOO_MANY_OBJECTS;goto unlock;}
    request.base.consumerId=identity;
    if(!scene_admission_install(&owner->admission,identity,&request,&admitted,&result)){
        admitted.callbacks.base.release(admitted.callbacks.base.storage);status=VK_ERROR_INITIALIZATION_FAILED;goto unlock;
    }
    *packet=request;status=VK_SUCCESS;
 unlock:
    pthread_mutex_unlock(&owner->admissionMutex);
 done:
    release_context(owner);return status;
}

static VkResult query_scene(const RSWineVulkanSceneRequestV2 *packet,BOOL wow64)
{
    const RSWineVulkanSceneRequestV1 *request;
    struct scene_context *owner;
    struct vulkan_device *device;
    RSTemporalFrame shape;
    RSTemporalResult result={.size=sizeof(result),.version=1};
    VkResult status=VK_ERROR_INITIALIZATION_FAILED;
    unsigned i;
    int supported;
    if(!packet)return status;
    request=&packet->base;
    if(request->size!=sizeof(*request)||request->version!=1||request->profile!=RS_WINE_VULKAN_SCENE_PROFILE||
       request->flags!=RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED||!request->device||request->commandBuffer||
       !request->ownerId||request->consumerId!=NATIVE_CONSUMER_ID||request->reserved[1]||
       (request->reserved[0]!=RS_RECORDED_RECONSTRUCTION&&request->reserved[0]!=RS_RECORDED_GENERATION)||
       request->imageMask||request->colorKnown||(wow64&&request->device>>32)||
       packet->metadata.size!=sizeof(packet->metadata)||packet->metadata.version!=2)
        return status;
    for(i=0;i<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++i)
        if(request->images[i].image||request->images[i].aspect||request->images[i].mipLevel||request->images[i].arrayLayer||request->images[i].reserved)return status;
    if(!vk_funcs)return VK_ERROR_FEATURE_NOT_PRESENT;
    device=vulkan_device_from_handle((VkDevice)(UINT_PTR)request->device);
    if(!device||!device->host.device)return status;
    pthread_mutex_lock(&provider_mutex);
    for(owner=contexts;owner;owner=owner->next)if(owner->generation==request->ownerId){atomic_fetch_add_explicit(&owner->references,1,memory_order_relaxed);break;}
    pthread_mutex_unlock(&provider_mutex);
    if(!owner)return VK_ERROR_FEATURE_NOT_PRESENT;
    if(owner->device.wineDevice!=request->device||owner->device.device!=device->host.device)goto done;
    if(!owner->callbacks3.submitted||!owner->query||!owner->queryDevice||owner->device.api()!=3){status=VK_ERROR_FEATURE_NOT_PRESENT;goto done;}
    copy_frame(&shape,request,owner->consumer.owner);shape.commandBufferKind=1;
    // The matched driver alone obtains/retains its actual MTLDevice. This is
    // a scalar shape query: no texture resolution, queue, commands or lease.
    supported=owner->queryDevice(device->host.device,owner->consumer.owner,request->reserved[0],&shape,owner->query,&result);
    status=supported&&result.status==RS_TEMPORAL_OK&&!result.encoded?VK_SUCCESS:
        result.status==RS_TEMPORAL_BUSY?VK_NOT_READY:
        result.status==RS_TEMPORAL_UNAVAILABLE?VK_ERROR_FEATURE_NOT_PRESENT:
        result.status==RS_TEMPORAL_INVALID?VK_ERROR_INITIALIZATION_FAILED:VK_ERROR_UNKNOWN;
 done:
    release_context(owner);return status;
}

static VkResult record_scene(const RSWineVulkanSceneRequestV1 *request, const RSWineSceneMetadataV2 *metadata, BOOL wow64)
{
    struct vulkan_device *device;
    struct vulkan_command_buffer *commands;
    struct scene_provider *provider=NULL;
    struct scene_context *owned = NULL;
    struct scene_admission admission={0};
    const RSVulkanSceneCallbacksV3 *extended=NULL;
    uint32_t owned_demand = 0;
    RSWineVulkanSceneConsumerV1 consumer = {0};
    RSVulkanSceneOperationV3 operation3 = {0};
    RSVulkanSceneOperationV1 *operation = &operation3.base;
    struct RSImageColorDescription color;
    RSSceneAovs aovs = {0};
    RSSceneMatrices matrices = {0};
    VkResult result;
    unsigned int i;

    if (!request || request->size != sizeof(*request) || request->version != 1 ||
        request->profile != RS_WINE_VULKAN_SCENE_PROFILE ||
        (request->flags != RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED && request->flags) ||
        request->reserved[0] || request->reserved[1] || request->frame.reserved ||
        request->colorKnown > 1 || !request->device || !request->commandBuffer ||
        !request->ownerId || !request->frameId || !request->consumerId ||
        !isfinite(request->sourceTimeSeconds) || request->sourceTimeSeconds < 0 ||
        request->imageMask & ~((1u << RS_WINE_VULKAN_SCENE_IMAGE_COUNT) - 1) ||
        !request->images[RS_VULKAN_SCENE_COLOR].image || !request->images[RS_VULKAN_SCENE_OUTPUT].image)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (metadata && !rsWineSceneMetadataDecode(request,metadata,&aovs,&matrices)) return VK_ERROR_INITIALIZATION_FAILED;
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
    else
        for(owned=contexts;owned;owned=owned->next)if(owned->generation==request->ownerId){atomic_fetch_add_explicit(&owned->references,1,memory_order_relaxed);break;}
    pthread_mutex_unlock(&provider_mutex);
    if (!provider && !owned) return VK_ERROR_FEATURE_NOT_PRESENT;
    if(!request->flags){
        RSWineVulkanSceneRequestV2 exact;
        if(!owned||!metadata){result=VK_ERROR_FEATURE_NOT_PRESENT;goto done;}
        exact.base=*request;exact.metadata=*metadata;
        if(pthread_mutex_trylock(&owned->admissionMutex)){result=VK_NOT_READY;goto done;}
        if(!scene_admission_matches(&owned->admission,&exact)){
            pthread_mutex_unlock(&owned->admissionMutex);result=VK_ERROR_INITIALIZATION_FAILED;goto done;
        }
        admission=owned->admission;memset(&owned->admission,0,sizeof(owned->admission));
        pthread_mutex_unlock(&owned->admissionMutex);
        extended=&admission.consumer.callbacks;
    }else if(owned){
        if(request->consumerId!=NATIVE_CONSUMER_ID){result=VK_ERROR_INITIALIZATION_FAILED;goto done;}
        if(!(owned_demand=owned->demand())){result=VK_ERROR_FEATURE_NOT_PRESENT;goto done;}
        if(owned->callbacks3.submitted)extended=&owned->callbacks3;
    }
    consumer.size = sizeof(consumer); consumer.version = 1;
    if(owned){consumer.ownerId=owned->generation;consumer.owner=admission.identity?admission.consumer.owner:owned->consumer.owner;consumer.device=&owned->device;consumer.callbacks=extended?extended->base:owned->callbacks;result=VK_SUCCESS;}
    else result = provider->value.acquire(provider->value.storage, request, &consumer);
    if (result != VK_SUCCESS) goto done;
    if (consumer.size != sizeof(consumer) || consumer.version != 1 ||
        consumer.ownerId != request->ownerId || !consumer.owner ||
        !consumer.device || consumer.device->size != sizeof(*consumer.device) || consumer.device->version != 1 ||
        consumer.device->wineDevice != request->device || consumer.device->device != device->host.device ||
        !consumer.device->api || !consumer.device->record ||
        consumer.callbacks.size != (extended?sizeof(RSVulkanSceneCallbacksV3):sizeof(consumer.callbacks)) ||
        (consumer.callbacks.version != 1 && consumer.callbacks.version != 2 && consumer.callbacks.version != 3) ||
        (consumer.callbacks.version==3&&(!extended||!extended->submitted||consumer.device->api()!=3)) ||
        (consumer.callbacks.version==2&&consumer.device->api()!=2&&consumer.device->api()!=3) ||
        (consumer.callbacks.version==1&&consumer.device->api()!=1) ||
        (consumer.callbacks.version>=2&&!consumer.callbacks.completed) ||
        !consumer.callbacks.retain || !consumer.callbacks.release || !consumer.callbacks.encode)
    { result=VK_ERROR_INITIALIZATION_FAILED;goto done; }

    if(owned && extended && !admission.identity){
        result=prepare_scene_destination(owned,metadata?metadata->destinationWindow:0);
        if(result!=VK_SUCCESS)goto done;
    }
    consumer.callbacks.retain(consumer.callbacks.storage);
    operation->size = sizeof(*operation); operation->version = 1;
    if(consumer.callbacks.version==3){operation->size=sizeof(operation3);operation->version=3;operation3.submitted=extended->submitted;}
    operation->flags = request->flags;
    if(owned&&owned->staging)operation->flags|=RS_VULKAN_SCENE_PREPARED_TRACKED_BOUNDARY;
    operation->imageMask = owned && !admission.identity ? request->imageMask & owned_demand : request->imageMask;
    if(owned)operation->imageMask |= (1u<<RS_VULKAN_SCENE_COLOR)|(1u<<RS_VULKAN_SCENE_OUTPUT);
    copy_frame(&operation->frame, request, consumer.owner);
    operation->frame.commandBufferKind=consumer.callbacks.version>=2?1:0;
    for (i = 0; i < RS_WINE_VULKAN_SCENE_IMAGE_COUNT; ++i)
    {
        operation->images[i].image = (VkImage)request->images[i].image;
        operation->images[i].aspect = request->images[i].aspect;
        operation->images[i].mipLevel = request->images[i].mipLevel;
        operation->images[i].arrayLayer = request->images[i].arrayLayer;
    }
    if (request->colorKnown) { memcpy(&color, &request->color, sizeof(color)); operation->color = &color; }
    operation->aovs = metadata && metadata->aovMask ? &aovs : consumer.aovs;
    operation->matrices = metadata && metadata->matrixFlags ? &matrices : consumer.matrices;
    operation->sourceTimeSeconds = request->sourceTimeSeconds;
    operation->callbacks = consumer.callbacks;
    result = consumer.device->record(commands->host.command_buffer, operation);
    consumer.callbacks.release(consumer.callbacks.storage);
 done:
    scene_admission_clear(&admission);
    release_provider(provider);
    release_context(owned);
    return result;
}

NTSTATUS maclauncher_scene_record64(void *args)
{
    struct maclauncher_scene_record_params *params = args;
    params->result = params->reserved==1 ? context_control((RSWineVulkanSceneContextV1 *)(UINT_PTR)params->request,FALSE) :
        params->reserved==5 ? query_scene((const RSWineVulkanSceneRequestV2 *)(UINT_PTR)params->request,FALSE) :
        params->reserved==3||params->reserved==4 ? prepare_scene((RSWineVulkanSceneRequestV2 *)(UINT_PTR)params->request,FALSE,params->reserved==4) :
        params->reserved==2 ? record_scene(&((const RSWineVulkanSceneRequestV2 *)(UINT_PTR)params->request)->base, &((const RSWineVulkanSceneRequestV2 *)(UINT_PTR)params->request)->metadata, FALSE) : params->reserved ? VK_ERROR_INITIALIZATION_FAILED : record_scene((const RSWineVulkanSceneRequestV1 *)(UINT_PTR)params->request, NULL, FALSE);
    return STATUS_SUCCESS;
}

NTSTATUS maclauncher_scene_record32(void *args)
{
    struct maclauncher_scene_record_params *params = args;
    params->result = params->request >> 32 ? VK_ERROR_INITIALIZATION_FAILED : params->reserved==1 ?
        context_control((RSWineVulkanSceneContextV1 *)UlongToPtr((UINT32)params->request),TRUE) :
        params->reserved==5 ? query_scene((const RSWineVulkanSceneRequestV2 *)UlongToPtr((UINT32)params->request),TRUE) :
        params->reserved==3||params->reserved==4 ? prepare_scene((RSWineVulkanSceneRequestV2 *)UlongToPtr((UINT32)params->request),TRUE,params->reserved==4) :
        params->reserved==2 ? record_scene(&((const RSWineVulkanSceneRequestV2 *)UlongToPtr((UINT32)params->request))->base, &((const RSWineVulkanSceneRequestV2 *)UlongToPtr((UINT32)params->request))->metadata, TRUE) : params->reserved ? VK_ERROR_INITIALIZATION_FAILED : record_scene((const RSWineVulkanSceneRequestV1 *)UlongToPtr((UINT32)params->request), NULL, TRUE);
    return STATUS_SUCCESS;
}
