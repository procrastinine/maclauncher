// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-provider.hpp"
#include "generation-budget.hpp"
#include "image-admission.hpp"
#include "completion.hpp"
#include "xess-node.hpp"
#include "scene-aovs.hpp"
#include "scene-matrices.hpp"
#include "image-color.hpp"
#include "color-conversion.hpp"
#include "temporal-provider.hpp"
#include "metalfx-generation-resources.hpp"
#import <MetalFX/MetalFX.h>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <utility>
namespace macfx {
namespace {
class LosslessGeneration final:public GenerationEncoder {
 struct State {
  id<MTLDevice>device;LsfgConfig config;mutable std::mutex lock;
  std::shared_ptr<LsfgEncoder>encoder;unsigned requestedW=0,requestedH=0,readyW=0,readyH=0;
  bool working=false,failed=false,encoderHDR=false;std::string error;
  // Pressure retries at 250 ms, backing off to one second. Elapsed time
  // never poisons this configuration; only an impossible request fails.
  TransientBound pressure;std::string waiting;std::chrono::steady_clock::time_point retryAt{};
  bool waits()const{return !working&&!waiting.empty()&&std::chrono::steady_clock::now()<retryAt;}
  State(id<MTLDevice>d,const LsfgConfig&c):device(d),config(c){}
 };
 std::shared_ptr<State>state;
 static dispatch_queue_t preparationQueue(){static dispatch_queue_t value=dispatch_queue_create("org.maclauncher.graphics.lsfg.prepare",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));return value;}
 static std::shared_ptr<State>create(id<MTLDevice>device,const LsfgConfig&config){return {new State(device,config),[](State*retired){dispatch_async(preparationQueue(),^{@autoreleasepool{delete retired;}});}};}
 static void start(const std::shared_ptr<State>&state){
  {std::lock_guard guard(state->lock);if(state->working||state->failed)return;state->working=true;}
  const std::weak_ptr<State>weak=state;
  dispatch_async(preparationQueue(),^{auto state=weak.lock();if(!state)return;@autoreleasepool{@try{try{
   std::shared_ptr<LsfgEncoder>encoder;bool encoderHDR=false;{std::lock_guard guard(state->lock);encoder=state->encoder;encoderHDR=state->encoderHDR;}
   for(;;){unsigned width,height;LsfgConfig config;{std::lock_guard guard(state->lock);width=state->requestedW;height=state->requestedH;config=state->config;}
    if(!encoder||encoderHDR!=config.hdr){encoder=std::make_shared<LsfgEncoder>(state->device,config);encoderHDR=config.hdr;}
    if(width&&height){const auto result=encoder->prepare(width,height);if(!result.encoded&&!result.busy)throw std::runtime_error(result.reason);}
    std::shared_ptr<LsfgEncoder>retired;bool current=false;{std::lock_guard guard(state->lock);retired=std::exchange(state->encoder,encoder);state->encoderHDR=encoderHDR;state->readyW=width;state->readyH=height;state->pressure.reset();state->waiting.clear();
     current=width==state->requestedW&&height==state->requestedH&&config.hdr==state->config.hdr;if(current)state->working=false;}
    // Resource destruction remains on this preparation queue and outside the
    // metadata lock used by frame callbacks and live Off/profile changes.
    retired.reset();if(current)return;
   }
  }catch(const TransientBusy&error){std::lock_guard guard(state->lock);state->working=false;
   state->pressure.record();if(error.structurallyImpossible){state->failed=true;state->error=error.what();}
   else{state->waiting=error.what();state->retryAt=std::chrono::steady_clock::now()+std::chrono::milliseconds(state->pressure.exhausted()?1000:250);}}
  catch(const std::exception&error){std::lock_guard guard(state->lock);state->failed=true;state->working=false;state->error=error.what();}}
  @catch(NSException*error){std::lock_guard guard(state->lock);state->failed=true;state->working=false;state->error=error.reason.UTF8String?:"LSFG preparation failed";}}});
 }
public:
 LosslessGeneration(id<MTLDevice>device,const LsfgConfig&value):state(create(device,value)){}
 const char*method()const noexcept override{return "lsfg";}
 void setColorDescription(const ImageColorDescription&description)override{
  if(!description.valid())throw std::runtime_error("LSFG requires valid source color metadata");
  const bool linear=description.transfer==ColorTransfer::Linear;
  if(linear&&(description.primaries!=ColorPrimaries::BT709||description.range!=ColorRange::Full||description.referenceWhite!=80||lsfgHDRAPI()!=1))throw std::runtime_error("High-precision LSFG requires the shared linear BT709/scRGB80 boundary");
  if(!linear&&(description.primaries!=ColorPrimaries::BT709||description.transfer!=ColorTransfer::SRGB||description.range!=ColorRange::Full))throw std::runtime_error("LSFG source encoding requires the shared color adapter");
  std::lock_guard guard(state->lock);state->config.hdr=linear;
 }
 ShaderResult preparationStatus()const override{std::unique_lock guard(state->lock,std::try_to_lock);if(!guard)return {false,"Preparing LSFG",true};if(state->failed)return {false,state->error};if(state->working)return {false,"Preparing LSFG",true};if(state->waits())return {false,state->waiting,true};if(state->encoder&&state->encoderHDR!=state->config.hdr)return {false,"Preparing the LSFG color profile",true};if(state->encoder&&state->readyW&&state->readyH){const auto ready=state->encoder->preparationStatus(state->readyW,state->readyH);return {ready.encoded,ready.reason,ready.busy};}return {true,{}};}
 GenerationResult prepare(id<MTLCommandBuffer>commands,id<MTLTexture>source,const RSTemporalFrame*)override{
  GenerationResult result;
  if(!commands||!source||commands.device!=state->device||source.device!=state->device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||!source.width||!source.height||source.width>16384||source.height>16384){result.reason="LSFG requires unsubmitted retained commands and a matching image";return result;}
  {std::unique_lock guard(state->lock,std::try_to_lock);if(!guard){result.busy=true;result.reason="Preparing LSFG";return result;}if(state->failed){result.reason=state->error;return result;}if(state->waits()){result.busy=true;result.reason=state->waiting;return result;}state->requestedW=unsigned(source.width);state->requestedH=unsigned(source.height);
   if(!state->working&&state->encoder&&state->encoderHDR==state->config.hdr&&state->readyW==source.width&&state->readyH==source.height){const auto ready=state->encoder->preparationStatus(unsigned(source.width),unsigned(source.height));result.encoded=ready.encoded;result.busy=ready.busy;result.reason=ready.reason;if(result.encoded&&!state->encoder->canEncode(commands)){result.encoded=false;result.busy=true;result.reason="The preceding LSFG command is still in flight";}return result;}}
  start(state);result.busy=true;result.reason="Preparing LSFG";return result;
 }
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  auto result=prepare(commands,source,nullptr);if(!result.encoded)return result;std::shared_ptr<LsfgEncoder>encoder;{std::lock_guard guard(state->lock);encoder=state->encoder;}return encoder->encode(commands,source,outputs,sequence,phases);
 }
 // The prepared Graph owns its admitted images through its actual GPU lease.
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
};
enum class InterpolatorUI:unsigned { None,Composited,Separate };
struct InterpolatorState {
 id interpolator=nil;id<MTLTexture>history[2]={nil,nil};__weak id<MTLCommandBuffer>commands=nil;
 unsigned inputW=0,inputH=0,outputW=0,outputH=0;MTLPixelFormat color=MTLPixelFormatInvalid,depth=MTLPixelFormatInvalid,motion=MTLPixelFormatInvalid;
 std::atomic<bool>busy{false},failed{false};uint64_t frame=0;int previousSlot=-1;
 std::vector<uint64_t>contract;InterpolatorUI uiMode=InterpolatorUI::None;bool linked=false,retryLink=false,retryUI=false;id<MTLTexture>distortion=nil,uiPrepared=nil;
 std::shared_ptr<ColorEncoder>uiEncoder;
};
struct InterpolatorPreparation {
 unsigned inputW=0,inputH=0,outputW=0,outputH=0;
 MTLPixelFormat color=MTLPixelFormatInvalid,depth=MTLPixelFormatInvalid,motion=MTLPixelFormatInvalid;
 std::shared_ptr<InterpolatorState>value;std::string error;std::atomic<bool>done{false},cancelled{false};
 std::vector<uint64_t>contract;InterpolatorUI uiMode=InterpolatorUI::None;MTLTextureUsage sourceUsage=0,hudUsage=0;
 std::shared_ptr<const MetalFxScalerFrame>scaler;MetalFxDistortionField distortion;
 bool optionalLink=false,retryLink=false,retryUI=false;
};
struct InterpolatorCompletion {
 std::atomic<bool>armed{false};std::atomic<unsigned>status{0};
};
struct InterpolatorInputs {
 id<MTLTexture>color=nil,ui=nil;
 InterpolatorUI uiMode=InterpolatorUI::None;ImageColorDescription uiColor,outputColor;bool uiFlipY=false;
 std::optional<RSSceneMatrices>matrices;
 std::vector<uint64_t>contract;
 bool perspective=false;RSTemporalFrame frame{};id<MTLTexture>depth=nil,motion=nil;
 std::shared_ptr<const MetalFxScalerFrame>scaler;std::shared_ptr<MetalFxScalerClaim>claim;MetalFxDistortionField distortion;
};
class MetalGeneration final:public GenerationEncoder {
 id<MTLDevice>device;mutable std::mutex mutex;std::shared_ptr<InterpolatorState>state;
 std::shared_ptr<InterpolatorPreparation>preparing;
 RSTemporalFrame scene{};id<MTLTexture>sceneDepth=nil,sceneMotion=nil;__weak id<MTLCommandBuffer>sceneCommands=nil;
 std::shared_ptr<const SceneAovLease>sceneAovs;
 std::shared_ptr<const MetalFxGenerationResources>sceneResources;
 std::optional<RSSceneMatrices>sceneMatrices;
 std::optional<ImageColorDescription>sourceColor;
 FrameOrigin sceneOrigin=FrameOrigin::TopLeft;
 static dispatch_queue_t preparationQueue(){static dispatch_queue_t queue=dispatch_queue_create("org.maclauncher.graphics.metalfx.prepare",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));return queue;}
 static std::shared_ptr<InterpolatorState>createState(){return {new InterpolatorState,[](InterpolatorState*retired){dispatch_async(preparationQueue(),^{@autoreleasepool{delete retired;}});}};}
 std::string inspect(id<MTLCommandBuffer>commands,id<MTLTexture>source,InterpolatorInputs&inputs)const{
  auto actual=scene;auto depth=sceneDepth,motion=sceneMotion;
  const auto sameRGB=[](const ImageColorDescription&a,const ImageColorDescription&b){return a.primaries==b.primaries&&a.transfer==b.transfer&&a.range==b.range&&a.referenceWhite==b.referenceWhite&&a.peakLuminance==b.peakLuminance&&a.blackLuminance==b.blackLuminance&&a.hlgSystemGamma==b.hlgSystemGamma&&a.sceneReferred==b.sceneReferred&&((a.alpha==ColorAlpha::Premultiplied)==(b.alpha==ColorAlpha::Premultiplied));};
  if(sceneResources&&sceneResources->scaler&&sourceColor){auto snapshot=sceneResources->scaler;auto claim=snapshot->claim(scene);
   if(claim&&claim->scaler()&&sameRGB(snapshot->color,*sourceColor)&&snapshot->width==source.width&&snapshot->height==source.height&&!snapshot->x&&!snapshot->y){
    auto frame=snapshot->frame;auto d=(__bridge id<MTLTexture>)frame.depth,m=(__bridge id<MTLTexture>)frame.motion;
    if(d.width==m.width&&d.height==m.height&&!(frame.flags&(RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION))){
     inputs.scaler=snapshot;inputs.claim=std::move(claim);actual=frame;actual.owner=scene.owner;actual.commandBuffer=scene.commandBuffer;actual.flags|=scene.flags&(RS_TEMPORAL_RESET|RS_TEMPORAL_CAMERA_VALID);actual.nearPlane=scene.nearPlane;actual.farPlane=scene.farPlane;actual.verticalFov=scene.verticalFov;actual.frameTimeMs=scene.frameTimeMs;actual.colorX=actual.colorY=actual.outputX=actual.outputY=0;actual.outputWidth=source.width;actual.outputHeight=source.height;depth=d;motion=m;
    }
   }
  }

  if(!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||!source||source.device!=device||commands.device!=device)return "MetalFX interpolation requires unsubmitted retained commands and a readable source";
  if(actual.size<sizeof(scene)||actual.version!=1||!actual.owner||!actual.frameId||sceneCommands!=commands||!depth||!motion||depth.device!=device||motion.device!=device)return "MetalFX interpolation requires matching scene identity, depth and motion data";
  if(actual.commandBufferKind||actual.colorX||actual.colorY)return "MetalFX interpolation requires a complete current color image and classic Metal commands";
  if(actual.flags&(RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION))return "MetalFX interpolation needs normalized input-grid motion without sample jitter";
  for(auto image:{source,depth,motion})if(image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly)return "MetalFX interpolation requires resolved readable 2D scene images";
  const auto region=[](id<MTLTexture>image,unsigned x,unsigned y,unsigned w,unsigned h){return w&&h&&x<=image.width&&y<=image.height&&w<=image.width-x&&h<=image.height-y;};
  if(!region(depth,actual.depthX,actual.depthY,actual.renderWidth,actual.renderHeight)||!region(motion,actual.motionX,actual.motionY,actual.renderWidth,actual.renderHeight)||depth.width!=motion.width||depth.height!=motion.height)return "MetalFX interpolation depth and motion must have matching allocated extents and valid declared regions";
  if(actual.outputWidth!=source.width||actual.outputHeight!=source.height||actual.outputX>=source.width||actual.outputY>=source.height)return "MetalFX interpolation requires the complete current output extent";
  if(!std::isfinite(actual.motionScaleX)||!std::isfinite(actual.motionScaleY)||!std::isfinite(actual.jitterX)||!std::isfinite(actual.jitterY)||!std::isfinite(actual.frameTimeMs)||actual.frameTimeMs<0)return "MetalFX interpolation requires finite actual motion, jitter and frame timing";
  if(@available(macOS 27.0,*)){
   if(sceneMatrices&&sceneMatrices->frameId==actual.frameId&&(sceneMatrices->flags&(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID))==(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID)&&bool(sceneMatrices->flags&(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE))){
    auto value=*sceneMatrices;
    // The shared companion uses row-vector math. Normalize only its declared
    // NDC representation; copying rows into SIMD columns below transposes the
    // mathematical transform without changing handedness/off-center terms.
    if(bool(value.flags&RS_SCENE_PROJECTION_Y_DOWN)!=(sceneOrigin==FrameOrigin::BottomLeft))for(unsigned r=0;r<4;++r)value.projection[r*4+1]=-value.projection[r*4+1];
    if(value.flags&RS_SCENE_CLIP_MINUS_ONE_TO_ONE)for(unsigned r=0;r<4;++r)value.projection[r*4+2]=.5f*(value.projection[r*4+2]+value.projection[r*4+3]);
    bool valid=true;for(float x:value.view)valid&=std::isfinite(x);for(float x:value.projection)valid&=std::isfinite(x);
    simd_float4x4 view,projection;std::memcpy(&view,value.view,sizeof(view));std::memcpy(&projection,value.projection,sizeof(projection));
    for(auto matrix:{simd_inverse(view),simd_inverse(projection)})for(unsigned c=0;c<4;++c)for(unsigned r=0;r<4;++r)valid&=std::isfinite(matrix.columns[c][r]);
    if(valid)inputs.matrices=value;
   }
  }else if(actual.depthX||actual.depthY||actual.motionX||actual.motionY||actual.outputX||actual.outputY||depth.width!=actual.renderWidth||depth.height!=actual.renderHeight)return "MetalFX interpolation content regions require macOS 27 or later";
  inputs.perspective=(actual.flags&RS_TEMPORAL_CAMERA_VALID)&&std::isfinite(actual.nearPlane)&&std::isfinite(actual.farPlane)&&std::isfinite(actual.verticalFov)&&actual.nearPlane>0&&actual.farPlane>actual.nearPlane&&actual.verticalFov>0&&actual.verticalFov<3.1415927f;
  if(!inputs.perspective&&!inputs.matrices)return "MetalFX interpolation needs an actual perspective camera or macOS 27 view/projection matrices with a declared depth interval";
  inputs.color=source;
  if(sceneAovs&&sourceColor){
   const auto&packet=sceneAovs->value;const auto&hud=packet.images[RS_SCENE_AOV_HUDLESS_COLOR];const auto&ui=packet.images[RS_SCENE_AOV_UI_COLOR_ALPHA];
   auto hudImage=sceneAovs->textures[RS_SCENE_AOV_HUDLESS_COLOR],uiImage=sceneAovs->textures[RS_SCENE_AOV_UI_COLOR_ALPHA];
   const auto full=[&](const RSSceneAovImage&area,id<MTLTexture>image){return image&&image.device==device&&image.pixelFormat==source.pixelFormat&&image.width==source.width&&image.height==source.height&&!area.x&&!area.y&&area.width==source.width&&area.height==source.height&&area.origin==unsigned(sceneOrigin)&&area.encoding==RS_SCENE_AOV_COLOR;};
   const auto sameColor=[&](const RSImageColorDescription&description){try{const auto c=readImageColor(description);const auto&s=*sourceColor;return c.primaries==s.primaries&&c.transfer==s.transfer&&c.range==s.range&&c.alpha==s.alpha&&c.referenceWhite==s.referenceWhite&&c.peakLuminance==s.peakLuminance&&c.blackLuminance==s.blackLuminance&&c.hlgSystemGamma==s.hlgSystemGamma&&c.sceneReferred==s.sceneReferred;}catch(...){return false;}};
   // Separation is optional and tied to this exact complete composed image.
   // A separate overlay keeps its declared color/alpha convention until the
   // prepared GPU conversion below. Unsupported atlas or ordering contracts
   // retain the complete composited-UI route rather than dropping the UI.
   if(sceneAovs->composedRegionKnown&&sceneAovs->composedColor==source&&!sceneAovs->composedX&&!sceneAovs->composedY&&sceneAovs->composedWidth==source.width&&sceneAovs->composedHeight==source.height&&packet.frameId==actual.frameId&&full(hud,hudImage)&&uiImage&&ui.texture&&sameColor(packet.hudlessColor)) {
    inputs.color=hudImage;inputs.ui=source;inputs.uiMode=InterpolatorUI::Composited;
    if(!ui.x&&!ui.y&&ui.width==source.width&&ui.height==source.height&&uiImage.width==source.width&&uiImage.height==source.height&&uiImage.device==device&&uiImage.storageMode!=MTLStorageModeMemoryless&&uiImage.hazardTrackingMode!=MTLHazardTrackingModeUntracked&&(uiImage.usage&MTLTextureUsageShaderRead)){
     try {inputs.uiColor=readImageColor(packet.uiColor);inputs.outputColor=*sourceColor;inputs.outputColor.alpha=ColorAlpha::Premultiplied;inputs.ui=uiImage;inputs.uiMode=InterpolatorUI::Separate;inputs.uiFlipY=ui.origin!=unsigned(sceneOrigin);}catch(...){}
    }
   }
  }
  inputs.frame=actual;inputs.depth=depth;inputs.motion=motion;
  if(@available(macOS 27.0,*))if(sceneResources&&sceneResources->distortion.texture&&sceneResources->distortion.texture.width==source.width&&sceneResources->distortion.texture.height==source.height)inputs.distortion=sceneResources->distortion;
  auto&key=inputs.contract;key={uint64_t(reinterpret_cast<uintptr_t>((__bridge void*)commands.commandQueue)),depth.width,depth.height,actual.renderWidth,actual.renderHeight,source.width,source.height,uint64_t(source.pixelFormat),uint64_t(depth.pixelFormat),uint64_t(motion.pixelFormat),actual.depthX,actual.depthY,actual.motionX,actual.motionY,actual.outputX,actual.outputY,uint64_t(bool(inputs.matrices)),uint64_t(inputs.perspective),uint64_t(inputs.uiMode),uint64_t(sceneOrigin),actual.flags&uint32_t(RS_TEMPORAL_DEPTH_REVERSED),sceneAovs?sceneAovs->value.epoch:0,sceneAovs?sceneAovs->value.imageRevision:0,inputs.matrices?inputs.matrices->flags:0,source.usage,inputs.color.usage,uint64_t(inputs.ui.pixelFormat),inputs.ui.usage,uint64_t(inputs.uiFlipY)};
  key.insert(key.end(),{uint64_t(reinterpret_cast<uintptr_t>((__bridge void*)(inputs.claim?inputs.claim->scaler():nil))),inputs.scaler?inputs.scaler->resourceId:0,inputs.scaler?unsigned(inputs.scaler->profile):0,uint64_t(inputs.distortion.texture.pixelFormat),inputs.distortion.texture.width,inputs.distortion.texture.height,inputs.distortion.x,inputs.distortion.y,inputs.distortion.width,inputs.distortion.height,uint64_t(inputs.distortion.units)});
  if(sourceColor){const auto&c=*sourceColor;key.insert(key.end(),{uint64_t(c.primaries),uint64_t(c.transfer),uint64_t(c.range),uint64_t(c.alpha),uint64_t(c.sceneReferred)});for(float value:{c.referenceWhite,c.peakLuminance,c.blackLuminance,c.hlgSystemGamma}){uint32_t raw;std::memcpy(&raw,&value,sizeof(raw));key.push_back(raw);}}
  if(inputs.uiMode==InterpolatorUI::Separate){const auto&c=inputs.uiColor;key.insert(key.end(),{uint64_t(c.primaries),uint64_t(c.transfer),uint64_t(c.range),uint64_t(c.alpha),uint64_t(c.sceneReferred)});for(float value:{c.referenceWhite,c.peakLuminance,c.blackLuminance,c.hlgSystemGamma}){uint32_t raw;std::memcpy(&raw,&value,sizeof(raw));key.push_back(raw);}}
  return {};
 }
 bool matching(const std::shared_ptr<InterpolatorState>&value,const InterpolatorInputs&inputs)const{return value&&!value->failed.load()&&value->contract==inputs.contract;}
 bool matching(const std::shared_ptr<InterpolatorPreparation>&value,const InterpolatorInputs&inputs)const{return value&&value->contract==inputs.contract;}
 bool abandoned(id<MTLCommandBuffer>commands)const{
  if(!state||!state->busy.load())return false;
  id<MTLCommandBuffer>previous=state->commands;
  return previous!=commands&&(!previous||previous.status<MTLCommandBufferStatusCommitted);
 }
 GenerationResult ensurePrepared(id<MTLCommandBuffer>commands,id<MTLTexture>source,const InterpolatorInputs&inputs){
  GenerationResult result;
  const bool existing=matching(state,inputs)&&!abandoned(commands);
  if(matching(preparing,inputs)){
   if(!preparing->done.load(std::memory_order_acquire)){if(preparing->optionalLink&&existing){result.encoded=true;return result;}result.busy=true;result.reason="Preparing MetalFX interpolation";return result;}
   if(!preparing->value){if(preparing->optionalLink&&existing){state->retryLink=preparing->retryLink;state->retryUI=preparing->retryUI;preparing.reset();result.encoded=true;return result;}result.reason=preparing->error;return result;}
   auto next=preparing->value;const bool optional=preparing->optionalLink;preparing.reset();
   if(optional&&existing&&(!next->linked||state->linked)&&(next->uiMode!=InterpolatorUI::Separate||state->uiMode==InterpolatorUI::Separate)){state->retryLink=next->retryLink;state->retryUI=next->retryUI;result.encoded=true;return result;}
   state=std::move(next);result.encoded=true;return result;
  }
  if(existing&&!state->retryLink&&!state->retryUI){if(preparing){preparing->cancelled.store(true);preparing.reset();}result.encoded=true;return result;}
  auto request=std::make_shared<InterpolatorPreparation>();
  request->optionalLink=existing&&(state->retryLink&&bool(inputs.scaler)||state->retryUI&&inputs.uiMode==InterpolatorUI::Separate);
  request->retryUI=existing&&state->retryUI;
  request->inputW=unsigned(inputs.depth.width);request->inputH=unsigned(inputs.depth.height);request->outputW=unsigned(source.width);request->outputH=unsigned(source.height);request->contract=inputs.contract;request->uiMode=inputs.uiMode;
  request->color=source.pixelFormat;request->depth=inputs.depth.pixelFormat;request->motion=inputs.motion.pixelFormat;
  request->scaler=inputs.scaler;request->distortion=inputs.distortion;
  request->sourceUsage=inputs.ui.usage;request->hudUsage=inputs.color.usage;
  if(preparing)preparing->cancelled.store(true);preparing=request;id<MTLDevice>gpu=device;
  dispatch_async(preparationQueue(),^{@autoreleasepool{@try{try{
   if(request->cancelled.load())return;
   if(@available(macOS 26.0,*)){
    auto next=createState();auto descriptor=[MTLFXFrameInterpolatorDescriptor new];
    descriptor.inputWidth=request->inputW;descriptor.inputHeight=request->inputH;descriptor.outputWidth=request->outputW;descriptor.outputHeight=request->outputH;
    descriptor.colorTextureFormat=request->color;descriptor.outputTextureFormat=request->color;descriptor.depthTextureFormat=request->depth;descriptor.motionTextureFormat=request->motion;
    std::shared_ptr<MetalFxScalerClaim>preparingClaim;id linked=nil;
    if(request->scaler){preparingClaim=request->scaler->claimForPreparation();if(preparingClaim)linked=preparingClaim->scaler();}
    request->retryLink=bool(request->scaler)&&!linked;
    if(request->optionalLink&&request->retryLink){request->done.store(true,std::memory_order_release);return;}
    descriptor.scaler=linked;
    if(request->uiMode!=InterpolatorUI::None)descriptor.uiTextureFormat=request->color;
    // Completion-owned external snapshots remain authoritative even on SDKs
    // that can manage mutable previous-color storage internally.
    bool distortion=false;if(@available(macOS 27.0,*)){descriptor.requiresPrevColorTexture=YES;descriptor.distortionTextureEnabled=bool(request->distortion.texture);distortion=descriptor.distortionTextureEnabled;}
    const auto create=[&]()->id<MTLFXFrameInterpolator>{@try{InternalTemporalScope scope;return [descriptor newFrameInterpolatorWithDevice:gpu];}@catch(NSException*){return nil;}};
    id<MTLFXFrameInterpolator>interpolator=create();
    auto uiMode=request->uiMode;
    if(uiMode!=InterpolatorUI::None&&(!interpolator||(request->hudUsage&interpolator.colorTextureUsage)!=interpolator.colorTextureUsage||(uiMode==InterpolatorUI::Composited&&(request->sourceUsage&interpolator.uiTextureUsage)!=interpolator.uiTextureUsage))){
     // Optional separation must never prevent the complete composed route.
     descriptor.uiTextureFormat=MTLPixelFormatInvalid;
     interpolator=create();
     uiMode=InterpolatorUI::None;
    }
    if(!interpolator&&distortion){if(@available(macOS 27.0,*))descriptor.distortionTextureEnabled=NO;distortion=false;interpolator=create();}
    if(!interpolator&&linked){descriptor.scaler=nil;linked=nil;interpolator=create();}
    if(!interpolator)throw std::runtime_error("MetalFX could not create an interpolator for these image contracts");
    next->uiMode=uiMode;next->linked=linked!=nil;next->retryLink=request->retryLink;
    next->interpolator=interpolator;if(request->cancelled.load())return;
    auto image=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:request->color width:request->outputW height:request->outputH mipmapped:NO];
    image.storageMode=MTLStorageModePrivate;image.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|interpolator.colorTextureUsage;
    for(auto&slot:next->history){slot=newAdmittedTexture(gpu,image,0,"MetalFX interpolation history");if(!slot)throw std::runtime_error("MetalFX could not prepare source history");}
    if(uiMode==InterpolatorUI::Separate){try{auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:request->color width:request->outputW height:request->outputH mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead|interpolator.uiTextureUsage;next->uiPrepared=newAdmittedTexture(gpu,d,0,"MetalFX separate UI normalization");next->uiEncoder=std::make_shared<ColorEncoder>(gpu);auto ready=next->uiEncoder->prepare(request->color);if(!next->uiPrepared||!ready.encoded)throw std::runtime_error("Separate UI conversion unavailable");request->retryUI=false;}catch(...){next->uiPrepared=nil;next->uiEncoder.reset();next->uiMode=InterpolatorUI::None;next->retryUI=request->retryUI=true;}}
    if(distortion){auto field=request->distortion.texture;auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:field.pixelFormat width:field.width height:field.height mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.hazardTrackingMode=MTLHazardTrackingModeTracked;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;next->distortion=newAdmittedTexture(gpu,d,0,"MetalFX interpolation distortion snapshot");if(!next->distortion)throw std::runtime_error("MetalFX could not prepare distortion storage");}
    next->inputW=request->inputW;next->inputH=request->inputH;next->outputW=request->outputW;next->outputH=request->outputH;
    next->color=request->color;next->depth=request->depth;next->motion=request->motion;next->contract=request->contract;request->value=std::move(next);
   }else request->error="MetalFX interpolation requires macOS 26 or later";
  }catch(const std::exception&error){request->error=error.what();}}
  @catch(NSException*error){request->error=error.reason.UTF8String?:"MetalFX interpolation preparation failed";}
  request->done.store(true,std::memory_order_release);
  }});
  result.encoded=request->optionalLink;result.busy=!request->optionalLink;if(result.busy)result.reason="Preparing MetalFX interpolation";return result;
 }
