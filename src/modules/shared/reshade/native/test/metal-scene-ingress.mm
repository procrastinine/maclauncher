// Copyright (c) MacLauncher contributors. MIT license.
// Actual Metal process() with controlled ownership and preparation boundary.
// The real plan contains independent shader/scaler rows. This check isolates
// ingress admission; the controlled executor stops before GPU preparation.
// Pixel fallback remains covered by the separate actual-GPU executor check.
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#define RSMLayerResolution IngressLayerResolution
#define RSMMetal4Bridge IngressMetal4Bridge
#define RSMScheduledEffects IngressScheduledEffects
#define RSMFrameDepth IngressFrameDepth
#define RSMNativeLayer IngressNativeLayer
#define RSMFramebufferAccess IngressFramebufferAccess
#define EffectPlanExecutor IngressPlanExecutor
#define acceptsLayer ingressAcceptsLayer
#define metalPresentation ingressMetalPresentation
#ifndef MACFX_METAL_INGRESS_SOURCE
#define MACFX_METAL_INGRESS_SOURCE <metal.mm>
#endif
#include MACFX_METAL_INGRESS_SOURCE
#include <cassert>
#include <thread>
namespace {
unsigned prepared=0,depthQueries=0;bool requestedDepth=false;id expectedSource;bool expectedOpaque;
}
namespace macfx {
struct IngressPlanExecutor::Impl{};
IngressPlanExecutor::IngressPlanExecutor():impl(std::make_unique<Impl>()){}
IngressPlanExecutor::~IngressPlanExecutor()=default;
void IngressPlanExecutor::setStatusContext(uintptr_t){}
bool IngressPlanExecutor::requiresDepth(){++depthQueries;return requestedDepth;}
bool IngressPlanExecutor::requiresTemporal(){return false;}
std::shared_ptr<const EffectPlanSnapshot> IngressPlanExecutor::snapshot()const{return {};}
EffectExecutionSelection IngressPlanExecutor::prepare(const ShaderFrame &frame,bool,const RSTemporalFrame*){
 assert(frame.source==expectedSource&&frame.target==expectedSource&&frame.source.width==64&&frame.source.height==48);
 assert(frame.origin==FrameOrigin::TopLeft&&frame.opaqueDisplay==expectedOpaque&&!frame.depth);++prepared;
 throw std::runtime_error("Controlled ordered preparation boundary");
}
EffectExecutionSelection IngressPlanExecutor::prepareWithColor(const ShaderFrame&frame,bool p,const RSTemporalFrame*t,ImageColorSpace){return prepare(frame,p,t);}
bool ingressAcceptsLayer(CALayer*){return true;}
std::shared_ptr<ViewPresentation> ingressMetalPresentation(CALayer*){return {};}
}
namespace {id ingressDevice;}
@interface IngressTexture:NSObject
@property NSUInteger width,height;
@property MTLPixelFormat pixelFormat;
@property unsigned marker;
@end
@implementation IngressTexture
- (id<MTLDevice>)device{return ingressDevice;}
- (BOOL)framebufferOnly{return NO;}
- (BOOL)isFramebufferOnly{return NO;}
- (id<MTLTexture>)parentTexture{return nil;}
@end
@interface IngressCommands:NSObject @end
@implementation IngressCommands
- (id<MTLDevice>)device{return ingressDevice;}
@end
@interface IngressLayer:CAMetalLayer @end
@implementation IngressLayer
- (id<MTLDevice>)device{return ingressDevice;}
@end
@interface IngressDrawable:NSObject<CAMetalDrawable>
@property(strong) id<MTLTexture>texture;
@property(strong)CAMetalLayer*layer;
@end
@implementation IngressDrawable
- (void)present{}
- (void)presentAtTime:(CFTimeInterval)t{(void)t;}
- (void)presentAfterMinimumDuration:(CFTimeInterval)t{(void)t;}
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler{(void)handler;}
- (CFTimeInterval)presentedTime{return 0;}
- (NSUInteger)drawableID{return 0;}
@end
int main(int argc,char**argv){@autoreleasepool{
 unsetenv("RESHADE_EXPLICIT_HOST");char scratch[]="/tmp/macfx-metal-ingress-XXXXXX";assert(mkdtemp(scratch));
 NSString*directory=@(scratch),*plan=[directory stringByAppendingPathComponent:@"plan.json"],*controls=[directory stringByAppendingPathComponent:@"controls"];
 setenv("RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation,1);setenv("RESHADE_CONTROL_FILE",controls.fileSystemRepresentation,1);setenv("RESHADE_LIVE_EFFECTS",directory.fileSystemRepresentation,1);
 macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.flags=8;packet.targetHz=60;packet.multiplier=2;packet.sharpness=.5;packet.flowScale=1;
 std::memset(packet.effectKey,'0',64);std::memset(packet.revision,'0',64);assert([[NSData dataWithBytes:&packet length:sizeof(packet)]writeToFile:controls atomically:YES]);
 ingressDevice=[NSObject new];
 const auto exercise=[&](bool depth,bool temporal,bool simple){requestedDepth=depth;
  NSString*identity=[@"" stringByPaddingToLength:64 withString:temporal?@"a":simple?@"c":@"b" startingAtIndex:0];
  NSMutableArray*nodes=[NSMutableArray new];
  if(temporal)[nodes addObject:@{@"id":@"scene",@"kind":@"temporal",@"enabled":@YES,@"method":@"fsr2",@"settings":@{}}];
  if(!simple){[nodes addObject:@{@"id":@"depth",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/controlled/depth.fx",@"key":identity,@"revision":identity,@"requirements":@{@"depth":@(depth)}}];
   [nodes addObject:@{@"id":@"crt",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/controlled/crt.fx",@"key":identity,@"revision":identity}];
   [nodes addObject:@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"bicubic",@"settings":@{}}];}
  NSData*bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"mode":simple?@"simple":@"advanced",@"revision":identity,@"nodes":nodes}options:0 error:nil];assert([bytes writeToFile:plan atomically:YES]);
  std::this_thread::sleep_for(std::chrono::milliseconds(110));assert(macfx::effectPlanMode()==(simple?0:1));
  IngressLayer*layer=[IngressLayer layer];layer.opaque=!depth;expectedOpaque=!depth;
  IngressTexture*texture=[IngressTexture new];texture.width=64;texture.height=48;texture.pixelFormat=MTLPixelFormatBGRA8Unorm;texture.marker=0x12345678;expectedSource=texture;
  IngressDrawable*drawable=[IngressDrawable new];drawable.layer=layer;drawable.texture=(id<MTLTexture>)texture;
  const auto calls=prepared,queries=depthQueries;process((id<MTLCommandBuffer>)[IngressCommands new],drawable);
  assert(prepared==calls+(simple?0:1));assert(depthQueries>queries);assert(texture.marker==0x12345678);
  std::printf("actual Metal ingress %s: ordered prepare delta=%u, exact64x48/top-left/opaque=%d source unchanged; noGPU\n",simple?"Simple missing-depth wait":temporal?"Advanced missing scene":"Advanced missing depth",prepared-calls,int(expectedOpaque));
 };
 const std::string mode=argc>1?argv[1]:"all";assert(argc<=2&&(mode=="all"||mode=="temporal"||mode=="depth"));
 if(mode=="all"||mode=="temporal")exercise(false,true,false);
 if(mode=="all"||mode=="depth")exercise(true,false,false);
 if(mode=="all")exercise(true,false,true);
 assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
}}
