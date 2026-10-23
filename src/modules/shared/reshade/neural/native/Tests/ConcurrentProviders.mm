#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#import <CommonCrypto/CommonDigest.h>
#include "maclauncher-neural.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <dlfcn.h>
#include <string>
#include <vector>

namespace {
struct Completion {
  dispatch_semaphore_t ready=dispatch_semaphore_create(0);
  std::atomic<unsigned> calls{0};int status=-999;std::string message;
};
void completed(void *context,int status,const char *message) {
  auto &value=*static_cast<Completion*>(context);assert(value.calls.fetch_add(1)==0);
  value.status=status;value.message=message?message:"";dispatch_semaphore_signal(value.ready);
}
CVPixelBufferRef buffer(size_t width,size_t height) {
  CVPixelBufferRef result=nullptr;
  auto attributes=@{(__bridge NSString*)kCVPixelBufferMetalCompatibilityKey:@YES,(__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey:@{}};
  assert(CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,(__bridge CFDictionaryRef)attributes,&result)==kCVReturnSuccess);
  return result;
}
std::vector<unsigned char> rows(CVPixelBufferRef image) {
  assert(CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly)==kCVReturnSuccess);
  const auto bytes=static_cast<const unsigned char*>(CVPixelBufferGetBaseAddress(image));
  const auto width=CVPixelBufferGetWidth(image),height=CVPixelBufferGetHeight(image),stride=CVPixelBufferGetBytesPerRow(image);
  std::vector<unsigned char> result(width*height*4);
  for(size_t y=0;y<height;++y)memcpy(result.data()+y*width*4,bytes+y*stride,width*4);
  CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);return result;
}
NSString *hash(const std::vector<unsigned char>&value) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];CC_SHA256(value.data(),CC_LONG(value.size()),digest);
  NSMutableString *result=[NSMutableString string];for(auto byte:digest)[result appendFormat:@"%02x",byte];return result;
}
void report(NSDictionary *value) {
  auto data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];assert(data);
  fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);
}
}

