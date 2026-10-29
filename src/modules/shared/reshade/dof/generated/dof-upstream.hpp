// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see dof-MIT.txt.
#pragma once
#include <array>
#include <cstdint>
namespace macfx::dof_host {
typedef struct DofConstants
{
    float       cocScale;
    float       cocBias;
    uint32_t    inputSizeHalf[2];
    uint32_t    inputSize[2];
    float       inputSizeHalfRcp[2];
    float       cocLimit;
    uint32_t    maxRings;
} DofConstants;
struct Dispatch{const char*name;uint32_t x,y;};
inline std::array<Dispatch,5> schedule(uint32_t width,uint32_t height){
uint32_t halfWidth = (width + 1) / 2, halfHeight = (height + 1) / 2;

    uint32_t dsTilesX = (width + 63) / 64;
    uint32_t dsTilesY = (height + 63) / 64;
    uint32_t fullTilesX = (width + 7) / 8;
    uint32_t fullTilesY = (height + 7) / 8;
    uint32_t tilesX = (halfWidth + 7) / 8;
    uint32_t tilesY = (halfHeight + 7) / 8;
return {{{"downsample-depth",(fullTilesX + 7) / 8,(fullTilesY + 7) / 8},{"downsample-color",dsTilesX,dsTilesY},{"dilate",(fullTilesX + 7) / 8,(fullTilesY + 7) / 8},{"blur",tilesX,tilesY},{"composite",tilesX,tilesY}}};
}
}
