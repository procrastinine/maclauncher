/* Copyright (c) MacLauncher contributors. MIT license. */
#include "vulkan_loader.h"
#include "scene-request.h"

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
