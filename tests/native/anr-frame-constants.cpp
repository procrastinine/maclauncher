// The ANR provider's camera admission and frame block against the depth pick
// of the B15 program (frame_constants.hpp).
#include "frame_constants.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <limits>
// The program's current view depth: flags at byte 32, the current planes at
// bytes 8 and 12, and the clamp to [near, near*1e8].
static float programDepth(const uint8_t(&block)[anr::FrameBytes],float d){
 float near,far;uint32_t flags;std::memcpy(&near,block+8,4);std::memcpy(&far,block+12,4);std::memcpy(&flags,block+32,4);
 const bool reversed=flags&anr::FrameReversedDepth;float z;
 if(flags&anr::FrameInfiniteDepth)z=near/std::fmax(reversed?d:1-d,1e-12f);
 else z=near*far/std::fmax(reversed?near+d*(far-near):far-d*(far-near),1e-12f);
 return std::fmin(std::fmax(z,near),near*1e8f);
}
static float at(const uint8_t(&block)[anr::FrameBytes],size_t offset){float v;std::memcpy(&v,block+offset,4);return v;}
static uint32_t word(const uint8_t(&block)[anr::FrameBytes],size_t offset){uint32_t v;std::memcpy(&v,block+offset,4);return v;}
static bool close(float a,float b){return std::fabs(a-b)<=2e-6f*std::fabs(b);}
static RSTemporalFrame camera(float near,float far,uint32_t flags){RSTemporalFrame f{};f.size=sizeof(f);f.version=1;f.nearPlane=near;f.farPlane=far;f.flags=RS_TEMPORAL_CAMERA_VALID|flags;return f;}
int main(){
 const float inf=std::numeric_limits<float>::infinity();uint8_t block[anr::FrameBytes];
 // Unreal Engine 4: reversed-Z with an infinite far plane, declared by NGX and
 // FidelityFX with RS_TEMPORAL_DEPTH_INFINITE and far 0.
 auto unreal=camera(10,0,RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE);assert(!anr::cameraReason(unreal));
 auto current=anr::frameCamera(unreal);assert(current.infinite&&current.reversed&&current.nearPlane==10&&current.farPlane==0);
 auto previous=anr::frameCamera(camera(12,0,RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE));
 anr::frameConstants(block,current,previous,1,1,0,0,true,1920,1080);
 // The current camera is at bytes 8/12 and the previous camera at bytes 0/4.
 assert(at(block,0)==12&&at(block,4)==0&&at(block,8)==10&&at(block,12)==0);
 assert(word(block,32)==(anr::FrameNoMatrix|anr::FrameReversedDepth|anr::FrameInfiniteDepth|anr::FrameHistory));
 assert(word(block,36)==1920&&word(block,40)==1080&&word(block,44)==1920&&word(block,48)==1080);
 for(float z:{10.f,37.5f,1000.f,1.e5f,7.5e6f,1.e8f})assert(close(programDepth(block,10/z),z));
 assert(programDepth(block,0)==10*1e8f);
 // An unbounded far plane is the same limit; finite far with infinite depth contradicts it.
 assert(!anr::cameraReason(camera(10,inf,RS_TEMPORAL_DEPTH_REVERSED)));
 assert(anr::frameCamera(camera(10,inf,0)).infinite&&anr::frameCamera(camera(10,inf,0)).farPlane==0);
 assert(!anr::cameraReason(camera(10,inf,RS_TEMPORAL_DEPTH_INFINITE)));
 assert(anr::cameraReason(camera(10,75000,RS_TEMPORAL_DEPTH_INFINITE)));
 // Conventional infinite depth: d = 1 - near/z.
 current=anr::frameCamera(camera(.1f,0,RS_TEMPORAL_DEPTH_INFINITE));anr::frameConstants(block,current,current,1,1,0,0,false,1920,1080);
 assert(word(block,32)==(anr::FrameNoMatrix|anr::FrameInfiniteDepth));
 // The stored depth already rounds 1 - near/z, so the exact value is near / (1 - stored depth).
 for(float z:{.5f,4.f,90.f}){const float d=1-.1f/z;assert(close(programDepth(block,d),float(.1/(1.0-double(d)))));}
 // Finite planes: the current frame's planes linearize its depth.
 auto finite=camera(.24f,15000,RS_TEMPORAL_DEPTH_REVERSED);assert(!anr::cameraReason(finite));
 current=anr::frameCamera(finite);previous=anr::frameCamera(camera(.5f,8000,RS_TEMPORAL_DEPTH_REVERSED));assert(!current.infinite&&current.farPlane==15000);
 anr::frameConstants(block,current,previous,1,1,0,0,true,2560,1440);
 assert(at(block,0)==.5f&&at(block,4)==8000&&at(block,8)==.24f&&at(block,12)==15000);
 assert(word(block,32)==(anr::FrameNoMatrix|anr::FrameReversedDepth|anr::FrameHistory));
 for(float z:{.24f,3.f,800.f,15000.f}){const float d=.24f*(15000-z)/(z*(15000-.24f));assert(close(programDepth(block,d),z));}
 // Undeclared or contradictory planes are never filled in.
 assert(anr::cameraReason(camera(0,0,RS_TEMPORAL_DEPTH_INFINITE)));assert(anr::cameraReason(camera(inf,0,RS_TEMPORAL_DEPTH_INFINITE)));
 assert(anr::cameraReason(camera(10,10,0)));assert(anr::cameraReason(camera(10,0,0)));assert(anr::cameraReason(camera(10,-inf,0)));
 assert(anr::cameraReason(camera(10,std::nanf(""),0)));
 auto undeclared=camera(10,0,RS_TEMPORAL_DEPTH_INFINITE);undeclared.flags&=~RS_TEMPORAL_CAMERA_VALID;assert(anr::cameraReason(undeclared));
 std::puts("anr-frame-constants: pass");
}
