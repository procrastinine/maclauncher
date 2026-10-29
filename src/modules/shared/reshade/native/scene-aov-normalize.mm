// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-aov-normalize.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#import <simd/simd.h>
#include <cstring>
#include <cmath>
namespace macfx {
namespace {
const std::string source=R"(#include <metal_stdlib>
using namespace metal;
struct Params {uint4 roi;uint4 options;float4 values;float4 transform[4];uint4 extra;};
float3 raw_srgb(float3 c){return select(c*12.92,1.055*pow(max(c,0.0),float3(1.0/2.4))-.055,c>.0031308);}
kernel void normalizeAov(texture2d<float>input[[texture(0)]],texture2d<float,access::write>output[[texture(1)]],constant Params&p[[buffer(0)]],uint2 xy[[thread_position_in_grid]]){
 if(any(xy>=uint2(output.get_width(),output.get_height())))return;
 constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);
 constexpr sampler nearest(coord::normalized,address::clamp_to_edge,filter::nearest);
 float2 uv=(float2(xy)+.5)/float2(output.get_width(),output.get_height());if(p.options.w!=p.extra.y/2)uv.y=1-uv.y;
 float2 pixel=float2(p.roi.xy)+clamp(uv*float2(p.roi.zw)-.5,float2(0),float2(p.roi.zw)-1)+.5;
 float2 sampleUv=pixel/float2(input.get_width(),input.get_height());float4 value=p.extra.x==8||p.extra.x==9?input.sample(nearest,sampleUv):input.sample(s,sampleUv);
 // Data slots use raw stored components even when their texture view has an
 // sRGB sampling format. Color slots retain their independently declared code.
 if(p.extra.z&&p.extra.w)value.rgb=raw_srgb(value.rgb);
 if(p.extra.x==0){float3 n=p.options.x==2?value.rgb*2-1:value.rgb;n=normalize(n);if(p.extra.y&1)n=float3(dot(p.transform[0].xyz,n),dot(p.transform[1].xyz,n),dot(p.transform[2].xyz,n));value=float4(normalize(n),1);}
 else if(p.extra.x==1||p.extra.x==8||p.extra.x==9||p.extra.x==11){float v=value[p.options.z];if(p.options.x==3)v=min(v,1-v);value=float4(v*p.values.x+p.values.y,0,0,1);}
 output.write(value,xy);
})";
bool scalar(unsigned slot){return slot==RS_SCENE_AOV_ROUGHNESS||slot==RS_SCENE_AOV_SPECULAR_HIT_DISTANCE||slot==RS_SCENE_AOV_DENOISE_MASK||slot==RS_SCENE_AOV_METALLIC;}
bool srgb(MTLPixelFormat format){return format==MTLPixelFormatRGBA8Unorm_sRGB||format==MTLPixelFormatBGRA8Unorm_sRGB;}
}
struct SceneAovNormalizer::Impl {id<MTLCommandQueue>queue;id<MTLComputePipelineState>pipeline;std::array<id<MTLTexture>,RS_SCENE_AOV_COUNT>images{};RSSceneAovs prototype{};unsigned width=0,height=0;uint32_t mask=0;RSSceneAovSpace space=RS_SCENE_AOV_SPACE_WORLD;bool bottom=false;explicit Impl(id<MTLCommandQueue>q):queue(q){}};
SceneAovNormalizer::SceneAovNormalizer(id<MTLCommandQueue>queue):impl(std::make_shared<Impl>(queue)){}
SceneAovNormalizer::~SceneAovNormalizer()=default;
ShaderResult SceneAovNormalizer::prepare(const RSSceneAovs&inputPacket,unsigned width,unsigned height,uint32_t mask,RSSceneAovSpace normalSpace,bool outputBottomLeft){try{
 if(!impl->queue||!width||!height||width>16384||height>16384||mask>>RS_SCENE_AOV_COUNT||(normalSpace!=RS_SCENE_AOV_SPACE_WORLD&&normalSpace!=RS_SCENE_AOV_SPACE_VIEW))return {false,"Invalid scene attachment normalization contract"};
 auto validated=validatedSceneAovs(inputPacket,impl->queue.device);if(!validated)return {false,"The scene attachment packet is invalid"};const auto&packet=*validated;
 for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)if((mask&(1u<<i))&&!packet.images[i].texture)return {false,"Needs matching renderer "+std::string(sceneAovNames[i])};
 bool formatsMatch=true;for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)if(mask&(1u<<i)){auto image=(__bridge id<MTLTexture>)packet.images[i].texture;const auto wanted=scalar(i)?MTLPixelFormatR32Float:image.pixelFormat==MTLPixelFormatRGBA32Float?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float;formatsMatch&=impl->images[i]&&impl->images[i].pixelFormat==wanted;}
 if(impl->pipeline&&impl->width==width&&impl->height==height&&impl->mask==mask&&impl->space==normalSpace&&impl->bottom==outputBottomLeft&&formatsMatch)return {true,{}};
 auto next=std::make_shared<Impl>(impl->queue);next->width=width;next->height=height;next->mask=mask;next->space=normalSpace;next->bottom=outputBottomLeft;NSError*error=nil;auto library=cachedMetalLibrary(next->queue.device,source,&error);if(!library)return {false,error.localizedDescription.UTF8String?:"Cannot compile scene attachment normalization"};next->pipeline=[next->queue.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"normalizeAov"] error:&error];if(!next->pipeline)return {false,error.localizedDescription.UTF8String?:"Cannot prepare scene attachment normalization"};next->prototype=packet;
 for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i){auto&out=next->prototype.images[i];if(!(mask&(1u<<i))){out={};continue;}auto input=(__bridge id<MTLTexture>)packet.images[i].texture;const auto format=scalar(i)?MTLPixelFormatR32Float:input.pixelFormat==MTLPixelFormatRGBA32Float?MTLPixelFormatRGBA32Float:MTLPixelFormatRGBA16Float;auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;next->images[i]=newAdmittedTexture(next->queue.device,descriptor,reinterpret_cast<uintptr_t>(this),"scene-aov-normalized");out.texture=(__bridge void*)next->images[i];out.x=out.y=0;out.width=width;out.height=height;out.origin=outputBottomLeft?RS_SCENE_AOV_BOTTOM_LEFT:RS_SCENE_AOV_TOP_LEFT;if(i==RS_SCENE_AOV_NORMAL){out.encoding=RS_SCENE_AOV_XYZ_SIGNED;out.space=normalSpace;out.channel=0;out.scale=1;out.bias=0;}else if(scalar(i)){out.encoding=RS_SCENE_AOV_SCALAR;out.channel=0;out.scale=1;out.bias=0;}}
 impl=std::move(next);return {true,{}};
 }catch(const ImageBudgetExceeded&error){return {false,error.what(),true};}catch(const std::exception&error){return {false,error.what()};}}