public:
 MetalGeneration(id<MTLDevice>value,const LsfgConfig&config):device(value){
  if(config.multiplier!=2)throw std::runtime_error("MetalFX interpolation produces one midpoint between real frames");
  if(!metalFXGenerationAvailable(device))throw std::runtime_error("MetalFX interpolation is unavailable on this device or macOS version");
 }
 ~MetalGeneration(){if(preparing)preparing->cancelled.store(true);}
 const char*method()const noexcept override{return "metalfx";}
 bool requiresScene()const noexcept override{return true;}
 ShaderResult preparationStatus()const override{
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock())return {false,"Preparing MetalFX interpolation",true};
  if(preparing){if(!preparing->done.load(std::memory_order_acquire))return {false,"Preparing MetalFX interpolation",true};if(!preparing->value)return {false,preparing->error};return {true,{}};}
  // A failed prior command is retried from the next exact scene frame, where
  // its real image contract is available. Status alone must not start GPU work.
  return {true,{}};
 }
 void setColorDescription(const ImageColorDescription&value)override{if(!value.valid())throw std::runtime_error("MetalFX interpolation requires valid source color metadata");std::lock_guard lock(mutex);sourceColor=value;}
 void setScene(const RSTemporalFrame&frame)override{std::lock_guard lock(mutex);scene=frame;sceneDepth=(__bridge id<MTLTexture>)frame.depth;sceneMotion=(__bridge id<MTLTexture>)frame.motion;sceneCommands=(__bridge id<MTLCommandBuffer>)frame.commandBuffer;sceneAovs=temporalSceneAovs(frame);sceneMatrices=temporalSceneMatrices(frame);sceneResources=metalFxGenerationResources(frame);}
 void setSceneOrigin(FrameOrigin value)override{std::lock_guard lock(mutex);sceneOrigin=value;}
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{
  // Owned source history is allocated through newAdmittedTexture. MetalFX's
  // opaque internal resources remain covered by actual device-headroom checks.
  return 0;
 }
 GenerationResult prepare(id<MTLCommandBuffer>commands,id<MTLTexture>source,const RSTemporalFrame*frame)override{
  if(frame)setScene(*frame);GenerationResult result;std::unique_lock lock(mutex,std::try_to_lock);
  if(!lock.owns_lock()){result.busy=true;result.reason="MetalFX interpolation metadata is occupied";return result;}
  InterpolatorInputs inputs;if(auto reason=inspect(commands,source,inputs);!reason.empty()){result.reason=reason;return result;}
  return ensurePrepared(commands,source,inputs);
 }
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  GenerationResult result;result.frameId=sequence;
  const auto reject=[&](const char*reason){result.reason=reason;return result;};
  if(phases.count>1||outputs.size()!=phases.count||phases.count&&std::abs(phases.timestamps[0]-.5f)>.00001f)return reject("MetalFX interpolation supports the midpoint phase only");
  std::unique_lock lock(mutex,std::try_to_lock);if(!lock.owns_lock()){result.busy=true;return reject("MetalFX interpolation metadata is occupied");}
  InterpolatorInputs inputs;if(auto reason=inspect(commands,source,inputs);!reason.empty()){result.reason=reason;return result;}
  result=ensurePrepared(commands,source,inputs);result.frameId=sequence;if(!result.encoded)return result;result.encoded=false;
  if(state->busy.load()){result.busy=true;return reject("The preceding MetalFX interpolation is still in flight");}
  if(state->failed.load()){result=ensurePrepared(commands,source,inputs);result.frameId=sequence;return result;}
  if(@available(macOS 26.0,*)){
   const auto actual=inputs.frame;
   auto current=state;id<MTLFXFrameInterpolator>interpolator=current->interpolator;
   if(current->uiMode==InterpolatorUI::None){inputs.color=source;inputs.ui=nil;}
   if((inputs.color.usage&interpolator.colorTextureUsage)!=interpolator.colorTextureUsage||(inputs.depth.usage&interpolator.depthTextureUsage)!=interpolator.depthTextureUsage||(inputs.motion.usage&interpolator.motionTextureUsage)!=interpolator.motionTextureUsage||current->uiMode==InterpolatorUI::Composited&&inputs.ui&&(inputs.ui.usage&interpolator.uiTextureUsage)!=interpolator.uiTextureUsage)return reject("Scene textures do not satisfy MetalFX interpolation usage requirements");
   for(auto output:outputs)if(!output||output==source||output.device!=device||output.width!=source.width||output.height!=source.height||output.pixelFormat!=source.pixelFormat||output.storageMode!=MTLStorageModePrivate||(output.usage&interpolator.outputTextureUsage)!=interpolator.outputTextureUsage)return reject("MetalFX interpolation output must be a distinct matching private texture");
   const bool reset=current->previousSlot<0||sequence!=current->frame+1||bool(actual.flags&RS_TEMPORAL_RESET);
   const int slot=current->previousSlot<0?0:1-current->previousSlot;
   id<MTLTexture>snapshot=current->history[slot],previous=reset?snapshot:current->history[current->previousSlot];
   auto depth=inputs.depth,motion=inputs.motion,color=inputs.color,ui=inputs.ui;const auto aovs=sceneAovs;auto linkedClaim=current->linked?inputs.claim:nullptr;auto field=current->distortion;auto receipt=std::make_shared<InterpolatorCompletion>();
   current->commands=commands;current->busy.store(true);
   const std::weak_ptr<InterpolatorState>weak=current;auto held=current->linked?std::shared_ptr<InterpolatorState>{}:current;
   auto lease=std::make_shared<CompletionLease>([weak,held,receipt,slot,sequence](bool success){
    const bool accepted=success&&receipt->armed.load();
    if(auto current=held?held:weak.lock()){if(accepted){current->previousSlot=slot;current->frame=sequence;}else current->failed.store(true);current->busy.store(false,std::memory_order_release);}
    receipt->status.store(accepted?1:2);
   });
   id sdkLifetime=current->linked?nil:interpolator;
   [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){(void)source;(void)color;(void)ui;(void)aovs;(void)previous;(void)snapshot;(void)depth;(void)motion;(void)sdkLifetime;(void)field;lease->finish(completed.status==MTLCommandBufferStatusCompleted);if(linkedClaim)linkedClaim->retire();}];
   auto copy=[commands blitCommandEncoder];if(!copy)return reject("Cannot retain the real interpolation frame");
   [copy copyFromTexture:color sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(source.width,source.height,1) toTexture:snapshot destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];if(field){auto input=inputs.distortion.texture;if(inputs.distortion.fence)[copy waitForFence:inputs.distortion.fence];[copy copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(input.width,input.height,1) toTexture:field destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];}[copy endEncoding];
   if(current->uiMode==InterpolatorUI::Separate){ColorConversion conversion;conversion.source=inputs.uiColor;conversion.target=inputs.outputColor;conversion.flipY=inputs.uiFlipY;conversion.frameId=sequence;auto ready=current->uiEncoder->encode(commands,ui,current->uiPrepared,conversion);if(!ready.encoded)return reject(ready.reason.c_str());ui=current->uiPrepared;}
   interpolator.colorTexture=color;interpolator.prevColorTexture=previous;interpolator.depthTexture=inputs.depth;interpolator.motionTexture=inputs.motion;
   interpolator.uiTexture=ui;interpolator.uiTextureComposited=current->uiMode==InterpolatorUI::Composited;
   interpolator.motionVectorScaleX=actual.motionScaleX;interpolator.motionVectorScaleY=actual.motionScaleY;
   interpolator.jitterOffsetX=actual.jitterX;interpolator.jitterOffsetY=actual.jitterY;interpolator.deltaTime=actual.frameTimeMs/1000;
   if(inputs.perspective){interpolator.nearPlane=actual.nearPlane;interpolator.farPlane=actual.farPlane;interpolator.fieldOfView=actual.verticalFov*180/3.14159265358979323846;}
   interpolator.aspectRatio=float(source.width)/source.height;interpolator.depthReversed=bool(actual.flags&RS_TEMPORAL_DEPTH_REVERSED);interpolator.shouldResetHistory=reset;
   if(@available(macOS 27.0,*)){
    interpolator.distortionTexture=field;interpolator.distortionOffsetX=field?inputs.distortion.x:0;interpolator.distortionOffsetY=field?inputs.distortion.y:0;interpolator.distortionWidth=field?inputs.distortion.width:0;interpolator.distortionHeight=field?inputs.distortion.height:0;
    interpolator.contentWidth=actual.renderWidth;interpolator.contentHeight=actual.renderHeight;
    interpolator.depthContentOffsetX=actual.depthX;interpolator.depthContentOffsetY=actual.depthY;interpolator.motionContentOffsetX=actual.motionX;interpolator.motionContentOffsetY=actual.motionY;interpolator.outputOffsetX=actual.outputX;interpolator.outputOffsetY=actual.outputY;
    if(inputs.matrices){simd_float4x4 view,projection;std::memcpy(&view,inputs.matrices->view,sizeof(view));std::memcpy(&projection,inputs.matrices->projection,sizeof(projection));interpolator.worldToViewMatrix=view;interpolator.viewToClipMatrix=projection;}
   }
   for(auto output:outputs){interpolator.outputTexture=output;InternalTemporalScope scope;[interpolator encodeToCommandBuffer:commands];}
   receipt->armed.store(true);
   result.completion=[receipt]()->ShaderResult{const auto status=receipt->status.load();if(status==1)return {true,{}};if(status==2)return {false,"MetalFX interpolation commands failed or were abandoned"};return {false,"MetalFX interpolation is still in flight",true};};
   sceneCommands=nil;sceneDepth=nil;sceneMotion=nil;sceneAovs.reset();sceneMatrices.reset();sceneResources.reset();result.encoded=true;result.ready=!reset;result.generated=result.ready?outputs.size():0;result.historyFrames=reset?1:2;if(reset)result.reason="MetalFX interpolation history is warming";return result;
  }
  return reject("MetalFX interpolation requires macOS 26 or later");
 }
};
}
bool metalFXGenerationAvailable(id<MTLDevice>device)noexcept{@try{if(@available(macOS 26.0,*))return device&&[MTLFXFrameInterpolatorDescriptor supportsDevice:device];}@catch(NSException*){}return false;}
std::shared_ptr<GenerationEncoder>makeGenerationEncoder(id<MTLDevice>device,const std::string&method,const LsfgConfig&config){
 if(method=="lsfg")return std::make_shared<LosslessGeneration>(device,config);
 if(method=="metalfx")return std::make_shared<MetalGeneration>(device,config);
 if(method=="xess")return makeXessGenerationEncoder(device,config);
 if(method=="mlx-interpolation")return makeNeuralGenerationEncoder(device,config);
 if(method=="rife")return makeRifeGenerationEncoder(device,config);
 if(method=="fsr3")return makeFSR3GenerationEncoder(device,config);
 throw std::runtime_error("Unknown frame-generation provider");
}
}
