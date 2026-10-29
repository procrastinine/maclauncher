// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see ffx-lens-MIT.txt.
#pragma once
#include <array>
#include <cstdint>
namespace macfx::ffx_lens_host {
typedef struct LensConstants
{
    float grainScale;
    float grainAmount;
    uint32_t grainSeed;
    uint32_t pad;

    uint32_t center[2];
    float chromAb;
    float vignette;

} LensConstants;
inline std::array<unsigned,3>dispatch(unsigned width,unsigned height){return {(width+7)/8,(height+7)/8,1};}
}
