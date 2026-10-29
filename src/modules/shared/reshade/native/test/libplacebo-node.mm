// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "fixture-files.hpp"
#import <Metal/Metal.h>
#if defined(MACFX_LIBPLACEBO_TESTING)
#include <libplacebo-node.mm>
#else
#include "libplacebo-node.hpp"
#endif
#include <cassert>
#include <cstdio>
#include <memory>
#include <vector>
#include <unistd.h>
namespace {
using namespace macfx;
NSMutableArray *retainedCommands;
id<MTLTexture> texture(id<MTLDevice> device,unsigned width,unsigned height,MTLPixelFormat format=MTLPixelFormatRGBA8Unorm){auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];desc.storageMode=MTLStorageModePrivate;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;return [device newTextureWithDescriptor:desc];}
std::vector<uint8_t> run(ShaderNode &node,id<MTLCommandQueue> queue,unsigned width,unsigned height,float gain,FrameOrigin origin=FrameOrigin::TopLeft,float blue=1,MTLPixelFormat format=MTLPixelFormatRGBA8Unorm,bool asyncFailure=false,bool opaque=false){
 node.setParameters({{"Gain",{gain}},{"Blue",{blue}}});id<MTLTexture> source=texture(queue.device,width,height,format),target=texture(queue.device,width,height,format);
 std::vector<uint8_t> bytes(width*height*4);for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x){const auto p=(y*width+x)*4;bytes[p]=40+y;bytes[p+1]=80;bytes[p+2]=120;bytes[p+3]=opaque&&y<height/2?0:77;}
 if(format==MTLPixelFormatBGRA8Unorm)for(size_t i=0;i<bytes.size();i+=4)std::swap(bytes[i],bytes[i+2]);
 auto input=[queue.device newBufferWithBytes:bytes.data() length:bytes.size() options:MTLResourceStorageModeShared];auto output=[queue.device newBufferWithLength:bytes.size() options:MTLResourceStorageModeShared];auto commands=[queue commandBuffer];
 ShaderFrame frame;frame.commands=commands;frame.source=source;frame.target=target;frame.origin=origin;frame.frameId=3;frame.opaqueDisplay=opaque;auto result=node.prepare(frame);if(!result.encoded){fprintf(stderr,"prepare: %s\n",result.reason.c_str());_Exit(1);}assert(commands.status==MTLCommandBufferStatusNotEnqueued);
 auto upload=[commands blitCommandEncoder];[upload copyFromBuffer:input sourceOffset:0 sourceBytesPerRow:width*4 sourceBytesPerImage:bytes.size() sourceSize:MTLSizeMake(width,height,1) toTexture:source destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[upload endEncoding];
 result=node.encode(frame);if(!result.encoded){fprintf(stderr,"encode: %s\n",result.reason.c_str());_Exit(1);}
 auto download=[commands blitCommandEncoder];[download copyFromTexture:target sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1) toBuffer:output destinationOffset:0 destinationBytesPerRow:width*4 destinationBytesPerImage:bytes.size()];[download endEncoding];
#if defined(MACFX_LIBPLACEBO_TESTING)
 if(asyncFailure)failNextAsyncWork=true;
#else
 assert(!asyncFailure);
