// Copyright (c) MacLauncher contributors. MIT license.
// Exercise the actual ScreenshotImage/FrameCapture readback and publication
// boundary with CPU Metal stand-ins. No GPU, queue, window or app is created.
#include "frame-capture.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <filesystem>
#include <fstream>
#include <thread>
#include <vector>
#include <unistd.h>
namespace {
void check(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
unsigned conversions=0,readbacks=0;bool failConversion=false;std::vector<macfx::ColorConversion> observed;
}
@interface CaptureCPUTexture:NSObject
@property(nonatomic)MTLPixelFormat pixelFormat;
@property(nonatomic)NSUInteger width;
@property(nonatomic)NSUInteger height;
@property(nonatomic)NSUInteger sampleCount;
@property(nonatomic,getter=isFramebufferOnly)BOOL framebufferOnly;
@property(nonatomic)id<MTLDevice>device;
@end
@implementation CaptureCPUTexture @end
@interface CaptureCPUBuffer:NSObject
@property(nonatomic)NSMutableData *data;
- (void*)contents;
@end
@implementation CaptureCPUBuffer
- (void*)contents{return self.data.mutableBytes;}
@end
@interface CaptureCPUDevice:NSObject
- (id<MTLBuffer>)newBufferWithLength:(NSUInteger)length options:(MTLResourceOptions)options;
@end
@implementation CaptureCPUDevice
- (id<MTLBuffer>)newBufferWithLength:(NSUInteger)length options:(MTLResourceOptions)options {
    auto value=[CaptureCPUBuffer new];value.data=[NSMutableData dataWithLength:length];return (id<MTLBuffer>)value;
}
@end
@interface CaptureCPUBlit:NSObject
- (void)copyFromTexture:(id<MTLTexture>)source sourceSlice:(NSUInteger)slice sourceLevel:(NSUInteger)level sourceOrigin:(MTLOrigin)origin sourceSize:(MTLSize)size
    toBuffer:(id<MTLBuffer>)buffer destinationOffset:(NSUInteger)offset destinationBytesPerRow:(NSUInteger)row destinationBytesPerImage:(NSUInteger)image;
- (void)endEncoding;
@end
@implementation CaptureCPUBlit
- (void)copyFromTexture:(id<MTLTexture>)source sourceSlice:(NSUInteger)slice sourceLevel:(NSUInteger)level sourceOrigin:(MTLOrigin)origin sourceSize:(MTLSize)size
    toBuffer:(id<MTLBuffer>)buffer destinationOffset:(NSUInteger)offset destinationBytesPerRow:(NSUInteger)row destinationBytesPerImage:(NSUInteger)image {
    ++readbacks;check(macfx::captureWritesFormat(source.pixelFormat),"Capture blit received raw non-8-bit output");
    auto *bytes=(unsigned char*)buffer.contents;
    for(NSUInteger y=0;y<size.height;++y)for(NSUInteger x=0;x<size.width;++x){
        auto *pixel=bytes+offset+y*row+x*4;pixel[0]=42;pixel[1]=84;pixel[2]=126;pixel[3]=255;
    }
}
- (void)endEncoding {}
@end
@interface CaptureCPUCommands:NSObject
@property(nonatomic)id<MTLDevice>device;
@property(nonatomic)MTLCommandBufferStatus status;
@property(nonatomic)BOOL retainedReferences;
@property(nonatomic)NSMutableArray *handlers;
- (id<MTLBlitCommandEncoder>)blitCommandEncoder;
- (void)addCompletedHandler:(MTLCommandBufferHandler)handler;
- (void)complete;
@end
@implementation CaptureCPUCommands
- (id<MTLBlitCommandEncoder>)blitCommandEncoder{return (id<MTLBlitCommandEncoder>)[CaptureCPUBlit new];}
- (void)addCompletedHandler:(MTLCommandBufferHandler)handler{if(!self.handlers)self.handlers=[NSMutableArray array];[self.handlers addObject:[handler copy]];}
- (void)complete {self.status=MTLCommandBufferStatusCompleted;NSArray *handlers=[self.handlers copy];[self.handlers removeAllObjects];self.handlers=nil;
    for(MTLCommandBufferHandler handler in handlers)handler((id<MTLCommandBuffer>)self);}
@end
namespace macfx {
// Only the Metal allocation/encode operations are replaced; preparation,
// color/mapping choices, capture reservation, readback and files are real.
struct ColorEncoder::Impl {};
ColorEncoder::ColorEncoder(id<MTLDevice>):impl(std::make_shared<Impl>()){}
ColorEncoder::~ColorEncoder()=default;
ShaderResult ColorEncoder::encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,id<MTLTexture>target,const ColorConversion &color){
    retainColorConversion(commands,impl,source,target,color.alphaSource,nil);
    ++conversions;observed.push_back(color);check(target.pixelFormat==MTLPixelFormatRGBA8Unorm,"Screenshot output format is not RGBA8");
    return {!failConversion,failConversion?"CPU fixture conversion unavailable":""};
}
id<MTLTexture>newAdmittedTexture(id<MTLDevice>device,MTLTextureDescriptor *descriptor,uintptr_t,std::string_view){
    auto texture=[CaptureCPUTexture new];texture.device=device;texture.pixelFormat=descriptor.pixelFormat;
    texture.width=descriptor.width;texture.height=descriptor.height;texture.sampleCount=1;return (id<MTLTexture>)texture;
}
void writeCapturedFrame(const std::string&file,const void*bytes,unsigned w,unsigned h,bool bgra,bool flip,unsigned stride){writeCaptureFile(file,bytes,w,h,bgra,flip,stride);}
}
namespace {
id<MTLTexture>texture(id<MTLDevice>device,MTLPixelFormat format){auto value=[CaptureCPUTexture new];value.device=device;value.pixelFormat=format;value.width=value.height=2;value.sampleCount=1;return (id<MTLTexture>)value;}
CaptureCPUCommands *commands(id<MTLDevice>device){auto value=[CaptureCPUCommands new];value.device=device;value.status=MTLCommandBufferStatusNotEnqueued;value.retainedReferences=YES;return value;}
void request(const std::string&trigger){std::ofstream(trigger)<<"capture";
    for(unsigned attempt=0;attempt<200&&!macfx::captureTriggerPending();++attempt)std::this_thread::sleep_for(std::chrono::milliseconds(5));
    check(macfx::captureTriggerPending(),"Capture trigger was not observed");}
void image(const std::string&file){std::ifstream input(file,std::ios::binary);std::vector<unsigned char>data((std::istreambuf_iterator<char>(input)),{});
    if(data.size()!=40||std::string(data.begin(),data.begin()+8)!="MCLCAP01")throw std::runtime_error("Capture did not publish an 8-bit file: "+file+" ("+std::to_string(data.size())+" bytes)");
    for(unsigned i=24;i<data.size();i+=4)check(data[i]==42&&data[i+1]==84&&data[i+2]==126&&data[i+3]==255,"Converted readback was lost");}
}
int main(int argc,char**argv){@autoreleasepool{try{
    const bool pair=argc==2&&std::string(argv[1])=="--pair";check(argc==1||pair,"Usage: screenshot-capture [--pair]");
    char directory[]="/private/tmp/maclauncher-screenshot-capture-XXXXXX";check(mkdtemp(directory)!=nullptr,"Cannot create capture fixture directory");
    struct Remove {std::string directory;~Remove(){if(std::uncaught_exceptions()){std::ifstream log(directory+"/capture.log");std::fprintf(stderr,"%s",std::string((std::istreambuf_iterator<char>(log)),{}).c_str());}std::filesystem::remove_all(directory);}}remove{directory};
    const std::string prefix=std::string(directory)+"/frame",trigger=std::string(directory)+"/request";
    setenv("RESHADE_LOG",(std::string(directory)+"/capture.log").c_str(),1);
    setenv("RESHADE_CAPTURE_PREFIX",prefix.c_str(),1);setenv("RESHADE_CAPTURE_TRIGGER",trigger.c_str(),1);
    if(pair)unsetenv("RESHADE_CAPTURE_FINAL");else setenv("RESHADE_CAPTURE_FINAL","1",1);
    auto device=(id<MTLDevice>)[CaptureCPUDevice new];
    auto color=macfx::describeImageColor(macfx::ImageColorSpace::BT2100PQ);color.referenceWhite=203;color.peakLuminance=812;
    for(const bool retaining:{true,false})for(const auto format:{MTLPixelFormatRGB10A2Unorm,MTLPixelFormatRGBA16Float,MTLPixelFormatRGBA8Unorm}){
        auto source=texture(device,format);auto buffer=commands(device);buffer.retainedReferences=retaining;const auto before=conversions,beforeReadbacks=readbacks;
        check(!macfx::FrameCapture::begin((id<MTLCommandBuffer>)buffer,source,1,false,&color),"Idle capture unexpectedly admitted");
        check(conversions==before,"Idle capture ran color conversion");
        request(trigger);auto capture=macfx::FrameCapture::begin((id<MTLCommandBuffer>)buffer,source,2,false,&color);
        check(bool(capture),"Non-8-bit source capture was rejected");
        capture->finish((id<MTLCommandBuffer>)buffer,source);capture->finish((id<MTLCommandBuffer>)buffer,source);
        [buffer complete];dispatch_sync(macfx::captureWriterQueue(),^{});image(prefix+"-after.rgba");
        if(pair)image(prefix+"-before.rgba");else check(!std::filesystem::exists(prefix+"-before.rgba"),"Final capture wrote a diagnostic source");
        check(readbacks-beforeReadbacks==(pair?2:1),"Capture read back the wrong number of images");
        check(conversions-before==(format==MTLPixelFormatRGBA8Unorm?0:pair?2:1),"Capture converted zero, twice, or outside its requested images");
        for(unsigned index=before;index<observed.size();++index){const auto &value=observed[index];
            check(value.source.transfer==color.transfer&&value.source.referenceWhite==203&&value.target.referenceWhite==203&&value.target.peakLuminance==203&&value.target.transfer==macfx::ColorTransfer::SRGB,"Capture lost its actual color metadata");
            check(value.toneMap==macfx::outputColorMapping("auto",color,value.target,false).toneMap&&value.ditherBits==8,"Capture bypassed Automatic mapping or 8-bit quantization");}
        std::filesystem::remove(prefix+"-before.rgba");std::filesystem::remove(prefix+"-after.rgba");
    }
    // The production nonretaining lease pins all conversion resources and its
    // encoder owner, but not the command itself. Completion and abandonment
    // both release the exact old resources without waiting on a GPU.
    for(const bool complete:{true,false}){
        __weak id weakInput=nil,weakOutput=nil,weakAlpha=nil,weakPipeline=nil;std::weak_ptr<int>weakOwner;
        @autoreleasepool{
            auto buffer=commands(device);buffer.retainedReferences=NO;
            @autoreleasepool{
                auto input=texture(device,MTLPixelFormatRGB10A2Unorm),output=texture(device,MTLPixelFormatRGBA8Unorm),alpha=texture(device,MTLPixelFormatRGBA8Unorm);
                auto pipeline=(id<MTLRenderPipelineState>)[NSObject new];auto owner=std::make_shared<int>(7);weakOwner=owner;
                weakInput=input;weakOutput=output;weakAlpha=alpha;weakPipeline=pipeline;
                macfx::retainColorConversion((id<MTLCommandBuffer>)buffer,owner,input,output,alpha,pipeline);
            }
            check(weakInput&&weakOutput&&weakAlpha&&weakPipeline&&!weakOwner.expired(),"Nonretaining conversion lost its resources before completion");
            if(complete){[buffer complete];check(!weakInput&&!weakOutput&&!weakAlpha&&!weakPipeline&&weakOwner.expired(),"Completed conversion retained old resources");}
        }
        check(!weakInput&&!weakOutput&&!weakAlpha&&!weakPipeline&&weakOwner.expired(),"Abandoned conversion formed a command/resource cycle");
    }
    // A failed conversion must release the claim without consuming the trigger.
    request(trigger);failConversion=true;auto bad=commands(device);auto source=texture(device,MTLPixelFormatRGB10A2Unorm);
    auto capture=macfx::FrameCapture::begin((id<MTLCommandBuffer>)bad,source,3,false,&color);if(capture)capture->finish((id<MTLCommandBuffer>)bad,source);
    [bad complete];dispatch_sync(macfx::captureWriterQueue(),^{});check(!std::filesystem::exists(prefix+"-after.rgba"),"Failed conversion published an image");
    failConversion=false;auto retry=commands(device);capture=macfx::FrameCapture::begin((id<MTLCommandBuffer>)retry,source,4,false,&color);check(bool(capture),"Failed conversion consumed the request");
    capture->finish((id<MTLCommandBuffer>)retry,source);[retry complete];dispatch_sync(macfx::captureWriterQueue(),^{});image(prefix+"-after.rgba");
    std::puts(pair?"screenshot-capture: RGB10A2, RGBA16Float and RGBA8 diagnostic pairs and nonretaining resource leases pass (CPU stand-ins)":"screenshot-capture: RGB10A2, RGBA16Float and RGBA8 final captures and nonretaining resource leases pass (CPU stand-ins)");return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}}
