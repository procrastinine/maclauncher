// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
// Camera fields of the B15 program's 204-byte frame constants. Its pair
// kernels linearize both depths from near/far at bytes 0/4 (current) and
// 8/12 (previous) under the flags word at byte 32: bit 1 marks reversed depth
// and bit 2 infinite depth, for both depths. With bit 2 the kernels compute
// near / max(d, 1e-12) for reversed depth and near / max(1 - d, 1e-12)
// otherwise, and never read the far plane. Without it they compute
// near * far / max(t, 1e-12) with t = near + d * (far - near) for reversed
// depth and t = far - d * (far - near) otherwise. Bit 128 selects the model's
// no-matrix path and bit 256 marks valid history.
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "../../../temporal/frame.h"
#endif
#include <cmath>
#include <cstdint>
namespace anr {
enum : uint32_t {FrameReversedDepth=1u,FrameInfiniteDepth=2u,FrameNoMatrix=128u,FrameHistory=256u};
struct DepthPlanes {float nearPlane=0,farPlane=0;bool infinite=false;};
// The shared frame declares infinite depth with RS_TEMPORAL_DEPTH_INFINITE and
// a zero far plane; an unbounded far plane is the same limit.
inline bool unboundedFar(float far){return std::isinf(far)&&far>0;}
inline const char*cameraReason(const RSTemporalFrame&f){
 if(!(f.flags&RS_TEMPORAL_CAMERA_VALID)||!std::isfinite(f.nearPlane)||f.nearPlane<=0)return "ANR requires the declared camera near plane";
 if(f.flags&RS_TEMPORAL_DEPTH_INFINITE)return f.farPlane==0||unboundedFar(f.farPlane)?nullptr:"ANR requires infinite depth without a finite far plane";
 if(unboundedFar(f.farPlane))return nullptr;
 return std::isfinite(f.farPlane)&&f.farPlane>f.nearPlane?nullptr:"ANR requires a far plane beyond the near plane or declared infinite depth";
}
// Infinite planes carry far 0: the program never reads it under bit 2.
inline DepthPlanes depthPlanes(const RSTemporalFrame&f){const bool infinite=(f.flags&RS_TEMPORAL_DEPTH_INFINITE)||unboundedFar(f.farPlane);return {f.nearPlane,infinite?0.f:f.farPlane,infinite};}
inline uint32_t frameFlags(const RSTemporalFrame&f,bool history){return FrameNoMatrix|((f.flags&RS_TEMPORAL_DEPTH_REVERSED)?FrameReversedDepth:0u)|(depthPlanes(f).infinite?FrameInfiniteDepth:0u)|(history?FrameHistory:0u);}
}
