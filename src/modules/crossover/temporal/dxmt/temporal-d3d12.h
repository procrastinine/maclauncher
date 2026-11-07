// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include <d3d12.h>
#include "camera.h"
#include "frame.h"
// PE-only producer boundary: real D3D12 objects, never native Metal pointers.
struct MLTemporalD3D12 {
 uint32_t size=sizeof(MLTemporalD3D12),version=1;
 ID3D12Resource *color=nullptr,*depth=nullptr,*motion=nullptr,*output=nullptr,*exposure=nullptr;
 uint32_t width=0,height=0,maxWidth=0,maxHeight=0;
 float jitterX=0,jitterY=0,motionScaleX=1,motionScaleY=1,preExposure=1;
 bool reset=false,autoExposure=false,displayMotion=false;
 uint32_t flags=0;uint64_t frameId=0;float frameTimeMs=0,sharpness=0;
 RSTemporalCamera camera{};
};
using MLTemporalD3D12Record=HRESULT(WINAPI*)(ID3D12GraphicsCommandList*,const MLTemporalD3D12*,void**);
using MLTemporalD3D12Release=void(WINAPI*)(void*);
using MLTemporalD3D12Supported=BOOL(WINAPI*)(ID3D12Device*);
