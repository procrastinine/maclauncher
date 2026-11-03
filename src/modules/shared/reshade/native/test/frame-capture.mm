// Copyright (c) MacLauncher contributors. MIT license.
#include "frame-capture.hpp"
#import <Foundation/Foundation.h>
#include <array>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <thread>
#include <vector>
namespace {
void require(bool value,const char*reason){if(!value)throw std::runtime_error(reason);}
void wait(dispatch_semaphore_t semaphore,const char*reason){require(dispatch_semaphore_wait(semaphore,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))==0,reason);}
void request(const std::string&file){std::ofstream(file)<<"capture";for(unsigned i=0;i<200&&!macfx::captureTriggerPending();++i)std::this_thread::sleep_for(std::chrono::milliseconds(10));require(macfx::captureTriggerPending(),"Capture request deadline");}
void image(const std::string&file,unsigned value,unsigned flags){
    std::ifstream input(file,std::ios::binary);std::vector<unsigned char>bytes((std::istreambuf_iterator<char>(input)),{});
    require(bytes.size()==40&&std::string(bytes.begin(),bytes.begin()+8)=="MCLCAP01","Incorrect capture size or header");
    auto field=[&](unsigned offset){return uint32_t(bytes[offset])|(uint32_t(bytes[offset+1])<<8)|(uint32_t(bytes[offset+2])<<16)|(uint32_t(bytes[offset+3])<<24);};
    require(field(8)==2&&field(12)==2&&field(16)==8&&field(20)==flags,"Incorrect capture layout");
    for(unsigned i=24;i<bytes.size();++i)require(bytes[i]==value,"Readback bytes changed or expired");
}
}
int main(int argc,char**argv){@autoreleasepool{try{
    require(argc==2,"Capture fixture needs a temporary directory");const std::string prefix=std::string(argv[1])+"/frame",trigger=std::string(argv[1])+"/request";
    const bool finalOnly=macfx::nativeConfig().capture.finalOnly;
    auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal unavailable");auto queue=[device newCommandQueue];
    auto texture=[&](unsigned value){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:2 height:2 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;auto result=[device newTextureWithDescriptor:descriptor];std::array<unsigned char,16>bytes;bytes.fill(value);[result replaceRegion:MTLRegionMake2D(0,0,2,2) mipmapLevel:0 withBytes:bytes.data() bytesPerRow:8];return result;};
    auto gate=dispatch_semaphore_create(0),entered=dispatch_semaphore_create(0);
    struct Release{dispatch_semaphore_t gate;~Release(){dispatch_semaphore_signal(gate);}}release{gate};
    dispatch_async(macfx::captureWriterQueue(),^{dispatch_semaphore_signal(entered);dispatch_semaphore_wait(gate,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC));});wait(entered,"Capture writer gate deadline");
    request(trigger);auto descriptor=[MTLCommandBufferDescriptor new];descriptor.retainedReferences=NO;auto commands=[queue commandBufferWithDescriptor:descriptor];
    auto source=texture(17),target=texture(83);auto capture=macfx::FrameCapture::begin(commands,source,1,true);require(bool(capture),"Capture request not admitted");capture->finish(commands,target,false);
    capture.reset();source=nil;target=nil;
    auto first=dispatch_semaphore_create(0);[commands addCompletedHandler:^(id<MTLCommandBuffer>done){dispatch_semaphore_signal(first);}];[commands commit];wait(first,"Capture held Metal completion queue");
    auto next=[queue commandBuffer];auto later=dispatch_semaphore_create(0);[next addCompletedHandler:^(id<MTLCommandBuffer>done){dispatch_semaphore_signal(later);}];[next commit];wait(later,"Later Metal completion blocked by capture writer");
    require(!std::filesystem::exists(prefix+"-after.rgba"),"Blocked writer unexpectedly published");
    dispatch_semaphore_signal(gate);dispatch_sync(macfx::captureWriterQueue(),^{});
    image(prefix+"-after.rgba",83,1);if(!finalOnly)image(prefix+"-before.rgba",17,3);else require(!std::filesystem::exists(prefix+"-before.rgba"),"Final-only capture wrote a source");
    std::filesystem::remove(prefix+"-before.rgba");std::filesystem::remove(prefix+"-after.rgba");
    request(trigger);@autoreleasepool{auto abandoned=[queue commandBuffer];auto output=texture(29);auto cancelled=macfx::FrameCapture::begin(abandoned,output,2);require(bool(cancelled),"Cancellation request not admitted");cancelled->finish(abandoned,output);}
    dispatch_sync(macfx::captureWriterQueue(),^{});require(!std::filesystem::exists(prefix+"-after.rgba"),"Unsubmitted command published pixels");
    auto retry=[queue commandBuffer];auto output=texture(41);auto resumed=macfx::FrameCapture::begin(retry,output,3);require(bool(resumed),"Abandoned command leaked capture reservation");resumed->finish(retry,output);
    auto last=dispatch_semaphore_create(0);[retry addCompletedHandler:^(id<MTLCommandBuffer>done){dispatch_semaphore_signal(last);}];[retry commit];wait(last,"Retried capture completion deadline");dispatch_sync(macfx::captureWriterQueue(),^{});image(prefix+"-after.rgba",41,1);
    puts("frame-capture: raw readbacks retained; blocked writer leaves Metal completions free; cancellation retries; final-only respected");return 0;
}catch(const std::exception&error){fprintf(stderr,"%s\n",error.what());return 1;}}}
