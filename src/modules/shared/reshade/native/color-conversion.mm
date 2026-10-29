// Copyright (c) MacLauncher contributors. MIT license.
#include "color-conversion.hpp"
#include "color-formats.hpp"
#include "metal-library-cache.hpp"
#include <simd/simd.h>
#include <map>
#include <mutex>
namespace macfx { namespace {
const char *source=R"metal(
#include <metal_stdlib>
using namespace metal;
struct Uniforms {float4 m0,m1,m2,n0,n1,n2,p0,p1,p2,source,target;uint4 flags,extra;};
struct V{float4 p[[position]];float2 uv;};
vertex V color_vertex(uint i[[vertex_id]]){float2 q=float2((i<<1)&2,i&2);return {float4(q*2-1,0,1),float2(q.x,1-q.y)};}
float3 eotf(float3 v,uint tr,float white,float peak,float gamma){
 if(tr==0){float3 x=abs(v);return sign(v)*select(x/12.92,pow((x+.055)/1.055,float3(2.4)),x>.04045);}
 if(tr==1)return v;
 if(tr==4)return select(v/4.5,pow(max((v+.099)/1.099,0.0),float3(1.0/.45)),v>=.081);
 if(tr==2){float3 p=pow(max(v,0.0),float3(1.0/(2523.0/32.0)));return pow(max(p-3424.0/4096.0,0.0)/max(2413.0/128.0-2392.0/128.0*p,1e-6),float3(1.0/(2610.0/16384.0)))*(10000.0/white);}
 float3 x=select(v*v/3.0,(exp((v-.55991073)/.17883277)+.28466892)/12.0,v>.5);
 float y=max(dot(x,float3(.2627,.6780,.0593)),1e-8);return x*pow(y,gamma-1.0)*(peak/white);
}
float3 oetf(float3 v,uint tr,float white,float peak,float gamma){
 if(tr==0){float3 x=abs(v);return sign(v)*select(x*12.92,1.055*pow(x,float3(1.0/2.4))-.055,x>.0031308);}
 if(tr==1)return v;
 if(tr==4)return select(v*4.5,1.099*pow(max(v,0.0),float3(.45))-.099,v>=.018);
 if(tr==2){float3 p=pow(max(v,0.0)*(white/10000.0),float3(2610.0/16384.0));return pow((3424.0/4096.0+2413.0/128.0*p)/(1.0+2392.0/128.0*p),float3(2523.0/32.0));}
 float3 x=max(v,0.0)*(white/peak);float y=max(dot(x,float3(.2627,.6780,.0593)),1e-8);x*=pow(y,(1.0-gamma)/gamma);return select(sqrt(3.0*x),.17883277*log(max(12.0*x-.28466892,1e-8))+.55991073,x>1.0/12.0);
}
// Khronos PBR Neutral equations operate on scene-linear RGB. This mode is
// admitted only for explicitly scene-referred input.
float3 neutral(float3 c){float x=min(c.r,min(c.g,c.b));float offset=x<.08?x-6.25*x*x:.04;c-=offset;float peak=max(c.r,max(c.g,c.b));if(peak<.76)return c;float d=.24;float p=1.0-d*d/(peak+d-.76);c*=p/peak;float g=1.0-1.0/(.15*(peak-p)+1.0);return mix(c,float3(p),g);}
fragment float4 color_fragment(V v[[stage_in]],texture2d<float> input[[texture(0)]],texture2d<float> alpha[[texture(1)]],constant Uniforms &u[[buffer(0)]]){
 constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);float2 uv=v.uv;if(u.n1.w)uv.y=1-uv.y;float4 p=u.p2.w?input.read(uint2(v.p.xy)):input.sample(s,uv);if(u.p1.w)p.a=input.read(uint2(v.p.xy)).a;if(u.m2.w)p.rgb=oetf(p.rgb,0,1,1,1);float sourceAlpha=u.flags.z==2?1.0:p.a;float a=u.n0.w?alpha.sample(s,uv).a:sourceAlpha;if(u.p2.w)return float4(p.rgb,u.m0.w==2?1:a);float3 c=u.flags.z==1?(sourceAlpha>1e-8?p.rgb/sourceAlpha:float3(0)):p.rgb;
 if(u.extra.x)c=(c-16.0/255.0)*(255.0/219.0);
 c=eotf(c,u.flags.x,u.source.x,u.source.y,u.source.z)*u.source.x/u.target.x;
 c=float3(dot(u.m0.xyz,c),dot(u.m1.xyz,c),dot(u.m2.xyz,c))*exp2(u.source.w);
 if(u.extra.z==1)c=clamp(c,0.0,u.target.w);
 else if(u.extra.z==2){float peak=max(max(c.r,c.g),c.b);if(peak>0)c*=1.0/(1.0+peak/u.target.w);}
 else if(u.extra.z==3){float3 n=float3(dot(u.n0.xyz,c),dot(u.n1.xyz,c),dot(u.n2.xyz,c));n=neutral(max(n,0.0)/u.target.w)*u.target.w;c=float3(dot(u.p0.xyz,n),dot(u.p1.xyz,n),dot(u.p2.xyz,n));}
 c=oetf(c,u.flags.y,u.target.x,u.target.y,u.target.z);
 if(u.extra.y)c=c*(219.0/255.0)+16.0/255.0;
 if(u.extra.w){uint2 xy=uint2(v.p.xy);uint h=xy.x*1664525u+xy.y*1013904223u+u.flags.w*747796405u;h=(h^(h>>16))*2246822519u;float noise=(float(h&65535u)/65535.0-.5)/float((1u<<u.extra.w)-1u);c+=noise*u.p0.w;}
 if(u.m0.w==1)c*=a;if(u.m1.w)c=eotf(c,0,1,1,1);return float4(c,u.m0.w==2?1:a);
}
)metal";
simd_float3x3 toXYZ(ColorPrimaries p){
 if(p==ColorPrimaries::DisplayP3)return simd_transpose(simd_matrix(simd_make_float3(.48657095,.26566769,.19821729),simd_make_float3(.22897456,.69173852,.07928691),simd_make_float3(0,.04511338,1.04394437)));
 if(p==ColorPrimaries::BT2020)return simd_transpose(simd_matrix(simd_make_float3(.63695805,.14461690,.16888098),simd_make_float3(.26270021,.67799807,.05930172),simd_make_float3(0,.02807269,1.06098506)));
 return simd_transpose(simd_matrix(simd_make_float3(.41239080,.35758434,.18048079),simd_make_float3(.21263901,.71516868,.07219232),simd_make_float3(.01933082,.11919478,.95053215)));
}
bool hardwareSRGB(MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm_sRGB||f==MTLPixelFormatBGRA8Unorm_sRGB||f==MTLPixelFormatBGRA10_XR_sRGB||f==MTLPixelFormatBGR10_XR_sRGB;}
struct Uniforms{simd_float4 m0,m1,m2,n0,n1,n2,p0,p1,p2,source,target;simd_uint4 flags,extra;};
}
struct ColorEncoder::Impl {id<MTLDevice>device;std::mutex mutex;std::map<MTLPixelFormat,id<MTLRenderPipelineState>>pipelines;explicit Impl(id<MTLDevice>d):device(d){}
id<MTLRenderPipelineState>pipeline(MTLPixelFormat format){
 {std::lock_guard guard(mutex);const auto found=pipelines.find(format);if(found!=pipelines.end())return found->second;}
 // Compiling a new output format must not hold the device's ready pipelines
 // behind a driver call while another window encodes its prepared format.
 NSError *error=nil;auto library=cachedMetalLibrary(device,source,&error);
 if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile color conversion");
 auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[library newFunctionWithName:@"color_vertex"];descriptor.fragmentFunction=[library newFunctionWithName:@"color_fragment"];descriptor.colorAttachments[0].pixelFormat=format;
 auto prepared=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!prepared)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare color conversion");
 std::lock_guard guard(mutex);return pipelines.emplace(format,prepared).first->second;
}};
ColorEncoder::ColorEncoder(id<MTLDevice>device){static std::mutex lock;static std::map<uintptr_t,std::weak_ptr<Impl>>devices;std::lock_guard guard(lock);auto&cached=devices[reinterpret_cast<uintptr_t>((__bridge void*)device)];impl=cached.lock();if(!impl){impl=std::make_shared<Impl>(device);cached=impl;}}
ColorEncoder::~ColorEncoder()=default;
ShaderResult ColorEncoder::prepare(MTLPixelFormat format){try{impl->pipeline(format);return {true,{}};}catch(const std::exception&e){return {false,e.what()};}}
ShaderResult ColorEncoder::encode(id<MTLCommandBuffer>commands,id<MTLTexture>input,id<MTLTexture>output,const ColorConversion &c){return encode(commands,input,output,c,false);}
ShaderResult ColorEncoder::encode(id<MTLCommandBuffer>commands,id<MTLTexture>input,id<MTLTexture>output,const ColorConversion &c,bool exactAlphaTexels){try{
 if(!commands||!input||!output||input==output||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||input.framebufferOnly||input.device!=impl->device||output.device!=impl->device||commands.device!=impl->device||input.sampleCount!=1||output.sampleCount!=1||input.textureType!=MTLTextureType2D||output.textureType!=MTLTextureType2D||!imageRGBFormat(input.pixelFormat)||!imageRGBFormat(output.pixelFormat))throw std::runtime_error("Color conversion requires unsubmitted retaining commands and distinct resolved RGB images on the caller's device");
 if(c.alphaSource&&(c.alphaSource==output||c.alphaSource.device!=impl->device||c.alphaSource.sampleCount!=1||c.alphaSource.textureType!=MTLTextureType2D||!(c.alphaSource.usage&MTLTextureUsageShaderRead)))throw std::runtime_error("Color conversion alpha requires a distinct readable image on the caller's device");
 const auto width=c.outputWidth?c.outputWidth:unsigned(output.width),height=c.outputHeight?c.outputHeight:unsigned(output.height);
 if(c.outputX>output.width||c.outputY>output.height||width>output.width-c.outputX||height>output.height-c.outputY)throw std::runtime_error("The color output region exceeds its texture");
 const bool partial=c.outputX||c.outputY||width!=output.width||height!=output.height;
 if(exactAlphaTexels&&(partial||c.flipY||c.alphaSource||input.width!=output.width||input.height!=output.height))throw std::runtime_error("Exact alpha texels require equal complete images without an alpha transform");
 if(!c.source.valid()||!c.target.valid()||!std::isfinite(c.headroom)||c.headroom<1||c.headroom>100||!std::isfinite(c.exposure)||std::abs(c.exposure)>32||(c.ditherBits!=0&&c.ditherBits!=8&&c.ditherBits!=10))throw std::runtime_error("Invalid color conversion metadata");
 if(c.toneMap==ColorToneMap::PBRNeutral&&!c.source.sceneReferred)throw std::runtime_error("PBR Neutral requires scene-linear source metadata");
 if(c.ditherBits&&(output.pixelFormat==MTLPixelFormatRGBA16Float||output.pixelFormat==MTLPixelFormatRGBA32Float))throw std::runtime_error("Output dithering requires a quantized target");
 const auto matrix=simd_transpose(simd_mul(simd_inverse(toXYZ(c.target.primaries)),toXYZ(c.source.primaries)));
 Uniforms u{};u.m0=simd_make_float4(matrix.columns[0],float(c.target.alpha));u.m1=simd_make_float4(matrix.columns[1],float(hardwareSRGB(output.pixelFormat)));u.m2=simd_make_float4(matrix.columns[2],float(hardwareSRGB(input.pixelFormat)));
 const auto neutralIn=simd_transpose(simd_mul(simd_inverse(toXYZ(ColorPrimaries::BT709)),toXYZ(c.target.primaries))),neutralOut=simd_transpose(simd_mul(simd_inverse(toXYZ(c.target.primaries)),toXYZ(ColorPrimaries::BT709)));
 const bool rgbCopy=!partial&&!c.flipY&&input.width==output.width&&input.height==output.height&&c.source.transfer==ColorTransfer::Linear&&c.target.transfer==ColorTransfer::Linear&&c.source.primaries==c.target.primaries&&c.source.range==ColorRange::Full&&c.target.range==ColorRange::Full&&c.source.referenceWhite==c.target.referenceWhite&&c.source.alpha!=ColorAlpha::Premultiplied&&c.target.alpha!=ColorAlpha::Premultiplied&&c.toneMap==ColorToneMap::Preserve&&c.exposure==0&&!c.ditherBits&&!hardwareSRGB(input.pixelFormat)&&!hardwareSRGB(output.pixelFormat)&&!extendedPackedColorFormat(output.pixelFormat);
 u.n0=simd_make_float4(neutralIn.columns[0],float(bool(c.alphaSource)));u.n1=simd_make_float4(neutralIn.columns[1],float(c.flipY));u.n2=simd_make_float4(neutralIn.columns[2],0);u.p0=simd_make_float4(neutralOut.columns[0],extendedPackedColorFormat(output.pixelFormat)?1023.f/510.f:1.f);u.p1=simd_make_float4(neutralOut.columns[1],float(exactAlphaTexels));u.p2=simd_make_float4(neutralOut.columns[2],float(rgbCopy));
 u.source={c.source.referenceWhite,c.source.peakLuminance,c.source.hlgSystemGamma,c.exposure};u.target={c.target.referenceWhite,c.target.peakLuminance,c.target.hlgSystemGamma,c.headroom};
 u.flags={unsigned(c.source.transfer),unsigned(c.target.transfer),unsigned(c.source.alpha),unsigned(c.frameId)};
 u.extra={unsigned(c.source.range==ColorRange::Limited),unsigned(c.target.range==ColorRange::Limited),unsigned(c.toneMap),c.ditherBits};
 auto pipeline=impl->pipeline(output.pixelFormat);auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=output;pass.colorAttachments[0].loadAction=partial?MTLLoadActionLoad:MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)throw std::runtime_error("Cannot encode color conversion");[encoder setRenderPipelineState:pipeline];[encoder setViewport:MTLViewport{double(c.outputX),double(c.outputY),double(width),double(height),0,1}];[encoder setScissorRect:MTLScissorRect{c.outputX,c.outputY,width,height}];[encoder setFragmentTexture:input atIndex:0];[encoder setFragmentTexture:c.alphaSource?:input atIndex:1];[encoder setFragmentBytes:&u length:sizeof(u) atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];return {true,{}};
}catch(const std::exception&e){return {false,e.what()};}}
}