RSSceneAovs SceneAovNormalizer::layout()const{return impl->prototype;}
ShaderResult SceneAovNormalizer::encode(id<MTLCommandBuffer>commands,const RSSceneAovs&inputPacket,const std::optional<RSSceneMatrices>&matrices,RSSceneAovs&normalized){try{
 const auto state=impl;if(!commands||commands.commandQueue!=state->queue||commands.status>=MTLCommandBufferStatusCommitted||!state->pipeline)return {false,"Prepare attachments for their actual scene queue",true};auto validated=validatedSceneAovs(inputPacket,commands.device);if(!validated)return {false,"The scene attachment packet is invalid"};const auto&packet=*validated;
 simd_float4x4 view=matrix_identity_float4x4;bool transform=false;const auto&normal=packet.images[RS_SCENE_AOV_NORMAL];if((state->mask&(1u<<RS_SCENE_AOV_NORMAL))&&normal.space!=state->space){if(!matrices||!(matrices->flags&RS_SCENE_VIEW_VALID)||matrices->frameId!=packet.frameId)return {false,"Needs the matching view matrix to transform renderer normals"};std::memcpy(&view,matrices->view,sizeof(view));const float determinant=simd_determinant(view);if(!std::isfinite(determinant)||std::abs(determinant)<1e-12)return {false,"The renderer view matrix cannot transform normals"};if(normal.space==RS_SCENE_AOV_SPACE_WORLD)view=simd_inverse(view);transform=true;}
 for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)if((state->mask&(1u<<i))&&!packet.images[i].texture)return {false,"Needs matching renderer "+std::string(sceneAovNames[i])};
 auto result=packet;std::array<id<MTLTexture>,RS_SCENE_AOV_COUNT>retained{};
 struct alignas(16) Params {simd_uint4 roi,options;simd_float4 values;simd_float4x4 transform;simd_uint4 extra;};static_assert(sizeof(Params)==128);
 auto encoder=[commands computeCommandEncoder];if(!encoder)return {false,"Cannot encode scene attachment normalization",true};[encoder setComputePipelineState:state->pipeline];
 for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i){if(!(state->mask&(1u<<i))){result.images[i]={};continue;}const auto&input=packet.images[i];auto texture=(__bridge id<MTLTexture>)input.texture;retained[i]=texture;Params params{};params.roi={input.x,input.y,input.width,input.height};params.options={input.encoding,input.space,input.channel,input.origin};params.values={input.scale,input.bias,0,0};params.transform=view;params.extra={i,uint32_t(i==RS_SCENE_AOV_NORMAL&&transform)|(state->bottom?2u:0u),uint32_t(srgb(texture.pixelFormat)),uint32_t(i==RS_SCENE_AOV_NORMAL||scalar(i)||i==RS_SCENE_AOV_HUDLESS_COLOR&&packet.hudlessColor.transfer==RS_COLOR_SRGB||i==RS_SCENE_AOV_UI_COLOR_ALPHA&&packet.uiColor.transfer==RS_COLOR_SRGB)};[encoder setTexture:texture atIndex:0];[encoder setTexture:state->images[i] atIndex:1];[encoder setBytes:&params length:sizeof(params) atIndex:0];[encoder dispatchThreads:MTLSizeMake(state->width,state->height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];result.images[i]=state->prototype.images[i];result.images[i].pass=input.pass;}
 [encoder endEncoding];[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)state;(void)retained;}];normalized=result;return {true,{}};
 }catch(const std::exception&error){return {false,error.what()};}}
}
