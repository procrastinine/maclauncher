#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <cmath>
#include <cstdint>
#include <cstring>
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "../../../temporal/frame.h"
#endif
namespace anr {
// The B15 program reads one 204-byte frame block per real frame pair. Its
// depth-pick kernel linearizes the current depth image with the planes at
// bytes 8 and 12 and stores that view depth as the current half-resolution
// history; bytes 0 and 4 hold the previous camera, read only by the
// reprojection-matrix path that flag 128 disables. Flag 1 marks reversed
// depth. Flag 2 selects a far plane at infinity: view depth is near/depth for
// reversed depth and near/(1-depth) otherwise, and the far plane is not read.
// Without it view depth is near*far/(near+depth*(far-near)) for reversed
// depth and near*far/(far-depth*(far-near)) otherwise. Every view depth is
// clamped to [near, near*1e8]. Flag 256 marks valid history.
constexpr size_t FrameBytes=204;
enum FrameFlags:uint32_t{FrameReversedDepth=1u,FrameInfiniteDepth=2u,FrameNoMatrix=128u,FrameHistory=256u};
struct Camera{float nearPlane=0,farPlane=0;bool reversed=false,infinite=false;};
inline bool unboundedFar(float far){return std::isinf(far)&&far>0;}
// The shared frame declares infinite depth with RS_TEMPORAL_DEPTH_INFINITE and
// a zero far plane; an unbounded far plane is the same limit. Undeclared
// planes are never filled in.
inline const char*cameraReason(const RSTemporalFrame&f){
 if(!(f.flags&RS_TEMPORAL_CAMERA_VALID)||!std::isfinite(f.nearPlane)||f.nearPlane<=0)return "ANR requires the declared camera near plane";
 if(f.flags&RS_TEMPORAL_DEPTH_INFINITE)return f.farPlane==0||unboundedFar(f.farPlane)?nullptr:"ANR requires infinite depth without a finite far plane";
 if(unboundedFar(f.farPlane))return nullptr;
 return std::isfinite(f.farPlane)&&f.farPlane>f.nearPlane?nullptr:"ANR requires a far plane beyond the near plane or declared infinite depth";
}
// Infinite cameras carry far 0: the program never reads it under flag 2.
inline Camera frameCamera(const RSTemporalFrame&f){
 const bool infinite=(f.flags&RS_TEMPORAL_DEPTH_INFINITE)||unboundedFar(f.farPlane);
 return {f.nearPlane,infinite?0.f:f.farPlane,bool(f.flags&RS_TEMPORAL_DEPTH_REVERSED),infinite};
}
// One flag word covers both cameras, so the caller restarts history when depth
// switches between finite and infinite and passes previous == current then.
inline void frameConstants(uint8_t(&out)[FrameBytes],const Camera&current,const Camera&previous,float motionX,float motionY,float jitterX,float jitterY,bool history,uint32_t width,uint32_t height){
 std::memset(out,0,sizeof(out));
 const float values[]={previous.nearPlane,previous.farPlane,current.nearPlane,current.farPlane,motionX,motionY,jitterX,jitterY};std::memcpy(out,values,sizeof(values));
 const uint32_t flags=FrameNoMatrix|(current.reversed?FrameReversedDepth:0u)|(current.infinite?FrameInfiniteDepth:0u)|(history?FrameHistory:0u);std::memcpy(out+32,&flags,4);
 const uint32_t sizes[]={width,height,width,height};std::memcpy(out+36,sizes,sizeof(sizes));
}
}
