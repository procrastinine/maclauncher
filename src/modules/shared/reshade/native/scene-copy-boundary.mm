// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-copy-boundary.hpp"
#include "scene-aovs.hpp"
#include "scene-destination.hpp"
#include "scene-matrices.hpp"
#include "effects-execution.hpp"
#include "image-color.hpp"
#include "color-island.hpp"
#import <QuartzCore/QuartzCore.h>
#include "metal-library-cache.hpp"
#include "log.hpp"
#include "hook-originals.hpp"
#import <objc/runtime.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <mutex>
#include <unordered_map>
namespace {
struct Owner {std::mutex mutex;macfx::EffectPlanState source;macfx::EffectPlanExecutor executor;__weak id<MTLCommandBuffer>previous;};
struct Boundary {RSTemporalFrame frame{};RSSceneMatrices matrices{};std::shared_ptr<macfx::SceneAovLease>aovs;std::shared_ptr<Owner>state;std::shared_ptr<const macfx::SceneWindowAuthority>window;std::array<id<MTLTexture>,8>textures{};std::atomic<bool>cancelled{false};};
std::mutex registryMutex;std::array<std::shared_ptr<Boundary>,64>registry;std::unordered_map<void*,std::shared_ptr<Owner>>owners;std::atomic<unsigned>pending{0};
void recount(){unsigned count=0;for(const auto&entry:registry)count+=entry&&!entry->cancelled.load();pending.store(count,std::memory_order_release);}
bool texture(id<MTLTexture>t,id<MTLDevice>d){return t&&t.device==d&&t.textureType==MTLTextureType2D&&t.sampleCount==1&&!t.framebufferOnly;}
void consume(const std::shared_ptr<Boundary>&boundary,id<MTLCommandBuffer>commands){@autoreleasepool{@try{try{
 if(!boundary||boundary->cancelled.load()||!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)return;
 auto state=boundary->state;std::unique_lock serial(state->mutex,std::try_to_lock);if(!serial.owns_lock())return;
 auto previous=state->previous;if(previous&&previous!=commands&&previous.status<MTLCommandBufferStatusCommitted)return;
 auto frame=boundary->frame;frame.commandBuffer=(__bridge void*)commands;
 if(commands.device!=boundary->textures[0].device)return;
 if(rsBindTemporalSceneMatrices(&frame,&boundary->matrices)!=RS_TEMPORAL_OK||macfx::bindSceneAovLease(frame,boundary->aovs)!=RS_TEMPORAL_OK)return;
 state->source.poll();const auto snapshot=state->source.snapshot();if(!snapshot||snapshot->mode!="advanced")return;
 size_t cut=0;for(size_t i=0;i<snapshot->nodes.size();++i){const auto&node=snapshot->nodes[i];if(!node.enabled)continue;if(node.kind=="temporal"||node.kind=="frame-generation")break;if(node.requirements.sceneAovs||node.requirements.noisyColor)cut=i+1;}
 if(!cut)return;
 const auto color=macfx::readImageColor(boundary->aovs->value.color);
 macfx::DepthFrame depth{(__bridge id<MTLTexture>)frame.depth,frame.frameId,macfx::FrameOrigin::TopLeft};
 macfx::ShaderFrame image{commands,(__bridge id<MTLTexture>)frame.color,(__bridge id<MTLTexture>)frame.output,frame.frameId,CACurrentMediaTime()*1000,frame.frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::spatialColorForDescription(color),depth.texture?&depth:nullptr,color.alpha==macfx::ColorAlpha::Opaque};
 const auto selected=state->executor.prepareSceneBoundary(image,frame,color,snapshot,cut);
 if(selected.holdPrevious||!selected.execution)return;
 bool mapped=false;const auto encoded=selected.execution->encodeSceneBoundary(image,frame,&mapped);if(!encoded.encoded)return;
 state->previous=commands;
 if(boundary->cancelled.load())return;
 if(boundary->window){macfx::TemporalSceneDestination destination;destination.window=boundary->window;destination.owner=frame.owner;destination.frameId=frame.frameId;destination.flags=frame.flags&RS_TEMPORAL_HDR;macfx::publishTemporalSceneContinuation(commands,destination,frame,selected.execution,mapped);}
 }catch(const std::exception&error){macfx::nativeLog(std::string("Optional renderer copy boundary: ")+error.what());}}@catch(NSException*error){macfx::nativeLog(std::string("Optional renderer copy boundary: ")+(error.reason.UTF8String?:"Metal rejected the scene prefix"));}}}
std::shared_ptr<Boundary>take(id<MTLCommandBuffer>commands,id<MTLTexture>source,NSUInteger sourceSlice,NSUInteger sourceLevel,MTLOrigin origin,MTLSize size,id<MTLTexture>target,NSUInteger targetSlice,NSUInteger targetLevel,MTLOrigin output){
 if(!pending.load(std::memory_order_acquire)||!commands||sourceSlice||sourceLevel||targetSlice||targetLevel||origin.z||output.z||size.depth!=1)return {};
 std::lock_guard guard(registryMutex);for(auto&entry:registry)if(entry&&!entry->cancelled.load()){const auto&f=entry->frame;
  if(f.color==(__bridge void*)source&&f.output==(__bridge void*)target&&f.colorX==origin.x&&f.colorY==origin.y&&f.outputX==output.x&&f.outputY==output.y&&f.renderWidth==size.width&&f.renderHeight==size.height&&commands.device==source.device){auto result=std::move(entry);recount();return result;}}
 return {};
}
macfx::HookOriginals&hooks(){static auto*value=new macfx::HookOriginals;return*value;}
IMP original(id object,SEL selector){return hooks().original(object,selector);}
void replace(Class cls,SEL selector,IMP replacement){hooks().replace(cls,selector,replacement);}
const char encoderKey=0;
}
@interface RSMSceneCopyEncoder : NSObject {@public __weak id<MTLCommandBuffer>commands;std::vector<std::shared_ptr<Boundary>>boundaries;}
@end
@implementation RSMSceneCopyEncoder
@end
namespace {
void copyTexture(id object,SEL selector,id<MTLTexture>source,NSUInteger sourceSlice,NSUInteger sourceLevel,MTLOrigin origin,MTLSize size,id<MTLTexture>target,NSUInteger targetSlice,NSUInteger targetLevel,MTLOrigin output){
 auto method=reinterpret_cast<void(*)(id,SEL,id<MTLTexture>,NSUInteger,NSUInteger,MTLOrigin,MTLSize,id<MTLTexture>,NSUInteger,NSUInteger,MTLOrigin)>(original(object,selector));method(object,selector,source,sourceSlice,sourceLevel,origin,size,target,targetSlice,targetLevel,output);
 if(!pending.load(std::memory_order_acquire))return;RSMSceneCopyEncoder*context=objc_getAssociatedObject(object,&encoderKey);if(context)if(auto boundary=take(context->commands,source,sourceSlice,sourceLevel,origin,size,target,targetSlice,targetLevel,output))context->boundaries.push_back(std::move(boundary));
}
void endEncoder(id object,SEL selector){auto method=reinterpret_cast<void(*)(id,SEL)>(original(object,selector));method(object,selector);RSMSceneCopyEncoder*context=objc_getAssociatedObject(object,&encoderKey);if(!context)return;objc_setAssociatedObject(object,&encoderKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);auto commands=context->commands;for(const auto&boundary:context->boundaries)consume(boundary,commands);}
void attach(id<MTLCommandBuffer>commands,id<MTLBlitCommandEncoder>encoder){if(!encoder||!pending.load(std::memory_order_acquire))return;auto context=[RSMSceneCopyEncoder new];context->commands=commands;objc_setAssociatedObject(encoder,&encoderKey,context,OBJC_ASSOCIATION_RETAIN_NONATOMIC);const auto cls=object_getClass(encoder);replace(cls,@selector(copyFromTexture:sourceSlice:sourceLevel:sourceOrigin:sourceSize:toTexture:destinationSlice:destinationLevel:destinationOrigin:),reinterpret_cast<IMP>(copyTexture));replace(cls,@selector(endEncoding),reinterpret_cast<IMP>(endEncoder));}
id<MTLBlitCommandEncoder>blit(id object,SEL selector){auto encoder=reinterpret_cast<id<MTLBlitCommandEncoder>(*)(id,SEL)>(original(object,selector))(object,selector);attach(object,encoder);return encoder;}
id<MTLBlitCommandEncoder>blitDescriptor(id object,SEL selector,MTLBlitPassDescriptor*descriptor){auto encoder=reinterpret_cast<id<MTLBlitCommandEncoder>(*)(id,SEL,MTLBlitPassDescriptor*)>(original(object,selector))(object,selector,descriptor);attach(object,encoder);return encoder;}
}
extern "C" uint32_t rsSceneCopyBoundaryAPI(void){return 1;}
extern "C" void rsClearTemporalSceneCopyBoundaries(void*owner){if(!owner)return;std::shared_ptr<Owner>retired;{std::lock_guard guard(registryMutex);for(auto&entry:registry)if(entry&&entry->frame.owner==owner){entry->cancelled=true;entry.reset();}auto i=owners.find(owner);if(i!=owners.end()){retired=std::move(i->second);owners.erase(i);}recount();}macfx::releaseTemporalSceneContinuations(owner);if(retired)dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{(void)retired;});}
extern "C" int rsSetTemporalSceneCopyBoundary(void*owner,void*nativeWindow,const RSTemporalFrame*f,const RSSceneMatrices*matrices,const RSSceneAovs*aovs,const RSSceneAovRetirement*observer){try{
 if(!owner||!f||f->size<sizeof(*f)||f->version!=1||f->owner!=owner||f->method!=RS_TEMPORAL_OFF||f->reserved||f->commandBuffer||f->commandBufferKind||!f->frameId||!f->renderWidth||!f->renderHeight||f->renderWidth!=f->outputWidth||f->renderHeight!=f->outputHeight||f->outputX||f->outputY||!std::isfinite(f->frameTimeMs)||f->frameTimeMs<0||!matrices||matrices->size!=sizeof(*matrices)||matrices->version!=1||matrices->frameId!=f->frameId||!aovs||aovs->size!=sizeof(*aovs)||aovs->version!=1||aovs->frameId!=f->frameId||!aovs->colorPass)return RS_TEMPORAL_INVALID;
 if(observer&&(observer->size!=sizeof(*observer)||observer->version!=1||!observer->retired))return RS_TEMPORAL_INVALID;
 auto source=(__bridge id<MTLTexture>)f->color,target=(__bridge id<MTLTexture>)f->output;auto device=source.device;
 if(!texture(source,device)||!texture(target,device)||source==target||source.pixelFormat!=target.pixelFormat||uint64_t(f->colorX)+f->renderWidth>source.width||uint64_t(f->colorY)+f->renderHeight>source.height||target.width!=f->outputWidth||target.height!=f->outputHeight)return RS_TEMPORAL_INVALID;
 for(void*guide:{f->depth,f->motion,f->exposure,f->reactive,f->transparency})if(guide&&!texture((__bridge id<MTLTexture>)guide,device))return RS_TEMPORAL_INVALID;
 auto lease=macfx::captureSceneAovs(*aovs,device);if(!lease)return RS_TEMPORAL_INVALID;
 auto entry=std::make_shared<Boundary>();entry->frame=*f;entry->matrices=*matrices;entry->aovs=std::move(lease);if(nativeWindow){entry->window=macfx::temporalSceneWindow(nativeWindow);if(!entry->window)return RS_TEMPORAL_INVALID;}
 entry->textures={source,target,(__bridge id<MTLTexture>)f->depth,(__bridge id<MTLTexture>)f->motion,(__bridge id<MTLTexture>)f->exposure,(__bridge id<MTLTexture>)f->reactive,(__bridge id<MTLTexture>)f->transparency,nil};
 std::lock_guard guard(registryMutex);std::shared_ptr<Boundary>*free=nullptr;for(auto&value:registry){if(!value){if(!free)free=&value;continue;}if(value->frame.color==f->color&&value->frame.output==f->output){value->cancelled=true;recount();return RS_TEMPORAL_BUSY;}}
 if(!free||(!owners.count(owner)&&owners.size()>=128))return RS_TEMPORAL_BUSY;auto&state=owners[owner];if(!state)state=std::make_shared<Owner>();entry->state=state;if(observer)entry->aovs->retirement=*observer;*free=std::move(entry);recount();return RS_TEMPORAL_OK;
 }catch(...){return RS_TEMPORAL_INVALID;}}
