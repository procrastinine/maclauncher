#include "frame.h"
#include "frame-depth.h"
#include "live-controls.hpp"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <array>
#include <chrono>
#include <fstream>
#include <thread>
#include <stdexcept>
#include <cstdio>
static void require(bool value,const char *reason){if(!value)throw std::runtime_error(reason);}
int main(int argc,char **argv){@autoreleasepool{try{
    require(argc==3,"Usage: effect-placement PLAN CONTROL_FILE");
    std::ifstream plan(argv[1]);std::array<std::string,2> revisions;for(auto &v:revisions){std::getline(plan,v);require(v.size()==64,"Invalid shader revision");}
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];require(device&&queue,"Metal unavailable");
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:32 height:24 mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto source=[device newTextureWithDescriptor:descriptor];descriptor.width=64;descriptor.height=48;auto output=[device newTextureWithDescriptor:descriptor];
    descriptor.pixelFormat=MTLPixelFormatR32Float;descriptor.width=32;descriptor.height=24;auto depth=[device newTextureWithDescriptor:descriptor];
    std::array<unsigned char,32*24*4> input;std::array<float,32*24> depths;depths.fill(.5f);
    for(unsigned y=0;y<24;++y)for(unsigned x=0;x<32;++x){auto *p=&input[(y*32+x)*4];p[0]=p[1]=p[2]=((x+y)%2)?255:0;p[3]=255;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:input.data() bytesPerRow:128];
    [depth replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:depths.data() bytesPerRow:128];
    std::array<std::array<unsigned char,64*48*4>,4> images;int owner=0;
    for(unsigned frame=0;frame<6;++frame){
        const bool after=frame==1||frame==3||frame==4,enabled=frame!=3,withDepth=frame>=4;
        macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=2;packet.flags=(enabled?8:0)|(after?32:0);
        std::memset(packet.effectKey,'a',64);std::memcpy(packet.revision,revisions[withDepth?1:0].data(),64);
        const auto temporary=std::string(argv[2])+".tmp";{std::ofstream file(temporary,std::ios::binary);file.write((const char *)&packet,sizeof(packet));}
        require(rename(temporary.c_str(),argv[2])==0,"Cannot publish controls");std::this_thread::sleep_for(std::chrono::milliseconds(120));
        // A new spatial output is prepared off the frame path: RS_FRAME_BUSY
        // asks the host to retry, here with a fresh command buffer.
        id<MTLCommandBuffer> cb=nil;RSFrameResult result{};int code=RS_FRAME_BUSY;
        for(unsigned attempt=0;code==RS_FRAME_BUSY&&attempt<2000;++attempt){if(attempt)std::this_thread::sleep_for(std::chrono::milliseconds(1));
            cb=[queue commandBuffer];RSFrameRequest request{sizeof(RSFrameRequest),1,&owner,(__bridge void *)cb,(__bridge void *)source,(__bridge void *)output,frame+1,RS_FRAME_BILINEAR,RS_FRAME_PERCEPTUAL,RS_FRAME_TOP_LEFT};
            RSFrameDepth captured{sizeof(RSFrameDepth),RS_DEPTH_ABI_VERSION,(__bridge void *)depth,frame+1,RS_FRAME_TOP_LEFT,0};
            result={};result.size=sizeof(result);result.version=1;
            code=withDepth?rsProcessFrameWithDepth(&request,&captured,&result):rsProcessFrame(&request,&result);
        }
        if(frame==4){require(!result.encoded&&std::strstr(result.reason,"Before scaling"),"Depth effect placement was not rejected");printf("depth-after-rejected=%s\n",result.reason);continue;}
        require(code==RS_FRAME_OK&&result.encoded,result.reason);require(result.effects==enabled,"Effect enabled state changed");
        [cb commit];[cb waitUntilCompleted];require(cb.status==MTLCommandBufferStatusCompleted,"GPU failed");
        if(frame<4)[output getBytes:images[frame].data() bytesPerRow:256 fromRegion:MTLRegionMake2D(0,0,64,48) mipmapLevel:0];
        printf("frame=%u placement=%s effects=%u scaled=%u\n",frame,after?"after":"before",result.effects,result.scaled);
    }
    require(images[0]!=images[1],"Changing placement did not change output");
    require(images[0]==images[2],"Switching back did not restore original output");
    require(images[0]==images[3],"Disabled effects changed spatial output");
    unsigned fractional=0;for(size_t i=0;i<images[0].size();i+=4){fractional+=images[0][i]>0&&images[0][i]<255;require(images[1][i]==0||images[1][i]==255,"After-scaling threshold was not applied at output resolution");}
    require(fractional>0,"Before-scaling output has no interpolated samples");rsReleaseFrameOwner(&owner);
    puts("Live placement changed pixel order, restored source order and preserved off behavior");return 0;
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
