// Copyright (c) MacLauncher contributors. MIT license.
// The HUD difference decorator around a scene generation provider. A frame the
// difference does not apply to still generates from its final image.
#include "hud-difference.hpp"
#include "runtime-status.hpp"
#include <cstdio>
#include <stdexcept>
namespace macfx {
// The pieces of the core the decorator links against, outside this check.
SceneAovLease::~SceneAovLease()=default;
void observeRuntimeStatus(const RuntimeStatusEvent&)noexcept{}
GenerationResult GenerationEncoder::encodeInterval(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>,const std::vector<id<MTLTexture>>&,uint64_t,const InterpolationPlan&){GenerationResult result;result.encoded=true;result.reason="interval";return result;}
}
using namespace macfx;
static void require(bool yes,const char*why){if(!yes)throw std::runtime_error(why);}
struct Provider final:GenerationEncoder {
 bool mapped=false;unsigned encodes=0,intervals=0;id<MTLTexture>source=nil;
 const char*method()const noexcept override{return "anr";}
 bool requiresScene()const noexcept override{return true;}
 bool outputDisplayMapped(bool input)const noexcept override{return mapped||input;}
 GenerationResult encode(id<MTLCommandBuffer>,id<MTLTexture>s,const std::vector<id<MTLTexture>>&,uint64_t,const InterpolationPlan&)override{++encodes;source=s;GenerationResult r;r.encoded=r.ready=true;r.generated=1;return r;}
 GenerationResult encodeInterval(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>s,const std::vector<id<MTLTexture>>&,uint64_t,const InterpolationPlan&)override{++intervals;source=s;GenerationResult r;r.encoded=true;return r;}
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
};
static id<MTLTexture>image(id<MTLDevice>device,MTLPixelFormat format){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:64 height:32 mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;return [device newTextureWithDescriptor:d];}
int main(){@autoreleasepool{try{
 auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal device unavailable");auto queue=[device newCommandQueue];
 const auto queueForWarm=dispatch_queue_create("hud-difference-check",DISPATCH_QUEUE_SERIAL);
 auto finalColor=image(device,MTLPixelFormatBGRA8Unorm),out=image(device,MTLPixelFormatBGRA8Unorm);
 RSTemporalFrame scene{};scene.frameId=7;InterpolationPlan plan{};unsigned checks=0;
 // Deep Rock Galactic's late scene: a 10-bit HUD-less image with no UI image.
 // The difference cannot apply to it, so the frame binds and generates as usual.
 const auto hudlessOnly=[&]{auto lease=std::make_shared<SceneAovLease>();auto hudless=image(device,MTLPixelFormatRGB10A2Unorm);
  lease->value.frameId=7;lease->value.images[RS_SCENE_AOV_HUDLESS_COLOR].texture=(__bridge void*)hudless;lease->textures[RS_SCENE_AOV_HUDLESS_COLOR]=hudless;return std::shared_ptr<const SceneAovLease>(lease);};
 {
  auto provider=std::make_shared<Provider>();auto encoder=makeHudDifferenceGenerationEncoder(device,provider,1,queueForWarm);
  auto commands=[queue commandBuffer];const auto bound=bindHudDifference(encoder,commands,finalColor,hudlessOnly(),scene,FrameOrigin::TopLeft);
  require(bound.encoded,"A HUD-less-only frame the difference cannot apply to refused generation");++checks;
  encoder->setScene(scene);const auto result=encoder->encodeColorTimed(commands,finalColor,{out},1,plan,false,false);
  require(result.encoded&&provider->encodes==1&&provider->source==finalColor,"The provider did not generate from the final image");++checks;
 }
 {
  // A provider whose output is display-mapped: no difference, generation continues.
  auto provider=std::make_shared<Provider>();provider->mapped=true;auto encoder=makeHudDifferenceGenerationEncoder(device,provider,1,queueForWarm);
  auto commands=[queue commandBuffer];require(bindHudDifference(encoder,commands,finalColor,hudlessOnly(),scene,FrameOrigin::TopLeft).encoded,"A display-mapped provider refused generation");++checks;
  require(encoder->encodeColorTimed(commands,finalColor,{out},1,plan,false,false).encoded&&provider->encodes==1,"A display-mapped provider did not generate");++checks;
 }
 {
  // No HUD-less image at all: the decorator is transparent, including caller-owned intervals.
  auto provider=std::make_shared<Provider>();auto encoder=makeHudDifferenceGenerationEncoder(device,provider,1,queueForWarm);
  auto commands=[queue commandBuffer];require(bindHudDifference(encoder,commands,finalColor,nullptr,scene,FrameOrigin::TopLeft).encoded,"A frame without a HUD-less image refused generation");++checks;
  require(encoder->encodeInterval(commands,finalColor,finalColor,{out},1,plan).encoded&&provider->intervals==1,"An interval did not reach the provider");++checks;
 }
 std::printf("hud-difference: pass %u\n",checks);return 0;
}catch(const std::exception&error){std::fprintf(stderr,"hud-difference: %s\n",error.what());return 1;}}}
