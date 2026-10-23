// SPDX-License-Identifier: GPL-3.0-or-later
// Owned vocabulary adapter for MAKO's graph metadata. No Vulkan API or ABI.
#pragma once
#define VK_NULL_HANDLE nullptr
#include <cstdint>
using VkImage=void*;using VkFormat=uint32_t;
struct VkExtent2D {uint32_t width,height;};
struct VkImageSubresourceRange {uint32_t aspectMask=0,baseMipLevel=0,levelCount=0,baseArrayLayer=0,layerCount=0;};
struct VkImageMemoryBarrier {uint32_t sType=0,srcAccessMask=0,dstAccessMask=0,oldLayout=0,newLayout=0,srcQueueFamilyIndex=0,dstQueueFamilyIndex=0;VkImage image=nullptr;VkImageSubresourceRange subresourceRange;};
constexpr uint32_t VK_FORMAT_R8_UNORM=9,VK_FORMAT_R8G8B8A8_UNORM=37,VK_FORMAT_R16G16B16A16_SFLOAT=97;
constexpr uint32_t VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER=45,VK_ACCESS_SHADER_WRITE_BIT=64,VK_ACCESS_SHADER_READ_BIT=32,VK_IMAGE_LAYOUT_GENERAL=1,VK_IMAGE_ASPECT_COLOR_BIT=1,VK_QUEUE_FAMILY_IGNORED=0xffffffff;
