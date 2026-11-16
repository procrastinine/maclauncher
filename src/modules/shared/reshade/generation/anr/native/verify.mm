// Copyright (c) MacLauncher contributors. MIT license.
// Reference verification for user-side installation; no kit executable is run.
#include "anr_runtime.h"
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
static void need(bool ok,const std::string&why){if(!ok)throw std::runtime_error(why);}
static NSData*read(const std::string&p){auto d=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:p.c_str()]];need(d!=nil,"Missing reference input");return d;}
int main(int argc,char**argv){@autoreleasepool{try{
 need(argc==6,"usage: anr-verify runtime inputs reference phase bar");
 const double phase=std::stod(argv[4]),bar=std::stod(argv[5]);need(std::isfinite(phase)&&phase>0&&phase<1&&std::isfinite(bar)&&bar>0,"Invalid reference threshold");
 auto device=MTLCreateSystemDefaultDevice();need(device!=nil,"No Metal device");
 anr::Runtime runtime(device,argv[1]);std::string error;need(runtime.initialize(error),error);
 const auto w=runtime.width(),h=runtime.height();
 auto texture=[&](MTLPixelFormat format){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;d.storageMode=MTLStorageModeShared;auto t=[device newTextureWithDescriptor:d];need(t!=nil,"Reference image allocation failed");return t;};
 auto color=texture(MTLPixelFormatRGB10A2Unorm),depth=texture(MTLPixelFormatR32Float),motion=texture(MTLPixelFormatRG16Float),output=texture(MTLPixelFormatRGB10A2Unorm);
 const std::string inputs=argv[2];auto upload=[&](id<MTLTexture>t,const char*name){auto d=read(inputs+"/"+name);need(d.length==size_t(w)*h*4,"Reference image extent mismatch");[t replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:d.bytes bytesPerRow:w*4];};
 auto queue=[device newCommandQueue];need(queue!=nil,"Reference queue unavailable");
 for(unsigned frame=0;frame<2;frame++){
  upload(color,frame?"color1.bin":"color0.bin");upload(depth,frame?"depth1.bin":"depth0.bin");upload(motion,frame?"motion10.bin":"motion0.bin");
  auto constants=read(inputs+(frame?"/frame.bin":"/frame0.bin"));need(constants.length==204,"Invalid reference constants");
  auto commands=[queue commandBuffer];need(runtime.encode_pair_classic(commands,color,depth,motion,constants.bytes,constants.length,error),error);
  if(frame)need(runtime.encode_interpolation_classic(commands,phase,output,error),error);
  [commands commit];[commands waitUntilCompleted];need(commands.status==MTLCommandBufferStatusCompleted,"Reference GPU command failed");if(!frame)runtime.swap_history();
 }
 auto reference=read(argv[3]);need(reference.length==size_t(w)*h*4,"Invalid reference size");auto generated=[NSMutableData dataWithLength:reference.length];
 [output getBytes:generated.mutableBytes bytesPerRow:w*4 fromRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0];
 auto a=(const uint32_t*)generated.bytes,b=(const uint32_t*)reference.bytes;double squared=0;
 for(size_t i=0;i<size_t(w)*h;i++)for(unsigned shift:{0u,10u,20u}){const double delta=int((a[i]>>shift)&1023)-int((b[i]>>shift)&1023);squared+=delta*delta;}
 const double rmse=std::sqrt(squared/(double(w)*h*3)),db=rmse?20*std::log10(1023/rmse):999;
 need(db>=bar,"Prepared ANR runtime failed reference parity");printf("{\"verified\":true,\"width\":%u,\"height\":%u,\"phase\":%.9g,\"psnr\":%.9g,\"bar\":%.9g}\n",w,h,phase,db,bar);return 0;
}catch(const std::exception&e){fprintf(stderr,"ANR verification: %s\n",e.what());return 1;}}}
