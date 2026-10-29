// Copyright (c) MacLauncher contributors. MIT license.
#include "comparison.hpp"
#include "metal-library-cache.hpp"
#include "color-conversion.hpp"
#include "output-color.hpp"
#include <cmath>
#include <algorithm>
namespace macfx {
namespace {
const std::string source=R"(#include <metal_stdlib>
using namespace metal;
struct Vertex {float4 position [[position]];float2 uv;};
vertex Vertex comparisonVertex(uint id [[vertex_id]]) {float2 p=float2((id<<1)&2,id&2);return {float4(p*2-1,0,1),float2(p.x,1-p.y)};}
struct Options {uint mode;float position;float gain;};
fragment float4 comparisonFragment(Vertex v [[stage_in]],texture2d<float>raw [[texture(0)]],texture2d<float>processed [[texture(1)]],constant Options&options [[buffer(0)]]) {
 constexpr sampler sample(coord::normalized,address::clamp_to_edge,filter::linear);
 float4 after=processed.sample(sample,v.uv);
 if(options.mode==0)return after;
 float4 before=raw.sample(sample,v.uv);
 if(options.mode==1)return before;
 if(options.mode==2)return v.uv.x<options.position?before:after;
 return float4(abs(before.rgb-after.rgb)*options.gain,after.a);
})";
}
struct ComparisonEncoder::Impl {std::shared_ptr<ColorEncoder>colors;id<MTLDevice>device=nil;id<MTLRenderPipelineState>pipeline=nil;MTLPixelFormat format=MTLPixelFormatInvalid;};
ComparisonEncoder::ComparisonEncoder():impl(std::make_shared<Impl>()){}
ComparisonEncoder::~ComparisonEncoder()=default;
ShaderResult ComparisonEncoder::prepare(id<MTLDevice>device,MTLPixelFormat format){try{@autoreleasepool{
 if(!device||format==MTLPixelFormatInvalid)return {false,"Comparison requires an output device and color format",false};
 if(impl->device==device&&impl->pipeline&&impl->format==format)return {true,{},false};
 NSError*error=nil;auto library=cachedMetalLibrary(device,source,&error);if(!library)return {false,error.localizedDescription.UTF8String?:"The GPU comparison shader could not compile",false};
 auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"comparisonVertex"];descriptor.fragmentFunction=[library newFunctionWithName:@"comparisonFragment"];descriptor.colorAttachments[0].pixelFormat=format;
 auto pipeline=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!pipeline)return {false,error.localizedDescription.UTF8String?:"The GPU comparison pipeline is unavailable",false};
 auto prepared=std::make_shared<Impl>();prepared->device=device;prepared->format=format;prepared->pipeline=pipeline;prepared->colors=std::make_shared<ColorEncoder>(device);const auto color=prepared->colors->prepare(MTLPixelFormatRGBA16Float);if(!color.encoded)return color;impl=std::move(prepared);return {true,{},false};
 }}catch(const std::exception&error){return {false,error.what(),false};}}
ShaderResult ComparisonEncoder::encodeAligned(id<MTLCommandBuffer>commands,id<MTLTexture>raw,id<MTLTexture>processed,id<MTLTexture>before,id<MTLTexture>after,id<MTLTexture>target,const ComparisonSettings&settings,const ImageColorDescription&sourceColor,const ImageColorDescription&targetDisplayColor,bool rawMapped,bool processedMapped,uint64_t frameId,ImageColorDescription*encodedColor,std::string_view toneMapping,std::string_view*policyReason){try{
 const auto state=impl;if(!state->colors||!sourceColor.valid()||!targetDisplayColor.valid()||!before||!after||!target||before.pixelFormat!=MTLPixelFormatRGBA16Float||after.pixelFormat!=MTLPixelFormatRGBA16Float||target.pixelFormat!=MTLPixelFormatRGBA16Float||before==after||before==target||after==target||before==raw||before==processed||after==raw||after==processed||target==raw||target==processed||before.width!=target.width||before.height!=target.height||after.width!=target.width||after.height!=target.height)return {false,"Comparison requires separate admitted float alignment images of the output extent",false};
 auto domain=targetDisplayColor;domain.transfer=ColorTransfer::Linear;domain.range=ColorRange::Full;domain.sceneReferred=false;
 if(policyReason)*policyReason={};
 const auto convert=[&](id<MTLTexture>input,id<MTLTexture>output,bool mapped){ColorConversion value;value.source=sourceColor;value.target=domain;value.headroom=std::max(1.f,domain.peakLuminance/domain.referenceWhite);value.frameId=frameId;const auto policy=outputColorMapping(toneMapping,sourceColor,domain,mapped);value.toneMap=policy.toneMap;if(policyReason&&!policy.reason.empty())*policyReason=policy.reason;return state->colors->encode(commands,input,output,value);};
 auto aligned=convert(raw,before,rawMapped);if(!aligned.encoded)return aligned;aligned=convert(processed,after,processedMapped);if(!aligned.encoded)return aligned;const auto result=encode(commands,before,after,target,settings);if(result.encoded&&encodedColor)*encodedColor=domain;return result;
 }catch(const std::exception&error){return {false,error.what(),false};}}
ShaderResult ComparisonEncoder::encode(id<MTLCommandBuffer>commands,id<MTLTexture>raw,id<MTLTexture>processed,id<MTLTexture>target,const ComparisonSettings&settings){try{@autoreleasepool{
 const auto state=impl;if(!commands||!raw||!processed||!target||commands.device!=state->device||raw.device!=commands.device||processed.device!=commands.device||target.device!=commands.device||target.pixelFormat!=state->format||!state->pipeline)return {false,"Prepare comparison for the current GPU frame contract before rendering",false};
 if(raw==target||processed==target)return {false,"Comparison requires a separate admitted output texture",false};
 if(!std::isfinite(settings.position)||settings.position<0||settings.position>1||!std::isfinite(settings.gain)||settings.gain<1||settings.gain>16)return {false,"Comparison position or difference gain is invalid",false};
 unsigned mode=settings.mode=="off"?0:settings.mode=="before"?1:settings.mode=="wipe"?2:settings.mode=="difference"?3:4;if(mode==4)return {false,"The comparison mode is unsupported",false};
 struct Options{uint32_t mode;float position,gain;}options{mode,float(settings.position),float(settings.gain)};
 auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=target;pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
 auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)return {false,"The GPU comparison render pass is unavailable",false};[encoder setRenderPipelineState:state->pipeline];[encoder setFragmentTexture:raw atIndex:0];[encoder setFragmentTexture:processed atIndex:1];[encoder setFragmentBytes:&options length:sizeof(options) atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)state;}];return {true,{},false};
 }}catch(const std::exception&error){return {false,error.what(),false};}}
}
