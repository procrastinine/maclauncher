#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "scene-matrices.hpp"
namespace macfx {
enum class MetalFxImageKind { Spatial, Interpolation };
struct MetalFxImageRegion { uint32_t x=0,y=0,width=0,height=0; };
struct MetalFxImageInputs {
    RSTemporalFrame frame{};
    std::vector<id<MTLTexture>> retained;
    id<MTLFence> fence=nil;
    id<MTLTexture> previousColor=nil,uiColor=nil,depth=nil,motion=nil,distortion=nil;
    MetalFxImageRegion colorRegion,outputRegion,depthRegion,motionRegion,distortionRegion;
    uint32_t inputWidth=0,inputHeight=0,contentWidth=0,contentHeight=0;
    RSSceneMatrices matrices{},previousMatrices{};
    bool matricesValid=false,previousMatricesValid=false,uiComposited=false;
    float aspectRatio=0;
    std::string sceneReason;
};
// Read an actual SDK object's public properties at its encode boundary. No
// commands, allocations or color-description inference occur here. The caller
// binds its exact source color metadata and retains this snapshot per flight.
ShaderResult captureMetalFxImageInputs(id sdk,MetalFxImageKind,id commands,
    void*owner,uint64_t frameId,MetalFxImageInputs&);
}