namespace macfx {
void installSceneCopyBoundaryHooks(id<MTLCommandBuffer>commands){if(!commands)return;const auto cls=object_getClass(commands);replace(cls,@selector(blitCommandEncoder),reinterpret_cast<IMP>(blit));replace(cls,@selector(blitCommandEncoderWithDescriptor:),reinterpret_cast<IMP>(blitDescriptor));}
struct SceneBoundaryOutput::Impl {id<MTLDevice>device=nil;id<MTLRenderPipelineState>pipeline=nil;MTLPixelFormat format=MTLPixelFormatInvalid;bool preserveTargetAlpha=false;};
SceneBoundaryOutput::SceneBoundaryOutput():impl(std::make_shared<Impl>()){}
SceneBoundaryOutput::~SceneBoundaryOutput()=default;
ShaderResult SceneBoundaryOutput::prepare(id<MTLDevice>device,MTLPixelFormat format,bool preserveTargetAlpha){try{
 if(impl->device==device&&impl->format==format&&impl->preserveTargetAlpha==preserveTargetAlpha&&impl->pipeline)return {true,{}};
 const std::string source=R"(#include <metal_stdlib>
using namespace metal;
vertex float4 boundaryVertex(uint i[[vertex_id]]){const float2 p[]={float2(-1,-1),float2(3,-1),float2(-1,3)};return float4(p[i],0,1);}
fragment float4 boundaryFragment(float4 p[[position]],texture2d<float,access::read>processed[[texture(0)]],texture2d<float,access::read>original[[texture(1)]],constant uint4&offset[[buffer(0)]]){uint2 xy=uint2(p.xy)-offset.zw;return float4(processed.read(xy).rgb,original.read(xy+offset.xy).a);}
fragment float4 boundaryRGBFragment(float4 p[[position]],texture2d<float,access::read>processed[[texture(0)]],constant uint4&offset[[buffer(0)]]){return float4(processed.read(uint2(p.xy)-offset.zw).rgb,0);}
)";
 NSError*error=nil;auto library=cachedMetalLibrary(device,source,&error);if(!library)return {false,error.localizedDescription.UTF8String?:"Cannot prepare renderer RGB output"};auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"boundaryVertex"];descriptor.fragmentFunction=[library newFunctionWithName:preserveTargetAlpha?@"boundaryRGBFragment":@"boundaryFragment"];descriptor.colorAttachments[0].pixelFormat=format;if(preserveTargetAlpha)descriptor.colorAttachments[0].writeMask=MTLColorWriteMaskRed|MTLColorWriteMaskGreen|MTLColorWriteMaskBlue;auto pipeline=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!pipeline)return {false,error.localizedDescription.UTF8String?:"Cannot prepare renderer output storage"};auto state=std::make_shared<Impl>();state->device=device;state->format=format;state->pipeline=pipeline;state->preserveTargetAlpha=preserveTargetAlpha;impl=std::move(state);return {true,{}};
 }catch(const std::exception&error){return {false,error.what()};}}