int main(int argc,char **argv) {@autoreleasepool {
  if(argc!=3){std::fprintf(stderr,"Usage: concurrent-neural-providers LIBRARY MODEL\n");return 2;}
  auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::fprintf(stderr,"%s\n",dlerror());return 2;}
  const auto create=reinterpret_cast<decltype(&ml_neural_create_with_options)>(dlsym(library,"ml_neural_create_with_options"));
  const auto submit=reinterpret_cast<decltype(&ml_neural_submit)>(dlsym(library,"ml_neural_submit"));
  const auto destroy=reinterpret_cast<decltype(&ml_neural_destroy)>(dlsym(library,"ml_neural_destroy"));assert(create&&submit&&destroy);
  const auto device=MTLCreateSystemDefaultDevice();const auto queue=[device newCommandQueue];assert(device&&queue);
  constexpr size_t width=13,height=7;CVPixelBufferRef source=buffer(width,height),destinations[2]={buffer(width,height),buffer(width,height)};
  assert(CVPixelBufferLockBaseAddress(source,0)==kCVReturnSuccess);
  auto pixels=static_cast<unsigned char*>(CVPixelBufferGetBaseAddress(source));const auto stride=CVPixelBufferGetBytesPerRow(source);
  for(size_t y=0;y<height;++y)for(size_t x=0;x<width;++x){auto *p=pixels+y*stride+x*4;p[0]=(x*19+y*5)%256;p[1]=(x*7+y*31)%256;p[2]=(x*13+y*17)%256;p[3]=255;}
  CVPixelBufferUnlockBaseAddress(source,0);
  auto texture=[&](CVPixelBufferRef image){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    return [device newTextureWithDescriptor:descriptor iosurface:CVPixelBufferGetIOSurface(image)plane:0];};
  const auto input=texture(source);id<MTLTexture> outputs[2]={texture(destinations[0]),texture(destinations[1])};assert(input&&outputs[0]&&outputs[1]);
  char error[4096]={0};MLNeuralProvider owners[2]={create(argv[2],1,0,error,sizeof(error)),nullptr};assert(owners[0]);
  owners[1]=create(argv[2],1,0,error,sizeof(error));assert(owners[1]);
  std::vector<unsigned char> previous;
  for(unsigned round=0;round<3;++round){@autoreleasepool {
    if(round==1){assert(CVPixelBufferLockBaseAddress(source,0)==kCVReturnSuccess);static_cast<unsigned char*>(CVPixelBufferGetBaseAddress(source))[0]^=63;CVPixelBufferUnlockBaseAddress(source,0);}
    const auto original=rows(source);const auto start=std::chrono::steady_clock::now();Completion results[2];
    id<MTLSharedEvent> events[2]={[device newSharedEvent],[device newSharedEvent]};assert(events[0]&&events[1]);
    auto commands=[queue commandBuffer];auto blit=[commands blitCommandEncoder];assert(commands&&blit);
    for(unsigned owner=0;owner<2;++owner)[blit copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)sourceSize:MTLSizeMake(width,height,1)toTexture:outputs[owner]destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
    [blit endEncoding];
    for(unsigned owner=0;owner<2;++owner)[commands encodeSignalEvent:events[owner]value:1];
    for(unsigned owner=0;owner<2;++owner)[commands encodeWaitForEvent:events[owner]value:2];
    // Both accepted owners wait on the same producer boundary. Neither is
    // serialized behind the other's callback or source completion.
    for(unsigned owner=0;owner<2;++owner)assert(submit(owners[owner],source,destinations[owner],(__bridge const void*)events[owner],1,2,1+round*4,round==0,completed,&results[owner])==ML_NEURAL_RENDERED);
    auto gpuDone=dispatch_semaphore_create(0);[commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(gpuDone);}];
    [commands commit];
    const auto deadline=dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC);
    for(unsigned owner=0;owner<2;++owner)if(dispatch_semaphore_wait(results[owner].ready,deadline)){
      report(@{@"type":@"timeout",@"round":@(round),@"waitingProvider":@(owner),@"commandStatus":@(commands.status),@"eventValues":@[@(events[0].signaledValue),@(events[1].signaledValue)],@"enteredCallbacks":@[@(results[0].calls.load()),@(results[1].calls.load())]});
      std::fprintf(stderr,"Provider completion timed out\n");std::_Exit(2);}
    if(dispatch_semaphore_wait(gpuDone,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))){std::fprintf(stderr,"Caller GPU completion timed out\n");std::_Exit(2);}
    assert(commands.status==MTLCommandBufferStatusCompleted&&rows(source)==original);
    const auto a=rows(destinations[0]),b=rows(destinations[1]);assert(a==b);size_t changed=0;
    for(size_t i=0;i<a.size();++i)if(i%4==3)assert(a[i]==original[i]);else changed+=a[i]!=original[i];assert(changed>0);
    for(unsigned owner=0;owner<2;++owner){assert(results[owner].calls.load()==1&&results[owner].status==ML_NEURAL_RENDERED&&events[owner].signaledValue>=2);
      assert(round==2?results[owner].message=="Exact-frame cache":results[owner].message.empty());}
    if(round==2)assert(a==previous);previous=a;
    const auto elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    report(@{@"type":@"round",@"round":@(round),@"frameId":@(1+round*4),@"providers":@2,@"width":@(width),@"height":@(height),@"statuses":@[@(results[0].status),@(results[1].status)],@"callbackCounts":@[@(results[0].calls.load()),@(results[1].calls.load())],@"equalOutputs":@YES,@"sourceUnchanged":@YES,@"alphaPreserved":@YES,@"changedRGBComponents":@(changed),@"outputSHA256":hash(a),@"cached":@(round==2),@"elapsedMilliseconds":@(elapsed)});
  }}
  for(auto owner:owners)destroy(owner);for(auto image:destinations)CVPixelBufferRelease(image);CVPixelBufferRelease(source);
  report(@{@"type":@"complete",@"device":device.name,@"providers":@2,@"realInferences":@4,@"cacheReuses":@2,@"syntheticInput":@YES,@"gameQualityQualified":@NO});
  // Keep the library resident until process exit: destruction is asynchronous.
  return 0;
}}
