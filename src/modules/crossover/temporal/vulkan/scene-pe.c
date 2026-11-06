/* Copyright (c) MacLauncher contributors. MIT license. */
#include "vulkan_loader.h"
#include "scene-request.h"
#include "scene-metadata.h"

extern BOOL maclauncher_scene_initialize(void);
static LONG matched_unix_profile;
static BOOL matched_profile(VkDevice device)
{
    struct is_available_device_function_params probe;
    if(InterlockedCompareExchange(&matched_unix_profile,0,0))return TRUE;
    /* Stock handlers may unwrap device before checking the function name.
     * No native owner exists until a real device established this marker. */
    if(!device)return FALSE;
    probe.device=device;probe.name="MacLauncherWineVulkanSceneABI1";
    if((uint32_t)UNIX_CALL(is_available_device_function,&probe)!=RS_WINE_VULKAN_SCENE_PROFILE)return FALSE;
    InterlockedExchange(&matched_unix_profile,1);return TRUE;
}

uint32_t WINAPI MacLauncherWineVulkanSceneAPI1(void)
{
    return RS_WINE_VULKAN_SCENE_VERSION;
}

int32_t WINAPI MacLauncherWineVulkanRecordScene1(const RSWineVulkanSceneRequestV1 *request)
{
    struct maclauncher_scene_record_params params = {0};
    NTSTATUS status;
    if (!request || request->size != sizeof(*request) ||
        request->version != RS_WINE_VULKAN_SCENE_VERSION ||
        request->profile != RS_WINE_VULKAN_SCENE_PROFILE ||
        !request->device || !request->commandBuffer)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (!maclauncher_scene_initialize()) return VK_ERROR_FEATURE_NOT_PRESENT;
    /* This original table entry exists in the unmodified module too. Never
     * enter the additive index until the matching Unix owner identifies it. */
    if (!matched_profile((VkDevice)(UINT_PTR)request->device))
        return VK_ERROR_FEATURE_NOT_PRESENT;
    params.request = (UINT_PTR)request;
    params.result = VK_ERROR_FEATURE_NOT_PRESENT;
    status = UNIX_CALL(maclauncher_scene_record, &params);
    return status ? VK_ERROR_INITIALIZATION_FAILED : params.result;
}

int32_t WINAPI MacLauncherWineVulkanSceneContext1(RSWineVulkanSceneContextV1 *context)
{
    struct maclauncher_scene_record_params params = {0};
    NTSTATUS status;
    if (!context || context->size != sizeof(*context) || context->version != 1 ||
        context->profile != RS_WINE_VULKAN_SCENE_PROFILE || !context->observerId)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (!maclauncher_scene_initialize()) return VK_ERROR_FEATURE_NOT_PRESENT;
    if (!matched_profile((VkDevice)(UINT_PTR)context->device))
        return VK_ERROR_FEATURE_NOT_PRESENT;
    params.request = (UINT_PTR)context;
    params.reserved = 1;
    params.result = VK_ERROR_FEATURE_NOT_PRESENT;
    status = UNIX_CALL(maclauncher_scene_record, &params);
    return status ? VK_ERROR_INITIALIZATION_FAILED : params.result;
}

int32_t WINAPI MacLauncherWineVulkanRecordScene2(const RSWineVulkanSceneRequestV2 *request)
{
    struct maclauncher_scene_record_params params = {0};
    NTSTATUS status;
    if (!request || request->base.size != sizeof(request->base) || request->base.version != 1 ||
        request->base.profile != RS_WINE_VULKAN_SCENE_PROFILE || !request->base.device || !request->base.commandBuffer ||
        request->metadata.size != sizeof(request->metadata) || request->metadata.version != 2)
        return VK_ERROR_INITIALIZATION_FAILED;
    if (!maclauncher_scene_initialize() || !matched_profile((VkDevice)(UINT_PTR)request->base.device))
        return VK_ERROR_FEATURE_NOT_PRESENT;
    // Negotiate the additive selector through the existing safe probe first.
    { struct is_available_device_function_params probe;
      probe.device=(VkDevice)(UINT_PTR)request->base.device;probe.name="MacLauncherWineVulkanSceneMetadataABI2";
      if ((uint32_t)UNIX_CALL(is_available_device_function,&probe)!=RS_WINE_VULKAN_SCENE_PROFILE) return VK_ERROR_FEATURE_NOT_PRESENT; }
    params.request=(UINT_PTR)request;params.reserved=2;params.result=VK_ERROR_FEATURE_NOT_PRESENT;
    status=UNIX_CALL(maclauncher_scene_record,&params);
    return status ? VK_ERROR_INITIALIZATION_FAILED : params.result;
}

static int32_t prepared_scene_call(RSWineVulkanSceneRequestV2 *request,uint32_t selector)
{
    struct maclauncher_scene_record_params params={0};
    struct is_available_device_function_params probe;
    NTSTATUS status;
    if(!request||request->base.size!=sizeof(request->base)||request->base.version!=1||
       request->base.profile!=RS_WINE_VULKAN_SCENE_PROFILE||!request->base.device||
       (selector!=5&&!request->base.commandBuffer)||request->metadata.size!=sizeof(request->metadata)||request->metadata.version!=2)
        return VK_ERROR_INITIALIZATION_FAILED;
    if(!maclauncher_scene_initialize()||!matched_profile((VkDevice)(UINT_PTR)request->base.device))return VK_ERROR_FEATURE_NOT_PRESENT;
    probe.device=(VkDevice)(UINT_PTR)request->base.device;
    probe.name=selector==5?"MacLauncherWineVulkanSceneQueryABI3":"MacLauncherWineVulkanScenePreparationABI3";
    if((uint32_t)UNIX_CALL(is_available_device_function,&probe)!=RS_WINE_VULKAN_SCENE_PROFILE)return VK_ERROR_FEATURE_NOT_PRESENT;
    params.request=(UINT_PTR)request;params.reserved=selector;params.result=VK_ERROR_FEATURE_NOT_PRESENT;
    status=UNIX_CALL(maclauncher_scene_record,&params);
    return status?VK_ERROR_INITIALIZATION_FAILED:params.result;
}

int32_t WINAPI MacLauncherWineVulkanPrepareScene3(RSWineVulkanSceneRequestV2 *request,uint32_t feature)
{
    RSWineVulkanSceneRequestV2 copy;
    int32_t result;
    if(!request||request->base.reserved[0]||request->base.reserved[1])return VK_ERROR_INITIALIZATION_FAILED;
    copy=*request;copy.base.reserved[0]=feature;
    result=prepared_scene_call(&copy,3);
    if(result==VK_SUCCESS){
        if(copy.base.reserved[0]||copy.base.reserved[1]||copy.base.flags||!copy.base.consumerId)return VK_ERROR_INITIALIZATION_FAILED;
        *request=copy;
    }
    return result;
}

int32_t WINAPI MacLauncherWineVulkanCancelScene3(const RSWineVulkanSceneRequestV2 *request)
{
    RSWineVulkanSceneRequestV2 copy;
    if(!request)return VK_ERROR_INITIALIZATION_FAILED;
    copy=*request;return prepared_scene_call(&copy,4);
}

int32_t WINAPI MacLauncherWineVulkanQueryScene3(const RSWineVulkanSceneRequestV2 *request,uint32_t feature)
{
    RSWineVulkanSceneRequestV2 copy;
    if(!request||request->base.reserved[0]||request->base.reserved[1])return VK_ERROR_INITIALIZATION_FAILED;
    copy=*request;copy.base.reserved[0]=feature;return prepared_scene_call(&copy,5);
}