ShaderResult SceneBoundaryOutput::encode(id<MTLCommandBuffer>commands,id<MTLTexture>processed,id<MTLTexture>source,id<MTLTexture>target,unsigned x,unsigned y,unsigned targetX,unsigned targetY,unsigned width,unsigned height){
 const auto state=impl;width=width?:unsigned(target.width);height=height?:unsigned(target.height);if(!commands||commands.device!=state->device||!state->pipeline||!processed||!target||target.pixelFormat!=state->format||processed==target||(!state->preserveTargetAlpha&&(!source||source==target||uint64_t(x)+width>source.width||uint64_t(y)+height>source.height))||processed.width!=width||processed.height!=height||uint64_t(targetX)+width>target.width||uint64_t(targetY)+height>target.height)return {false,"The renderer output storage contract changed",true};
 auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=target;pass.colorAttachments[0].loadAction=state->preserveTargetAlpha||targetX||targetY||width!=target.width||height!=target.height?MTLLoadActionLoad:MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)return {false,"Cannot encode the renderer RGB output",true};uint32_t offset[]={x,y,targetX,targetY};[encoder setRenderPipelineState:state->pipeline];[encoder setViewport:MTLViewport{double(targetX),double(targetY),double(width),double(height),0,1}];[encoder setScissorRect:MTLScissorRect{targetX,targetY,width,height}];[encoder setFragmentTexture:processed atIndex:0];if(!state->preserveTargetAlpha)[encoder setFragmentTexture:source atIndex:1];[encoder setFragmentBytes:offset length:sizeof(offset) atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)state;}];return {true,{}};
}
}
