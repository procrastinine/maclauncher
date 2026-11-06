/* Copyright (c) MacLauncher contributors. MIT license.
 * Included at the end of the owned VKD3D command.c adaptation. */
#include "maclauncher-scene-metadata.h"

__declspec(dllexport) int32_t WINAPI MacLauncherVkd3dSceneContext1(
        ID3D12GraphicsCommandList *iface, uint64_t *device, uint64_t *commands)
{
    struct d3d12_command_list *list;
    if (!iface || !device || !commands) return VK_ERROR_INITIALIZATION_FAILED;
    list=unsafe_impl_from_ID3D12CommandList((ID3D12CommandList *)iface);
    if(!list || !list->is_recording)return VK_ERROR_INITIALIZATION_FAILED;
    *device=(uint64_t)(uintptr_t)list->device->vk_device;
    *commands=(uint64_t)(uintptr_t)list->cmd.vk_command_buffer;
    return VK_SUCCESS;
}

/* PE-only typed exports. Resource pointers never enter a Wine wire packet. */
__declspec(dllexport) int32_t WINAPI MacLauncherVkd3dResolveSceneImage1(
        ID3D12Resource *iface, uint32_t mip, uint32_t layer, uint32_t aspect,
        RSWineVulkanSceneImageV1 *image, uint32_t *width, uint32_t *height)
{
    struct d3d12_resource *resource;
    uint32_t native_aspect;
    if (!iface || !image || !width || !height) return VK_ERROR_INITIALIZATION_FAILED;
    resource = impl_from_ID3D12Resource(iface);
    if (resource->desc.Dimension != D3D12_RESOURCE_DIMENSION_TEXTURE2D ||
        resource->desc.SampleDesc.Count != 1 || mip >= resource->desc.MipLevels ||
        layer >= resource->desc.DepthOrArraySize || !resource->res.vk_image)
        return VK_ERROR_FEATURE_NOT_PRESENT;
    native_aspect = resource->desc.Flags & D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL ?
            VK_IMAGE_ASPECT_DEPTH_BIT : VK_IMAGE_ASPECT_COLOR_BIT;
    if (aspect && aspect != native_aspect) return VK_ERROR_FEATURE_NOT_PRESENT;
    *image = (RSWineVulkanSceneImageV1){(uint64_t)resource->res.vk_image,native_aspect,mip,layer,0};
    *width = mip >= 32 ? 1 : (uint32_t)(resource->desc.Width >> mip);
    *height = mip >= 32 ? 1 : resource->desc.Height >> mip;
    if (!*width) *width = 1;
    if (!*height) *height = 1;
    return VK_SUCCESS;
}

__declspec(dllexport) int32_t WINAPI MacLauncherVkd3dRecordScene2(
        ID3D12GraphicsCommandList *iface, const RSWineVulkanSceneRequestV2 *source,
        ID3D12Resource *const *resources)
{
    struct d3d12_command_list *list;
    const struct vkd3d_vk_device_procs *vk_procs;
    RSWineVulkanSceneRequestV2 request;
    RSWineVulkanSceneRecordCall2 record;
    VkMemoryBarrier2 barrier;
    VkDependencyInfo dependency;
    HMODULE module;
    char enabled[2];
    int32_t status;
    unsigned i;
    if (!iface || !source || !resources || source->base.size != sizeof(source->base) ||
        source->base.version != 1 || source->base.flags != RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED ||
        source->base.imageMask & ~((1u << RS_WINE_VULKAN_SCENE_IMAGE_COUNT)-1))
        return VK_ERROR_INITIALIZATION_FAILED;
    if(GetEnvironmentVariableA("MACLAUNCHER_NGX_SCENE_ENABLE",enabled,sizeof(enabled))!=1 || enabled[0]!='1')return VK_ERROR_FEATURE_NOT_PRESENT;
    list = unsafe_impl_from_ID3D12CommandList((ID3D12CommandList *)iface);
    if (!list || !list->is_recording) return VK_ERROR_INITIALIZATION_FAILED;
    request = *source;
    if ((request.base.device && request.base.device != (uint64_t)(uintptr_t)list->device->vk_device) ||
        (request.base.commandBuffer && request.base.commandBuffer != (uint64_t)(uintptr_t)list->cmd.vk_command_buffer))
        return VK_ERROR_INITIALIZATION_FAILED;
    request.base.device = (uint64_t)(uintptr_t)list->device->vk_device;
    request.base.commandBuffer = (uint64_t)(uintptr_t)list->cmd.vk_command_buffer;
    for (i=0;i<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++i) if(request.base.imageMask & (1u<<i)) {
        RSWineVulkanSceneImageV1 image;
        const RSWineVulkanSceneImageV1 *expected=&request.base.images[i];
        uint32_t width,height;
        status=MacLauncherVkd3dResolveSceneImage1(resources[i],expected->mipLevel,expected->arrayLayer,expected->aspect,&image,&width,&height);
        if(status!=VK_SUCCESS)return status;
        if(image.image!=expected->image)return VK_ERROR_INITIALIZATION_FAILED;
    }
    /* Keep the loaded PE module alive for the call. No native PFN is invoked
     * by the translator and no driver name is used as a capability marker. */
    if (!GetModuleHandleExW(0,L"winevulkan.dll",&module))return VK_ERROR_FEATURE_NOT_PRESENT;
    record=(RSWineVulkanSceneRecordCall2)GetProcAddress(module,"MacLauncherWineVulkanRecordScene2");
    if (!record) { FreeLibrary(module);return VK_ERROR_FEATURE_NOT_PRESENT; }
    vk_procs=&list->device->vk_procs;
    d3d12_command_list_flush_dgc_batch(list);
    d3d12_command_list_end_current_render_pass(list,false);
    d3d12_command_list_end_transfer_batch(list,false);
    for(i=0;i<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++i)if(request.base.imageMask & (1u<<i))
        d3d12_command_list_track_resource_usage(list,impl_from_ID3D12Resource(resources[i]),true);
    memset(&barrier,0,sizeof(barrier));
    memset(&dependency,0,sizeof(dependency));
    barrier.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER_2;
    barrier.srcStageMask=barrier.dstStageMask=VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
    barrier.srcAccessMask=barrier.dstAccessMask=VK_ACCESS_2_MEMORY_READ_BIT|VK_ACCESS_2_MEMORY_WRITE_BIT;
    dependency.sType=VK_STRUCTURE_TYPE_DEPENDENCY_INFO;dependency.memoryBarrierCount=1;dependency.pMemoryBarriers=&barrier;
    VK_CALL(vkCmdPipelineBarrier2(list->cmd.vk_command_buffer,&dependency));
    status=record(&request);
    VK_CALL(vkCmdPipelineBarrier2(list->cmd.vk_command_buffer,&dependency));
    FreeLibrary(module);
    /* Recording never authorizes omission of the original NGX operation. */
    return status;
}
