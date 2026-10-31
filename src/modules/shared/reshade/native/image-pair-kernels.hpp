#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// flowInterpolate is adapted from MetalDuck's Present.metal,
// Copyright (c) 2026 Nycolazs, MIT; see metalduck-MIT.txt.
namespace macfx {
// Compute kernels shared by the framework-backed image-pair generators. Flag
// bit 0 marks an sRGB source view whose samples arrive linear; bit 1 marks an
// sRGB destination view whose writes are encoded by Metal.
inline constexpr const char*imagePairKernels=R"MSL(
#include <metal_stdlib>
using namespace metal;
struct Convert {uint fullRange;uint flags;float2 coverage;float2 vectorScale;};
struct FlowParams {float t;float gain;float consistency;float colorTolerance;};
constexpr sampler linearClamp(filter::linear,address::clamp_to_edge);
static float3 encodeSRGB(float3 c){c=saturate(c);return select(1.055f*pow(c,1.0f/2.4f)-0.055f,c*12.92f,c<=0.0031308f);}
static float3 decodeSRGB(float3 c){c=saturate(c);return select(pow((c+0.055f)/1.055f,2.4f),c/12.92f,c<=0.04045f);}
static float3 readEncoded(texture2d<float,access::sample>source,float2 uv,uint flags){float3 c=saturate(source.sample(linearClamp,uv).rgb);return (flags&1u)?encodeSRGB(c):c;}
static void writeEncoded(texture2d<float,access::write>target,float3 c,float alpha,uint2 at,uint flags){target.write(float4((flags&2u)?decodeSRGB(c):c,alpha),at);}
// BT.709 4:2:0; one thread writes a 2x2 luma block and its chroma sample.
kernel void rgbToYCbCr(texture2d<float,access::sample>source[[texture(0)]],texture2d<float,access::write>luma[[texture(1)]],texture2d<float,access::write>chroma[[texture(2)]],constant Convert&p[[buffer(0)]],uint2 gid[[thread_position_in_grid]]){
  const uint2 size=uint2(luma.get_width(),luma.get_height());if(gid.x*2>=size.x||gid.y*2>=size.y)return;
  float3 sum=0;
  for(uint i=0;i<4;++i){const uint2 at=gid*2+uint2(i&1u,i>>1);const float3 rgb=readEncoded(source,(float2(min(at,size-1))+0.5f)/float2(size),p.flags);sum+=rgb;
    const float y=dot(rgb,float3(0.2126f,0.7152f,0.0722f));if(at.x<size.x&&at.y<size.y)luma.write(float4(p.fullRange?y:(16.0f+219.0f*y)/255.0f),at);}
  const float3 rgb=sum*0.25f;const float y=dot(rgb,float3(0.2126f,0.7152f,0.0722f));const float2 c=float2((rgb.b-y)/1.8556f,(rgb.r-y)/1.5748f);
  chroma.write(float4(p.fullRange?c+0.5f:(128.0f+224.0f*c)/255.0f,0,0),gid);
}
kernel void yCbCrToRGB(texture2d<float,access::sample>luma[[texture(0)]],texture2d<float,access::sample>chroma[[texture(1)]],texture2d<float,access::write>output[[texture(2)]],constant Convert&p[[buffer(0)]],uint2 gid[[thread_position_in_grid]]){
  if(gid.x>=output.get_width()||gid.y>=output.get_height())return;
  const float2 uv=(float2(gid)+0.5f)/float2(output.get_width(),output.get_height());
  float y=luma.sample(linearClamp,uv).r;float2 c=chroma.sample(linearClamp,uv).rg;
  if(p.fullRange)c-=0.5f;else{y=(y*255.0f-16.0f)/219.0f;c=(c*255.0f-128.0f)/224.0f;}
  writeEncoded(output,saturate(float3(y+1.5748f*c.y,y-0.18732f*c.x-0.46812f*c.y,y+1.8556f*c.x)),1,gid,p.flags);
}
kernel void resampleRGB(texture2d<float,access::sample>source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],constant Convert&p[[buffer(0)]],uint2 gid[[thread_position_in_grid]]){
  if(gid.x>=target.get_width()||gid.y>=target.get_height())return;
  writeEncoded(target,readEncoded(source,(float2(gid)+0.5f)/float2(target.get_width(),target.get_height()),p.flags),1,gid,p.flags);
}
kernel void lumaFromRGB(texture2d<float,access::sample>source[[texture(0)]],texture2d<float,access::write>target[[texture(1)]],constant Convert&p[[buffer(0)]],uint2 gid[[thread_position_in_grid]]){
  if(gid.x>=target.get_width()||gid.y>=target.get_height())return;
  target.write(float4(dot(readEncoded(source,(float2(gid)+0.5f)/float2(target.get_width(),target.get_height()),p.flags),float3(0.2126f,0.7152f,0.0722f))),gid);
}
// One block vector per field texel, expanded to a dense per-pixel field. The
// coverage excludes the estimator's padding past the frame.
kernel void expandMotion(texture2d<float,access::sample>blocks[[texture(0)]],texture2d<float,access::write>motion[[texture(1)]],constant Convert&p[[buffer(0)]],device const uint*valid[[buffer(1)]],uint2 gid[[thread_position_in_grid]]){
  if(gid.x>=motion.get_width()||gid.y>=motion.get_height())return;
  const float2 uv=(float2(gid)+0.5f)/float2(motion.get_width(),motion.get_height())*p.coverage;
  motion.write(valid[0]?float4(blocks.sample(linearClamp,uv).rg*p.vectorScale,0,0):float4(0),gid);
}
kernel void fillDepth(texture2d<float,access::write>depth[[texture(0)]],uint2 gid[[thread_position_in_grid]]){
  if(gid.x<depth.get_width()&&gid.y<depth.get_height())depth.write(float4(1),gid);
}
// Builds the image at t between prev and next. forward carries prev to next
// motion and backward next to prev, in flow-texture pixels after gain. A side
// is trusted where its vector survives a round trip through the other field.
// Without valid flow the pair is blended.
kernel void flowInterpolate(texture2d<float,access::sample>prev[[texture(0)]],texture2d<float,access::sample>next[[texture(1)]],texture2d<float,access::sample>forward[[texture(2)]],texture2d<float,access::sample>backward[[texture(3)]],texture2d<float,access::write>output[[texture(4)]],constant FlowParams&params[[buffer(0)]],device const uint*valid[[buffer(1)]],uint2 gid[[thread_position_in_grid]]){
  const uint width=output.get_width(),height=output.get_height();if(gid.x>=width||gid.y>=height)return;
  const float2 uv=(float2(gid)+0.5f)/float2(width,height);const float t=params.t;
  const float4 blended=mix(prev.sample(linearClamp,uv),next.sample(linearClamp,uv),t);
  if(!valid[0]){output.write(blended,gid);return;}
  const float2 flowSize=float2(forward.get_width(),forward.get_height());
  const float2 f=forward.sample(linearClamp,uv).rg*params.gain,b=backward.sample(linearClamp,uv).rg*params.gain;
  const float2 uvA=uv-f*t/flowSize,uvB=uv-b*(1.0f-t)/flowSize;
  const float2 fA=forward.sample(linearClamp,uvA).rg*params.gain,bA=backward.sample(linearClamp,uvA+fA/flowSize).rg*params.gain;
  const float2 bB=backward.sample(linearClamp,uvB).rg*params.gain,fB=forward.sample(linearClamp,uvB+bB/flowSize).rg*params.gain;
  // Large motion is allowed a proportionally larger round-trip error.
  const float toleranceA=params.consistency+0.08f*length(fA),toleranceB=params.consistency+0.08f*length(bB);
  const float confA=1.0f-smoothstep(toleranceA,toleranceA*4.0f,length(fA+bA)),confB=1.0f-smoothstep(toleranceB,toleranceB*4.0f,length(bB+fB));
  const float4 cA=prev.sample(linearClamp,clamp(uvA,0.0f,1.0f)),cB=next.sample(linearClamp,clamp(uvB,0.0f,1.0f));
  const float weightA=(1.0f-t)*confA,weightB=t*confB,weightSum=weightA+weightB;
  const float4 warped=weightSum>1e-4f?(cA*weightA+cB*weightB)/weightSum:mix(cA,cB,t);
  float reliability=max(confA,confB);
  if(params.colorTolerance>0.0f){
    // Neighbourhoods rather than single texels keep one decision across a badly tracked object.
    const float2 taps[5]={float2(0,0),float2(2,0),float2(-2,0),float2(0,2),float2(0,-2)};float colorError=0.0f;
    for(int i=0;i<5;++i){const float2 d=taps[i]/flowSize;colorError+=length(prev.sample(linearClamp,uvA+d).rgb-next.sample(linearClamp,uvB+d).rgb);}
    reliability*=1.0f-smoothstep(params.colorTolerance,params.colorTolerance*3.0f,colorError*0.2f);
  }
  output.write(mix(blended,warped,reliability),gid);
}
)MSL";
}
