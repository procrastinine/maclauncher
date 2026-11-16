// The ANR provider's camera admission and frame constants against the depth
// linearization of the B15 program's pair kernels (frame-camera.h).
#include "frame-camera.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>
// The program's linear depth for one frame's near/far and the flags word.
static float programLinear(float d,float near,float far,uint32_t flags){
 const bool reversed=flags&anr::FrameReversedDepth;
 if(flags&anr::FrameInfiniteDepth)return near/std::fmax(reversed?d:1-d,1e-12f);
 const float t=reversed?near+d*(far-near):far-d*(far-near);
 return near*far/std::fmax(t,1e-12f);
}
static bool close(float a,float b){return std::fabs(a-b)<=2e-6f*std::fabs(b);}
static RSTemporalFrame camera(float near,float far,uint32_t flags){RSTemporalFrame f{};f.size=sizeof(f);f.version=1;f.nearPlane=near;f.farPlane=far;f.flags=RS_TEMPORAL_CAMERA_VALID|flags;return f;}
int main(){
 // Unreal Engine 4: reversed-Z with MinZ == MaxZ, an infinite far plane.
 // NGX and FidelityFX declare it with RS_TEMPORAL_DEPTH_INFINITE and far 0.
 auto unreal=camera(10,0,RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE);
 assert(!anr::cameraReason(unreal));
 auto planes=anr::depthPlanes(unreal);auto flags=anr::frameFlags(unreal,true);
 assert(planes.infinite&&planes.nearPlane==10&&planes.farPlane==0);
 assert(flags==(anr::FrameNoMatrix|anr::FrameReversedDepth|anr::FrameInfiniteDepth|anr::FrameHistory));
 for(float z:{10.f,37.5f,1000.f,1.e5f,7.5e6f})assert(close(programLinear(10/z,planes.nearPlane,planes.farPlane,flags),z));
 // An unbounded far plane is the same limit; finite far with infinite depth contradicts it.
 assert(!anr::cameraReason(camera(10,INFINITY,RS_TEMPORAL_DEPTH_REVERSED)));
 assert(anr::depthPlanes(camera(10,INFINITY,0)).infinite&&anr::depthPlanes(camera(10,INFINITY,0)).farPlane==0);
 assert(!anr::cameraReason(camera(10,INFINITY,RS_TEMPORAL_DEPTH_INFINITE)));
 assert(anr::cameraReason(camera(10,75000,RS_TEMPORAL_DEPTH_INFINITE)));
 // Conventional infinite depth: d = 1 - near/z.
 auto forward=camera(.1f,0,RS_TEMPORAL_DEPTH_INFINITE);flags=anr::frameFlags(forward,false);
 assert(!anr::cameraReason(forward)&&flags==(anr::FrameNoMatrix|anr::FrameInfiniteDepth));
 // The stored depth already rounds 1 - near/z, so the exact value is near / (1 - stored depth).
 for(float z:{.5f,4.f,90.f}){const float d=1-.1f/z;assert(close(programLinear(d,.1f,0,flags),float(.1/(1.0-double(d)))));}
 // Finite planes keep the previous constants and flags.
 auto finite=camera(.24f,15000,RS_TEMPORAL_DEPTH_REVERSED);planes=anr::depthPlanes(finite);flags=anr::frameFlags(finite,false);
 assert(!anr::cameraReason(finite)&&!planes.infinite&&planes.farPlane==15000&&flags==(anr::FrameNoMatrix|anr::FrameReversedDepth));
 for(float z:{.24f,3.f,800.f,15000.f}){const float d=.24f*(15000-z)/(z*(15000-.24f));assert(close(programLinear(d,.24f,15000,flags),z));}
 // Undeclared planes are never filled in.
 assert(anr::cameraReason(camera(0,0,RS_TEMPORAL_DEPTH_INFINITE)));
 assert(anr::cameraReason(camera(10,10,0)));assert(anr::cameraReason(camera(10,0,0)));
 auto undeclared=camera(10,0,RS_TEMPORAL_DEPTH_INFINITE);undeclared.flags&=~RS_TEMPORAL_CAMERA_VALID;assert(anr::cameraReason(undeclared));
 std::puts("anr-frame-camera: pass");
}