#endif
 [commands commit];[commands waitUntilCompleted];if(commands.status!=MTLCommandBufferStatusCompleted){fprintf(stderr,"GPU: %s\n",commands.error.description.UTF8String);_Exit(1);}
 char error[256];memset(error,0x7f,sizeof(error));const int completion=rsLibplaceboNodeCompletion(&node,error,sizeof(error));
 if(asyncFailure){assert(completion!=0&&strstr(error,"Injected asynchronous shader failure"));char shortError[8];memset(shortError,0x7f,sizeof(shortError));assert(rsLibplaceboNodeCompletion(&node,shortError,sizeof(shortError))!=0&&shortError[7]==0);}
 else{if(completion)fprintf(stderr,"completion: %s\n",error);assert(completion==0&&error[0]==0);}
 [retainedCommands addObject:commands];memcpy(bytes.data(),output.contents,bytes.size());if(format==MTLPixelFormatBGRA8Unorm)for(size_t i=0;i<bytes.size();i+=4)std::swap(bytes[i],bytes[i+2]);return bytes;
}
std::vector<uint8_t> scale(const char *name,id<MTLCommandQueue> queue,unsigned width,unsigned height,bool sourceBGRA=false,bool targetBGRA=false){
 std::unique_ptr<ShaderNode> node(rsCreateLibplaceboScalerNode(name));assert(node);auto source=texture(queue.device,8,6,sourceBGRA?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm),target=texture(queue.device,width,height,targetBGRA?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm);std::vector<uint8_t> bytes(8*6*4);
 for(unsigned y=0;y<6;++y)for(unsigned x=0;x<8;++x){auto p=&bytes[(y*8+x)*4];p[0]=(x*43+y*17)%256;p[1]=(x+y)%2?220:20;p[2]=120;p[3]=77;}
 if(sourceBGRA)for(size_t i=0;i<bytes.size();i+=4)std::swap(bytes[i],bytes[i+2]);
 auto input=[queue.device newBufferWithBytes:bytes.data() length:bytes.size() options:MTLResourceStorageModeShared],output=[queue.device newBufferWithLength:width*height*4 options:MTLResourceStorageModeShared];auto commands=[queue commandBuffer];ShaderFrame frame;frame.commands=commands;frame.source=source;frame.target=target;frame.opaqueDisplay=false;
 auto ready=node->prepare(frame);if(!ready.encoded){fprintf(stderr,"filter %s: %s\n",name,ready.reason.c_str());_Exit(1);}assert(commands.status==MTLCommandBufferStatusNotEnqueued);
 auto upload=[commands blitCommandEncoder];[upload copyFromBuffer:input sourceOffset:0 sourceBytesPerRow:32 sourceBytesPerImage:bytes.size() sourceSize:MTLSizeMake(8,6,1) toTexture:source destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[upload endEncoding];ready=node->encode(frame);assert(ready.encoded);
 auto download=[commands blitCommandEncoder];[download copyFromTexture:target sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1) toBuffer:output destinationOffset:0 destinationBytesPerRow:width*4 destinationBytesPerImage:width*height*4];[download endEncoding];[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);char error[256];assert(rsLibplaceboNodeCompletion(node.get(),error,sizeof(error))==0&&error[0]==0);
 std::vector<uint8_t> result(width*height*4);memcpy(result.data(),output.contents,result.size());if(targetBGRA)for(size_t i=0;i<result.size();i+=4)std::swap(result[i],result[i+2]);for(size_t i=0;i<result.size();i+=4){assert(std::abs(int(result[i+2])-120)<=2);assert(std::abs(int(result[i+3])-77)<=2);}return result;
}
}
int main(){@autoreleasepool{retainedCommands=[NSMutableArray new];
 char scratch[1024];temporaryPath(scratch,"maclauncher-libplacebo-XXXXXX");assert(mkdtemp(scratch));NSString *directory=[NSString stringWithUTF8String:scratch],*path=[directory stringByAppendingPathComponent:@"effect.hook"];
 NSString *source=@"//!PARAM Gain\n//!DESC Red gain\n//!TYPE DYNAMIC float\n//!MINIMUM 0.0\n//!MAXIMUM 2.0\n1.0\n\n//!PARAM Blue\n//!TYPE CONSTANT float\n//!MINIMUM 0.25\n//!MAXIMUM 2.0\n1.0\n\n//!HOOK MAIN\n//!BIND HOOKED\n//!SAVE GAINED\nvec4 hook(){vec4 c=HOOKED_tex(HOOKED_pos);c.r*=Gain;return c;}\n\n//!HOOK MAIN\n//!BIND HOOKED\n//!BIND GAINED\nvec4 hook(){vec4 c=GAINED_tex(GAINED_pos);c.g=c.a-c.g;return c;}\n\n//!HOOK MAIN\n//!BIND HOOKED\n//!COMPUTE 8 8\nvoid hook(){ivec2 p=ivec2(gl_GlobalInvocationID.xy);if(any(greaterThanEqual(p,imageSize(out_image))))return;vec4 c=HOOKED_tex(HOOKED_map(p));c.b*=Blue;imageStore(out_image,p,c);}\n";
 assert(replaceFile([source dataUsingEncoding:NSUTF8StringEncoding],path));assert(rsLibplaceboNodeABI()==1);ShaderSpec spec;spec.selection.file=path.fileSystemRepresentation;std::unique_ptr<ShaderNode> node(rsCreateLibplaceboShaderNode(&spec));assert(node);
 auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(queue);auto a=run(*node,queue,16,8,2),b=run(*node,queue,24,12,.5),c=run(*node,queue,16,8,1,FrameOrigin::BottomLeft);
 printf("first=%u,%u,%u,%u resized=%u,%u,%u,%u flipped=%u,%u,%u,%u\n",a[0],a[1],a[2],a[3],b[0],b[1],b[2],b[3],c[0],c[1],c[2],c[3]);
 assert(std::abs(int(a[0])-80)<=2&&std::abs(int(a[1])-175)<=2&&std::abs(int(a[2])-120)<=2&&std::abs(int(a[3])-77)<=2);
 assert(std::abs(int(b[0])-20)<=2&&std::abs(int(b[1])-175)<=2&&std::abs(int(b[3])-77)<=2);assert(std::abs(int(c[0])-40)<=2);
 const ShaderParameters alternate{{"Gain",{.5f}},{"Blue",{1}}};
 std::unique_ptr<ShaderNode> parameterView(rsCloneLibplaceboShaderNode(node.get(),&alternate));assert(parameterView);
 auto acceptedParameters=run(*node,queue,16,8,2),candidateParameters=run(*parameterView,queue,16,8,.5),acceptedAgain=run(*node,queue,16,8,2);
 assert(std::abs(int(acceptedParameters[0])-80)<=2&&std::abs(int(candidateParameters[0])-20)<=2&&acceptedAgain==acceptedParameters);
 puts("independent dynamic parameter views preserve accepted controls");
 for(auto format:{MTLPixelFormatRGBA8Unorm,MTLPixelFormatBGRA8Unorm})for(auto origin:{FrameOrigin::TopLeft,FrameOrigin::BottomLeft}){
  auto pixels=run(*node,queue,16,8,2,origin,1,format,false,true);
  for(unsigned y=0;y<8;++y)for(unsigned x=0;x<16;++x){const size_t p=(y*16+x)*4;assert(std::abs(int(pixels[p])-int(2*(40+y)))<=2);assert(std::abs(int(pixels[p+1])-175)<=2);assert(std::abs(int(pixels[p+2])-120)<=2);assert(pixels[p+3]==255);}
 }
 puts("opaque display preserves complete RGB with unused zero-alpha background; transparent inputs preserve their alpha");
 // Abandoning an encoded buffer retires its notification without Vulkan work.
 @autoreleasepool{auto commands=[queue commandBuffer];ShaderFrame frame;frame.commands=commands;frame.source=texture(device,16,8);frame.target=texture(device,16,8);assert(node->encode(frame).encoded);commands=nil;}
 auto d=run(*node,queue,16,8,1);assert(std::abs(int(d[0])-40)<=2);
 auto e=run(*node,queue,16,8,1,FrameOrigin::TopLeft,.5);assert(std::abs(int(e[2])-60)<=2);
 bool rejected=false;try{node->setParameters({{"Gain",{1}},{"Blue",{-5}}});}catch(const std::exception&){rejected=true;}assert(rejected);
 const char *metadata=rsLibplaceboInspect(path.fileSystemRepresentation);assert(metadata&&strstr(metadata,"constant")&&strstr(metadata,"rgbCompatible"));
 for(unsigned i=0;i<10;++i){auto held=run(*node,queue,16,8,1);assert(std::abs(int(held[0])-40)<=2);}
 const char *catalog=rsLibplaceboFilters();assert(catalog);NSData *catalogData=[NSData dataWithBytes:catalog length:strlen(catalog)];NSDictionary *registry=[NSJSONSerialization JSONObjectWithData:catalogData options:0 error:nil];assert([registry[@"schema"]intValue]==1&&[registry[@"filters"]count]>20);
 for(NSDictionary *row in registry[@"filters"]){assert([row[@"name"]length]&&[row[@"label"]length]&&([row[@"upscale"]boolValue]||[row[@"downscale"]boolValue]));std::unique_ptr<ShaderNode> configured(rsCreateLibplaceboScalerNode([row[@"name"]UTF8String]));assert(configured);}
 assert(!rsCreateLibplaceboScalerNode("missing-filter"));
 for(auto size:{std::pair<unsigned,unsigned>{17,13},{3,2}}){
  std::vector<uint8_t> nearest(size.first*size.second*4);for(unsigned y=0;y<size.second;++y)for(unsigned x=0;x<size.first;++x){const unsigned sx=unsigned((x+.5)*8/size.first),sy=unsigned((y+.5)*6/size.second);auto p=&nearest[(y*size.first+x)*4];p[0]=(sx*43+sy*17)%256;p[1]=(sx+sy)%2?220:20;p[2]=120;p[3]=77;}
  for(const char *name:{"lanczos","ewa_lanczossharp","hermite"}){auto pixels=scale(name,queue,size.first,size.second);assert(pixels!=nearest);printf("built-in-filter=%s output=%ux%u alpha=preserved\n",name,size.first,size.second);}
 }
 auto nearest=scale("nearest",queue,16,12);assert(nearest.size()==16*12*4);
 auto canonical=scale("lanczos",queue,17,13);for(bool inputBGRA:{false,true})for(bool outputBGRA:{false,true}){assert(scale("lanczos",queue,17,13,inputBGRA,outputBGRA)==canonical);printf("original-filter-format=%s->%s RGB/alpha preserved\n",inputBGRA?"BGRA":"RGBA",outputBGRA?"BGRA":"RGBA");}
 auto bgraShader=run(*node,queue,16,8,2,FrameOrigin::TopLeft,1,MTLPixelFormatBGRA8Unorm);assert(std::abs(int(bgraShader[0])-80)<=2&&std::abs(int(bgraShader[2])-120)<=2&&std::abs(int(bgraShader[3])-77)<=2);
 {std::unique_ptr<ShaderNode> onlyUp(rsCreateLibplaceboScalerNode("nearest"));ShaderFrame frame;frame.commands=[queue commandBuffer];frame.source=texture(device,8,6);frame.target=texture(device,3,2);auto result=onlyUp->prepare(frame);assert(!result.encoded&&result.reason.find("scaling direction")!=std::string::npos);}
 const NSString *declarations=[source substringToIndex:[source rangeOfString:@"//!HOOK MAIN"].location];
 for(NSString *plane in @[@"LUMA",@"CHROMA"]){
  NSString *body=[plane isEqualToString:@"LUMA"]?@"vec4 hook(){return vec4(Gain*0.5,0.0,0.0,1.0);}":@"vec4 hook(){return vec4(0.5,0.5,0.0,1.0);}";
  NSString *planeSource=[declarations stringByAppendingFormat:@"//!HOOK %@\n//!BIND HOOKED\n%@\n",plane,body];
  assert(replaceFile([planeSource dataUsingEncoding:NSUTF8StringEncoding],path));
  std::unique_ptr<ShaderNode> derived(rsCreateLibplaceboShaderNode(&spec));assert(derived);
  const char *planeMetadata=rsLibplaceboInspect(path.fileSystemRepresentation);assert(planeMetadata&&strstr(planeMetadata,"derived-ycbcr444"));
  for(auto origin:{FrameOrigin::TopLeft,FrameOrigin::BottomLeft})for(auto size:{std::pair<unsigned,unsigned>{16,8},{23,11}}){
   auto pixels=run(*derived,queue,size.first,size.second,1,origin);
   for(size_t p=0;p<pixels.size();p+=4){assert(std::abs(int(pixels[p+3])-77)<=2);
    if([plane isEqualToString:@"CHROMA"])assert(std::abs(int(pixels[p])-pixels[p+1])<=2&&std::abs(int(pixels[p+1])-pixels[p+2])<=2);}
   if([plane isEqualToString:@"LUMA"]){auto changed=run(*derived,queue,size.first,size.second,1.5,origin);assert(std::abs(int(changed[0])-pixels[0])>20);}
   printf("derived-plane=%s output=%ux%u origin=%s alpha=preserved\n",plane.UTF8String,size.first,size.second,origin==FrameOrigin::TopLeft?"top":"bottom");
  }
 }
 assert(replaceFile([source dataUsingEncoding:NSUTF8StringEncoding],path));
#if defined(MACFX_LIBPLACEBO_TESTING)
 // Preparation and encode succeed. The real asynchronous worker then fails;
 // the GPU publishes exact passthrough, while this same frame reports failure
 // without depending on a subsequent frame's encode call.
 {std::unique_ptr<ShaderNode> failing(rsCreateLibplaceboShaderNode(&spec));assert(failing);auto pixels=run(*failing,queue,16,8,2,FrameOrigin::TopLeft,1,MTLPixelFormatRGBA8Unorm,true);
  for(unsigned y=0;y<8;++y)for(unsigned x=0;x<16;++x){const size_t p=(y*16+x)*4;assert(pixels[p]==40+y&&pixels[p+1]==80&&pixels[p+2]==120&&pixels[p+3]==77);}
  ShaderFrame next;next.commands=[queue commandBuffer];next.source=texture(device,16,8);next.target=texture(device,16,8);auto result=failing->encode(next);assert(!result.encoded&&!result.busy&&result.reason.find("Injected asynchronous shader failure")!=std::string::npos);
  puts("libplacebo asynchronous failure: same-frame error and repaired passthrough");}
#endif
 node.reset();[retainedCommands removeAllObjects];retainedCommands=nil;assert([[NSFileManager defaultManager] removeItemAtPath:directory error:nil]);puts("libplacebo shared-texture GPU: pass");return 0;
}}
