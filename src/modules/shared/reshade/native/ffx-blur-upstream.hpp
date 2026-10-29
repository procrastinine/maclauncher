// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see ffx-blur-MIT.txt.
#pragma once
#include <array>
#include <cstdint>
namespace macfx::ffx_blur_host {
typedef struct BlurConstants
{
    uint32_t width; ///< Width in pixels of input image.
    uint32_t height; ///< Height in pixels of input image.
} BlurConstants;
inline std::array<unsigned,3>dispatch(unsigned width,unsigned height){return {(width+7)/8,8,1};}
}
