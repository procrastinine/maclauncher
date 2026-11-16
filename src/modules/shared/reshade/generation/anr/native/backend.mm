// Copyright (c) MacLauncher contributors. MIT license.
#include "anr_runtime.h"
#include "submission.h"
#include "frame_constants.hpp"
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "../../../temporal/frame.h"
#endif
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <memory>
#include <stdexcept>
#include <vector>
struct Inputs {uint32_t width,height,rw,rh,dx,dy,mx,my,encoding,bottomLeft,ui,premultiplied,sourceSrgb,outputSrgb;float white;};
struct Prepared {
 std::unique_ptr<anr::Runtime>runtime;id<MTLTexture>color=nil,depth=nil,motion=nil,generated=nil;
 id<MTLComputePipelineState>import=nil,importDepth=nil,exportImage=nil;std::vector<std::shared_ptr<void>>reservations;std::string error;std::atomic<bool>done{false};
};
struct Context {
 RSGenerationOptions options{};id<MTLDevice>device;std::string helpers,root;std::mutex lock;std::shared_ptr<Prepared>prepared;
 unsigned width=0,height=0;bool history=false;uint64_t frame=0,submission=0;void*owner=nullptr;id<MTLCommandQueue>queue=nil;
 __weak id<MTLCommandBuffer>pending=nil;std::shared_ptr<std::atomic<unsigned>>completion;
 uint32_t transfer=~0u,bottomLeft=0;anr::Camera previous{};
};
static int result(RSGenerationResult*r,int code,const std::string&reason){if(r){r->status=code;snprintf(r->reason,sizeof(r->reason),"%s",reason.c_str());}return code;}
static std::string inspect(Context&c,const RSANRSubmission&s){
 const auto&b=s.base;const auto*f=b.scene;auto commands=(__bridge id<MTLCommandBuffer>)b.commandBuffer;auto color=(__bridge id<MTLTexture>)b.color;
 if(b.size<sizeof(s)||b.version!=1||!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||commands.device!=c.device||!color||color.device!=c.device)return "ANR requires unsubmitted retained commands and matching readable color";
 if(!f||f->size<sizeof(*f)||f->version!=1||!f->owner||!f->frameId||f->commandBuffer!=b.commandBuffer||f->commandBufferKind||!f->depth||!f->motion)return "ANR requires matching real scene depth and motion";
 if(const char*camera=anr::cameraReason(*f))return camera;
 if(f->flags&(RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION))return "ANR requires input-grid motion without sample jitter";
 if(!f->renderWidth||!f->renderHeight||f->renderWidth>color.width||f->renderHeight>color.height||f->outputWidth!=color.width||f->outputHeight!=color.height||f->colorX||f->colorY||f->outputX||f->outputY)return "ANR requires complete fixed output geometry";
 if(!((color.width==1920&&color.height==1080)||(color.width==2560&&color.height==1440)||(color.width==3840&&color.height==2160)))return "ANR has prepared graphs only for 1920x1080, 2560x1440 and 3840x2160";
 if(!std::isfinite(f->motionScaleX)||!std::isfinite(f->motionScaleY)||!f->motionScaleX||!f->motionScaleY||!std::isfinite(f->jitterX)||!std::isfinite(f->jitterY)||std::abs(f->jitterX)>.5f||std::abs(f->jitterY)>.5f)return "ANR requires finite motion scales and subpixel jitter";
 auto depth=(__bridge id<MTLTexture>)f->depth,motion=(__bridge id<MTLTexture>)f->motion;
 for(auto image:{color,depth,motion})if(image.device!=c.device||image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly||image.storageMode==MTLStorageModeMemoryless)return "ANR requires resolved readable scene textures on one device";
 if(depth.pixelFormat!=MTLPixelFormatR32Float&&depth.pixelFormat!=MTLPixelFormatDepth32Float)return "ANR requires R32Float or Depth32Float scene depth";
 if(motion.pixelFormat!=MTLPixelFormatRG16Float&&motion.pixelFormat!=MTLPixelFormatRG32Float)return "ANR requires two-channel floating point scene motion";
 if(uint64_t(f->depthX)+f->renderWidth>depth.width||uint64_t(f->depthY)+f->renderHeight>depth.height||uint64_t(f->motionX)+f->renderWidth>motion.width||uint64_t(f->motionY)+f->renderHeight>motion.height)return "ANR scene regions exceed their textures";
 if(b.transferFunction>2||!std::isfinite(s.referenceWhite)||s.referenceWhite<=0)return "ANR requires explicit sRGB, PQ or linear color metadata";
 return {};
}
static int prepare(void*opaque,const RSGenerationSubmission*input,RSGenerationResult*r){try{
 auto&c=*static_cast<Context*>(opaque);if(!input)return result(r,RS_GENERATION_INVALID,"Missing ANR submission");const auto&s=*reinterpret_cast<const RSANRSubmission*>(input);auto reason=inspect(c,s);if(!reason.empty())return result(r,RS_GENERATION_INVALID,reason);
 std::lock_guard guard(c.lock);auto color=(__bridge id<MTLTexture>)input->color;
 if(c.prepared&&c.width==color.width&&c.height==color.height){if(!c.prepared->done)return result(r,RS_GENERATION_BUSY,"Preparing ANR resources");if(!c.prepared->error.empty())return result(r,RS_GENERATION_FAILED,c.prepared->error);return result(r,RS_GENERATION_OK,"");}
 if(c.pending&&c.pending.status<MTLCommandBufferStatusCompleted)return result(r,RS_GENERATION_BUSY,"ANR previous frame is in flight");
 c.width=unsigned(color.width);c.height=unsigned(color.height);c.history=false;c.prepared=std::make_shared<Prepared>();auto p=c.prepared;auto device=c.device;const auto width=c.width,height=c.height;const std::string directory=c.root+"/"+(width==1920?"1080p":width==2560?"1440p":"2160p"),helpers=c.helpers;const auto options=c.options;
 dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{@autoreleasepool{try{
  auto reserve=[=](uint64_t bytes)->std::shared_ptr<void>{if(!options.reserve||!options.release)return {};void*token=options.reserve(options.allocationContext,bytes);if(!token)return {};return {token,options.release};};
  p->runtime=std::make_unique<anr::Runtime>(device,directory);p->runtime->set_allocation_hooks(reserve);if(!p->runtime->initialize(p->error)){p->done=true;return;}
  auto texture=[&](MTLPixelFormat f){auto lease=reserve(uint64_t(width)*height*4);if(!lease)return id<MTLTexture>(nil);p->reservations.push_back(std::move(lease));auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:f width:width height:height mipmapped:NO];d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;d.storageMode=MTLStorageModePrivate;return [device newTextureWithDescriptor:d];};
  p->color=texture(MTLPixelFormatRGB10A2Unorm);p->depth=texture(MTLPixelFormatR32Float);p->motion=texture(MTLPixelFormatRG16Float);p->generated=texture(MTLPixelFormatRGB10A2Unorm);
  NSError*error=nil;auto lib=[device newLibraryWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:helpers.c_str()]] error:&error];p->import=[device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"anrImport"] error:&error];p->importDepth=[device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"anrImportDepth"] error:&error];p->exportImage=[device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"anrExport"] error:&error];
  if(!p->color||!p->depth||!p->motion||!p->generated||!p->import||!p->importDepth||!p->exportImage)p->error="ANR helper resources unavailable";
 }catch(const std::exception&e){p->error=e.what();}p->done=true;}});
 return result(r,RS_GENERATION_BUSY,"Preparing ANR resources");
}catch(const std::exception&e){return result(r,RS_GENERATION_FAILED,e.what());}}
static int encodeImpl(void*opaque,const RSGenerationSubmission*input,RSGenerationResult*r){
 const auto code=prepare(opaque,input,r);if(code!=RS_GENERATION_OK)return code;auto&c=*static_cast<Context*>(opaque);std::lock_guard guard(c.lock);const auto&s=*reinterpret_cast<const RSANRSubmission*>(input);const auto&b=s.base;const auto&f=*b.scene;auto p=c.prepared;auto commands=(__bridge id<MTLCommandBuffer>)b.commandBuffer;
 if(c.pending&&c.pending.status<MTLCommandBufferStatusCompleted)return result(r,RS_GENERATION_BUSY,"ANR preceding frame is in flight");
 if(c.pending&&c.pending.status==MTLCommandBufferStatusError)c.history=false;
 if(b.count>4)return result(r,RS_GENERATION_INVALID,"ANR requires one to four timeline phases");
 float previous=0;for(unsigned i=0;i<b.count;i++){auto output=(__bridge id<MTLTexture>)b.outputs[i];if(!output||output.device!=c.device||output.width!=c.width||output.height!=c.height||!std::isfinite(b.phases[i])||b.phases[i]<=previous||b.phases[i]>=1)return result(r,RS_GENERATION_INVALID,"ANR requires matching outputs and ascending phases");previous=b.phases[i];}
 bool reset=!c.history||!c.completion||c.completion->load()!=MTLCommandBufferStatusCompleted||(c.submission&&b.sequence!=c.submission+1)||c.transfer!=b.transferFunction||c.bottomLeft!=s.bottomLeft||c.owner!=f.owner||c.queue!=commands.commandQueue||f.frameId<=c.frame||(f.flags&RS_TEMPORAL_RESET)||anr::frameCamera(f).infinite!=c.previous.infinite;
 Inputs args{c.width,c.height,f.renderWidth,f.renderHeight,f.depthX,f.depthY,f.motionX,f.motionY,b.transferFunction,s.bottomLeft,s.ui?1u:0u,s.premultiplied,0,0,s.referenceWhite};
 auto srgb=[](id<MTLTexture>image){return image.pixelFormat==MTLPixelFormatRGBA8Unorm_sRGB||image.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB;};args.sourceSrgb=srgb((__bridge id<MTLTexture>)b.color);
 c.pending=commands;c.history=false;c.completion=std::make_shared<std::atomic<unsigned>>(MTLCommandBufferStatusNotEnqueued);auto completion=c.completion;
 [commands addCompletedHandler:^(id<MTLCommandBuffer>done){completion->store(unsigned(done.status));(void)p;}];
 auto pass=[&](id<MTLComputePipelineState>pipeline,const std::vector<id<MTLTexture>>&textures){auto e=[commands computeCommandEncoder];if(!e)throw std::runtime_error("ANR compute encoder unavailable");[e setComputePipelineState:pipeline];[e setBytes:&args length:sizeof(args) atIndex:0];for(unsigned i=0;i<textures.size();i++)[e setTexture:textures[i] atIndex:i];[e dispatchThreads:MTLSizeMake(c.width,c.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[e endEncoding];};
 pass(((__bridge id<MTLTexture>)f.depth).pixelFormat==MTLPixelFormatDepth32Float?p->importDepth:p->import,{(__bridge id<MTLTexture>)b.color,(__bridge id<MTLTexture>)f.depth,(__bridge id<MTLTexture>)f.motion,p->color,p->depth,p->motion});
 const auto camera=anr::frameCamera(f);uint8_t constants[anr::FrameBytes];anr::frameConstants(constants,camera,reset?camera:c.previous,f.motionScaleX*c.width/f.renderWidth,f.motionScaleY*c.height/f.renderHeight,f.jitterX,s.bottomLeft?-f.jitterY:f.jitterY,!reset,c.width,c.height);
 std::string error;p->runtime->set_frame_slot(0);if(reset&&!p->runtime->reset_history(commands,false,error))return result(r,RS_GENERATION_FAILED,error);
 if(!p->runtime->encode_pair_classic(commands,p->color,p->depth,p->motion,constants,sizeof(constants),error))return result(r,RS_GENERATION_FAILED,error);
 if(!reset)for(unsigned i=0;i<b.count;i++){if(!p->runtime->encode_interpolation_classic(commands,b.phases[i],p->generated,error))return result(r,RS_GENERATION_FAILED,error);args.outputSrgb=srgb((__bridge id<MTLTexture>)b.outputs[i]);pass(p->exportImage,{p->generated,(__bridge id<MTLTexture>)b.outputs[i],s.ui?(__bridge id<MTLTexture>)s.ui:p->color});}
 p->runtime->swap_history();c.history=true;c.frame=f.frameId;c.owner=f.owner;c.queue=commands.commandQueue;c.submission=b.sequence;c.transfer=b.transferFunction;c.bottomLeft=s.bottomLeft;c.previous=camera;r->encoded=1;r->ready=!reset;r->generated=reset?0:b.count;r->historyFrames=reset?1:2;r->sequence=b.sequence;return result(r,RS_GENERATION_OK,reset?"ANR history is warming":"");
}
static int encode(void*opaque,const RSGenerationSubmission*input,RSGenerationResult*r){try{return encodeImpl(opaque,input,r);}catch(const std::exception&e){static_cast<Context*>(opaque)->history=false;return result(r,RS_GENERATION_FAILED,e.what());}}
static void*create(const RSGenerationOptions*o,RSGenerationResult*r){if(!o||o->size<sizeof(*o)||o->version!=1||!o->device||!o->shaderDirectory){result(r,RS_GENERATION_INVALID,"Invalid ANR options");return nullptr;}const char*root=o->size>=sizeof(RSANROptions)?reinterpret_cast<const RSANROptions*>(o)->runtimeRoot:nullptr;if(!root||root[0]!='/'){result(r,RS_GENERATION_FAILED,"Install the Apex Neural Rendering runtime");return nullptr;}auto c=new Context;c->options=*o;c->device=(__bridge id<MTLDevice>)o->device;c->root=root;c->helpers=std::string(o->shaderDirectory)+"/helpers.metallib";return c;}
extern "C" const RSGenerationProvider*rsGetGenerationProvider(uint32_t version){static const RSGenerationProvider api{sizeof(api),1,create,encode,[](void*c){delete static_cast<Context*>(c);},prepare};return version==1?&api:nullptr;}
