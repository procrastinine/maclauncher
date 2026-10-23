#include "../src/modules/shared/reshade/temporal/frame.h"
#include "../src/modules/shared/reshade/temporal/camera.h"
#ifdef CAMERA_TEST_PROVIDER
static RSTemporalFrame captured;
static unsigned calls;
static int encode(const RSTemporalFrame *frame, RSTemporalResult *result) {
    captured=*frame;++calls;result->status=RS_TEMPORAL_OK;result->encoded=1;return RS_TEMPORAL_OK;
}
static void release(void *) {}
extern "C" const RSTemporalProvider *rsGetTemporalProvider(uint32_t version) {
    static const RSTemporalProvider provider={sizeof(provider),1,(1<<2)|(1<<3),0,encode,release};
    return version==1?&provider:nullptr;
}
extern "C" const RSTemporalFrame *cameraTestCaptured(){return &captured;}
extern "C" unsigned cameraTestCalls(){return calls;}
#else
#import <Metal/Metal.h>
#import <MetalFX/MetalFX.h>
#include <dlfcn.h>
#include <fstream>
#include <thread>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
static void check(bool value,const char *reason){if(!value){fprintf(stderr,"%s\n",reason);exit(1);}}
// graphics-camera-metal <graphics library> <test provider> <control file>
int main(int argc,char **argv){@autoreleasepool{
    if(argc!=4)return 2;
    setenv("RESHADE_TEMPORAL_CONTROL_FILE",argv[3],1);
    setenv("RESHADE_FSR2_LIBRARY",argv[2],1);setenv("RESHADE_FSR3_LIBRARY",argv[2],1);
    auto controls=[&](unsigned method){
        struct Packet{char magic[8];uint32_t method;float sharpness;uint32_t flags,reserved;};
        Packet p{};memcpy(p.magic,"MLTMCTL1",8);p.method=method;p.sharpness=.5f;
        {std::ofstream file(argv[3],std::ios::binary);file.write((const char*)&p,sizeof(p));}
        std::this_thread::sleep_for(std::chrono::milliseconds(110));
    };
    controls(2);
    auto provider=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL),library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    check(provider&&library,dlerror()?:"Missing libraries");
    auto captured=(const RSTemporalFrame*(*)())dlsym(provider,"cameraTestCaptured");
    auto calls=(unsigned(*)())dlsym(provider,"cameraTestCalls");
    auto set=(decltype(&rsSetTemporalCamera))dlsym(library,"rsSetTemporalCamera");
    auto setTextures=(decltype(&rsSetTemporalCameraForTextures))dlsym(library,"rsSetTemporalCameraForTextures");
    auto clear=(decltype(&rsClearTemporalCameraTextures))dlsym(library,"rsClearTemporalCameraTextures");
    check(set&&setTextures&&clear&&captured&&calls,"Missing camera API");
    auto device=MTLCreateSystemDefaultDevice();check(device,"No Metal device");auto queue=[device newCommandQueue];
    auto descriptor=[MTLFXTemporalScalerDescriptor new];descriptor.inputWidth=64;descriptor.inputHeight=48;descriptor.outputWidth=128;descriptor.outputHeight=96;
    descriptor.colorTextureFormat=descriptor.outputTextureFormat=MTLPixelFormatRGBA16Float;descriptor.depthTextureFormat=MTLPixelFormatR32Float;descriptor.motionTextureFormat=MTLPixelFormatRG16Float;
    auto scaler=[descriptor newTemporalScalerWithDevice:device];check(scaler,"No temporal scaler");
    auto texture=[&](MTLPixelFormat format,unsigned w,unsigned h,MTLTextureUsage usage){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];d.usage=usage;return [device newTextureWithDescriptor:d];};
    auto color=texture(MTLPixelFormatRGBA16Float,64,48,scaler.colorTextureUsage),depth=texture(MTLPixelFormatR32Float,64,48,scaler.depthTextureUsage),motion=texture(MTLPixelFormatRG16Float,64,48,scaler.motionTextureUsage);
    auto otherMotion=texture(MTLPixelFormatRG16Float,64,48,scaler.motionTextureUsage);
    scaler.colorTexture=color;scaler.depthTexture=depth;scaler.motionTexture=motion;scaler.outputTexture=texture(MTLPixelFormatRGBA16Float,128,96,scaler.outputTextureUsage);
    scaler.preExposure=1;scaler.reset=NO;scaler.depthReversed=NO;scaler.motionVectorScaleX=scaler.motionVectorScaleY=1;scaler.inputContentWidth=64;scaler.inputContentHeight=48;
    const auto s=(__bridge void*)scaler,c=(__bridge void*)color,d=(__bridge void*)depth,m=(__bridge void*)motion;
    RSTemporalCamera camera{};camera.size=sizeof(camera);camera.version=1;camera.frameId=1;camera.viewportId=17;camera.nearPlane=.2;camera.farPlane=450;camera.verticalFov=1.1;camera.frameTimeMs=12.5;camera.flags=RS_TEMPORAL_HDR;
    auto submit=[&](id<MTLCommandBuffer> cb,bool hasCamera){
        unsigned before=calls();[scaler encodeToCommandBuffer:cb];
        check(cb.status<MTLCommandBufferStatusCommitted,"Camera integration submitted application commands");
        check(calls()==before+1,"Provider did not receive the frame");
        if(bool(captured()->flags&RS_TEMPORAL_CAMERA_VALID)!=hasCamera)fprintf(stderr,"call=%u expected-camera=%u flags=%u\n",calls(),hasCamera,captured()->flags);
        check(bool(captured()->flags&RS_TEMPORAL_CAMERA_VALID)==hasCamera,"Camera data leaked or was lost");
        [cb commit];[cb waitUntilCompleted];check(!cb.error,"GPU error");
    };
    auto cb=[queue commandBuffer];check(set(s,(__bridge void*)cb,&camera)==0,"Direct registration failed");submit(cb,true);
    check(captured()->nearPlane==camera.nearPlane&&captured()->farPlane==camera.farPlane&&captured()->verticalFov==camera.verticalFov&&captured()->frameTimeMs==camera.frameTimeMs,"Camera values changed");
    cb=[queue commandBuffer];camera.frameId=2;check(set(s,(__bridge void*)cb,&camera)==0,"Second camera failed");submit(cb,true);check(!(captured()->flags&RS_TEMPORAL_RESET),"Continuous camera reset history");
    cb=[queue commandBuffer];camera.frameId=4;check(set(s,(__bridge void*)cb,&camera)==0,"Skipped frame registration failed");submit(cb,true);check(captured()->flags&RS_TEMPORAL_RESET,"Skipped frame did not reset");
    cb=[queue commandBuffer];camera.frameId=5;++camera.viewportId;check(set(s,(__bridge void*)cb,&camera)==0,"Viewport registration failed");submit(cb,true);check(captured()->flags&RS_TEMPORAL_RESET,"Viewport change did not reset");
    submit([queue commandBuffer],false);
    auto discarded=[queue commandBuffer];check(set(s,(__bridge void*)discarded,&camera)==0,"Discard registration failed");submit([queue commandBuffer],false);submit(discarded,false);
    cb=[queue commandBuffer];check(set(s,(__bridge void*)cb,&camera)==0,"Duplicate registration failed");check(set(s,(__bridge void*)cb,&camera)==RS_TEMPORAL_BUSY,"Duplicate camera accepted");submit(cb,false);
    cb=[queue commandBuffer];auto invalid=camera;invalid.nearPlane=0;check(set(s,(__bridge void*)cb,&invalid)==RS_TEMPORAL_INVALID,"Zero near plane accepted");
    invalid=camera;invalid.farPlane=invalid.nearPlane;check(set(s,(__bridge void*)cb,&invalid)==RS_TEMPORAL_INVALID,"Invalid far plane accepted");
    invalid=camera;invalid.verticalFov=NAN;check(set(s,(__bridge void*)cb,&invalid)==RS_TEMPORAL_INVALID,"Invalid FOV accepted");
    invalid=camera;invalid.reserved2[0]=1;check(set(s,(__bridge void*)cb,&invalid)==RS_TEMPORAL_INVALID,"Reserved field accepted");
    check(set(s,(__bridge void*)discarded,&camera)==RS_TEMPORAL_INVALID,"Committed commands accepted");
    camera.flags|=RS_TEMPORAL_DEPTH_REVERSED;check(set(s,(__bridge void*)cb,&camera)==0,"Reverse Z registration failed");submit(cb,false);camera.flags&=~RS_TEMPORAL_DEPTH_REVERSED;
    int owner=0,otherOwner=0;
    check(setTextures(&owner,c,d,m,&camera)==0,"Texture registration failed");submit([queue commandBuffer],true);submit([queue commandBuffer],false);
    check(setTextures(&owner,c,d,(__bridge void*)otherMotion,&camera)==0,"Different texture registration failed");submit([queue commandBuffer],false);clear(&owner);
    check(setTextures(&owner,c,d,m,&camera)==0,"Collision setup failed");check(setTextures(&otherOwner,c,d,m,&camera)==RS_TEMPORAL_BUSY,"Ambiguous cameras accepted");
    check(setTextures(&owner,c,d,m,&camera)==RS_TEMPORAL_BUSY,"Collision was overwritten");submit([queue commandBuffer],false);clear(&owner);
    check(setTextures(&owner,c,d,m,&camera)==0,"Frame boundary did not clear collision");clear(&owner);submit([queue commandBuffer],false);
    auto arrayDescriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRG16Float width:64 height:48 mipmapped:NO];
    arrayDescriptor.textureType=MTLTextureType2DArray;arrayDescriptor.arrayLength=2;
    auto arrayTexture=[device newTextureWithDescriptor:arrayDescriptor];
    check(setTextures(&owner,c,d,m,&camera)==0,"Invalid replacement setup failed");
    check(setTextures(&owner,c,d,(__bridge void*)arrayTexture,&camera)==RS_TEMPORAL_INVALID,"Array texture accepted");submit([queue commandBuffer],false);
    controls(0);cb=[queue commandBuffer];check(set(s,(__bridge void*)cb,&camera)==0,"Default camera registration failed");check(setTextures(&owner,c,d,m,&camera)==0,"Default texture registration failed");
    unsigned before=calls();[scaler encodeToCommandBuffer:cb];[cb commit];[cb waitUntilCompleted];check(!cb.error&&calls()==before,"Game default was replaced");
    controls(3);submit([queue commandBuffer],false);
    clear(&owner);unlink(argv[3]);puts("Camera identity, validation, one-shot lifetime, collisions, history reset and Game default consumption passed.");
}}
#endif
