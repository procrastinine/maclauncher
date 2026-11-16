// Copyright (c) MacLauncher contributors. MIT license.
#include <metal_stdlib>
using namespace metal;
struct Inputs {uint width,height,rw,rh,dx,dy,mx,my,encoding,bottomLeft,ui,premultiplied,sourceSrgb,outputSrgb;float white;};
float3 pqEncode(float3 v,float white){float3 p=pow(clamp(v*white/10000.f,0.f,1.f),float3(2610.f/16384.f));return pow((3424.f/4096.f+2413.f/128.f*p)/(1.f+2392.f/128.f*p),float3(2523.f/32.f));}
float3 pqDecode(float3 v,float white){float3 p=pow(clamp(v,0.f,1.f),float3(32.f/2523.f));return pow(max(p-3424.f/4096.f,0.f)/max(2413.f/128.f-2392.f/128.f*p,1.e-7f),float3(16384.f/2610.f))*10000.f/white;}
float3 srgbDecode(float3 v){return select(pow((max(v,0.f)+.055f)/1.055f,float3(2.4f)),v/12.92f,v<=.04045f);}
float3 srgbEncode(float3 v){return select(1.055f*pow(max(v,0.f),float3(1.f/2.4f))-.055f,12.92f*v,v<=.0031308f);}
kernel void anrImport(texture2d<float,access::read>color[[texture(0)]],texture2d<float,access::read>depth[[texture(1)]],texture2d<float,access::read>motion[[texture(2)]],texture2d<float,access::write>c[[texture(3)]],texture2d<float,access::write>d[[texture(4)]],texture2d<float,access::write>m[[texture(5)]],constant Inputs&p[[buffer(0)]],uint2 xy[[thread_position_in_grid]]){
 if(any(xy>=uint2(p.width,p.height)))return;
 uint2 src=xy;if(p.bottomLeft)src.y=p.height-1-src.y;
 float3 rgb=color.read(src).rgb;if(p.encoding==0&&!p.sourceSrgb)rgb=srgbDecode(rgb);if(p.encoding!=1)rgb=pqEncode(rgb,p.white);c.write(float4(rgb,1),xy);
 uint2 low=min(uint2((float2(xy)+.5f)*float2(p.rw,p.rh)/float2(p.width,p.height)),uint2(p.rw-1,p.rh-1));if(p.bottomLeft)low.y=p.rh-1-low.y;
 d.write(depth.read(low+uint2(p.dx,p.dy)),xy);float2 flow=motion.read(low+uint2(p.mx,p.my)).xy;if(p.bottomLeft)flow.y=-flow.y;m.write(float4(flow,0,0),xy);
}
kernel void anrExport(texture2d<float,access::read>generated[[texture(0)]],texture2d<float,access::write>output[[texture(1)]],texture2d<float,access::read>ui[[texture(2)]],constant Inputs&p[[buffer(0)]],uint2 xy[[thread_position_in_grid]]){
 if(any(xy>=uint2(p.width,p.height)))return;uint2 dst=xy;if(p.bottomLeft)dst.y=p.height-1-dst.y;
 float3 rgb=generated.read(xy).rgb;if(p.encoding!=1){rgb=pqDecode(rgb,p.white);if(p.encoding==0&&!p.outputSrgb)rgb=srgbEncode(rgb);}
 if(p.ui){float4 overlay=ui.read(dst);float a=clamp(overlay.a,0.f,1.f);rgb=(p.premultiplied?overlay.rgb:overlay.rgb*a)+rgb*(1-a);}
 output.write(float4(rgb,1),dst);
}
kernel void anrImportDepth(texture2d<float,access::read>color[[texture(0)]],depth2d<float,access::sample>depth[[texture(1)]],texture2d<float,access::read>motion[[texture(2)]],texture2d<float,access::write>c[[texture(3)]],texture2d<float,access::write>d[[texture(4)]],texture2d<float,access::write>m[[texture(5)]],constant Inputs&p[[buffer(0)]],uint2 xy[[thread_position_in_grid]]){
 if(any(xy>=uint2(p.width,p.height)))return;
 uint2 src=xy;if(p.bottomLeft)src.y=p.height-1-src.y;
 float3 rgb=color.read(src).rgb;if(p.encoding==0&&!p.sourceSrgb)rgb=srgbDecode(rgb);if(p.encoding!=1)rgb=pqEncode(rgb,p.white);c.write(float4(rgb,1),xy);
 uint2 low=min(uint2((float2(xy)+.5f)*float2(p.rw,p.rh)/float2(p.width,p.height)),uint2(p.rw-1,p.rh-1));if(p.bottomLeft)low.y=p.rh-1-low.y;
 constexpr sampler nearest(coord::pixel,address::clamp_to_edge,filter::nearest);d.write(float4(depth.sample(nearest,float2(low+uint2(p.dx,p.dy))+.5f),0,0,0),xy);float2 flow=motion.read(low+uint2(p.mx,p.my)).xy;if(p.bottomLeft)flow.y=-flow.y;m.write(float4(flow,0,0),xy);
}
