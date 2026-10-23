#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "../src/modules/shared/reshade/temporal/frame.h"
#include <dlfcn.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

static constexpr uint32_t rw=37,rh=23,uw=65,uh=41;
static id<MTLTexture> texture(id<MTLDevice> device,MTLPixelFormat format,uint32_t w,uint32_t h) {
    auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];
    desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    return [device newTextureWithDescriptor:desc];
}
struct Input {
    id<MTLTexture> color,depth,motion,output;
    RSTemporalFrame frame={};
};
static Input input(id<MTLDevice> device,bool padded,void *owner) {
    Input in;auto &f=in.frame;f.size=sizeof(f);f.version=1;f.method=RS_TEMPORAL_FSR4;f.owner=owner;
    f.renderWidth=rw;f.renderHeight=rh;f.outputWidth=uw;f.outputHeight=uh;f.maxRenderWidth=rw;f.maxRenderHeight=rh;
    f.motionScaleX=1;f.motionScaleY=1;f.preExposure=1;f.sharpness=.4;
    f.colorX=padded?3:0;f.colorY=padded?2:0;f.depthX=padded?5:0;f.depthY=padded?1:0;
    f.motionX=padded?7:0;f.motionY=padded?4:0;f.outputX=padded?9:0;f.outputY=padded?6:0;
    in.color=texture(device,MTLPixelFormatRGBA16Float,rw+f.colorX+(padded?5:0),rh+f.colorY+(padded?7:0));
    in.depth=texture(device,MTLPixelFormatR32Float,rw+f.depthX+(padded?4:0),rh+f.depthY+(padded?8:0));
    in.motion=texture(device,MTLPixelFormatRG16Float,rw+f.motionX+(padded?6:0),rh+f.motionY+(padded?3:0));
    in.output=texture(device,MTLPixelFormatRGBA16Float,uw+f.outputX+(padded?5:0),uh+f.outputY+(padded?3:0));
    f.color=(__bridge void *)in.color;f.depth=(__bridge void *)in.depth;f.motion=(__bridge void *)in.motion;f.output=(__bridge void *)in.output;
    return in;
}
static void upload(Input &in,unsigned frame) {
    auto &f=in.frame;
    std::vector<_Float16> color(in.color.width*in.color.height*4,7),motion(in.motion.width*in.motion.height*2,11),output(in.output.width*in.output.height*4,-9);
    std::vector<float> depth(in.depth.width*in.depth.height,17);
    for(uint32_t y=0;y<rh;++y)for(uint32_t x=0;x<rw;++x){
        const auto c=((y+f.colorY)*in.color.width+x+f.colorX)*4;
        color[c]=float(16+((x+frame)%29)*5)/256;color[c+1]=float(24+((y+frame)%19)*7)/256;
        color[c+2]=float(32+((x+2*y+frame)%31)*4)/256;color[c+3]=1;
        depth[(y+f.depthY)*in.depth.width+x+f.depthX]=.15f+float((x+y)%17)/24;
        const auto m=((y+f.motionY)*in.motion.width+x+f.motionX)*2;
        motion[m]=-.25f+float((x+frame)%3)/32;motion[m+1]=.1875f+float((y+frame)%5)/64;
    }
    [in.color replaceRegion:MTLRegionMake2D(0,0,in.color.width,in.color.height) mipmapLevel:0 withBytes:color.data() bytesPerRow:in.color.width*8];
    [in.depth replaceRegion:MTLRegionMake2D(0,0,in.depth.width,in.depth.height) mipmapLevel:0 withBytes:depth.data() bytesPerRow:in.depth.width*4];
    [in.motion replaceRegion:MTLRegionMake2D(0,0,in.motion.width,in.motion.height) mipmapLevel:0 withBytes:motion.data() bytesPerRow:in.motion.width*4];
    [in.output replaceRegion:MTLRegionMake2D(0,0,in.output.width,in.output.height) mipmapLevel:0 withBytes:output.data() bytesPerRow:in.output.width*8];
    f.flags=frame==0?RS_TEMPORAL_RESET:0;f.frameId=frame;f.jitterX=float(int(frame%4)-2)/8;f.jitterY=float(int((frame*3)%7)-3)/12;
}
int main(int argc,char **argv){@autoreleasepool {
    if(argc<2 || argc>3)return 2;const bool metal4=argc==3 && !std::strcmp(argv[2],"mtl4");
    auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){fprintf(stderr,"%s\n",dlerror());return 3;}
    auto getter=(RSGetTemporalProvider)dlsym(library,"rsGetTemporalProvider");
    const auto *provider=getter?getter(1):nullptr;if(!provider || getter(99))return 4;
    auto device=MTLCreateSystemDefaultDevice();if(!device)return 5;auto queue=[device newCommandQueue];
    auto plain=input(device,false,(void *)1),padded=input(device,true,(void *)2);
    for(unsigned index=0;index<4;++index){
        for(Input *in:{&plain,&padded}){
            upload(*in,index);if(index>=2)in->frame.frameId=9;
            id cb;id<MTL4CommandQueue> q4;id<MTL4CommandAllocator> allocator;
            if(metal4){q4=[device newMTL4CommandQueue];allocator=[device newCommandAllocator];cb=[device newCommandBuffer];[cb beginCommandBufferWithAllocator:allocator];}
            else cb=[queue commandBuffer];
            in->frame.commandBuffer=(__bridge void *)cb;in->frame.commandBufferKind=metal4?1:0;
            RSTemporalResult r={};r.size=sizeof(r);const auto code=provider->encode(&in->frame,&r);
            if(code!=RS_TEMPORAL_OK || !r.encoded){fprintf(stderr,"encode %u: %s (%u)\n",index,r.reason,code);return 6;}
            if(index>=2 && !r.reset){fprintf(stderr,"frame sequence discontinuity retained history\n");return 11;}
            if(metal4){[cb endCommandBuffer];id<MTL4CommandBuffer> list[]={cb};[q4 commit:list count:1];
                auto event=[device newSharedEvent];[q4 signalEvent:event value:1];if(![event waitUntilSignaledValue:1 timeoutMS:20000])return 7;
            }else{[cb commit];[cb waitUntilCompleted];if([cb error]){fprintf(stderr,"%s\n",[[cb error] description].UTF8String);return 7;}}
        }
        std::vector<_Float16> a(uw*uh*4),b(padded.output.width*padded.output.height*4);
        [plain.output getBytes:a.data() bytesPerRow:uw*8 fromRegion:MTLRegionMake2D(0,0,uw,uh) mipmapLevel:0];
        [padded.output getBytes:b.data() bytesPerRow:padded.output.width*8 fromRegion:MTLRegionMake2D(0,0,padded.output.width,padded.output.height) mipmapLevel:0];
        double sum=0;for(uint32_t y=0;y<padded.output.height;++y)for(uint32_t x=0;x<padded.output.width;++x)for(unsigned c=0;c<4;++c){
            auto value=b[(y*padded.output.width+x)*4+c];bool inside=x>=9 && x<9+uw && y>=6 && y<6+uh;
            if(inside){auto expected=a[((y-6)*uw+x-9)*4+c];if(!std::isfinite(float(value)) || value!=expected)return 8;sum+=float(value);}
            else if(value!=_Float16(-9))return 9;
        }
        printf("frame=%u cropped-output-identical=1 finite=1 untouched-border=1 checksum=%.6f\n",index,sum);
    }
    auto invalid=plain.frame;invalid.depth=nullptr;RSTemporalResult r={};r.size=sizeof(r);
    if(provider->encode(&invalid,&r)!=RS_TEMPORAL_INVALID)return 10;
    provider->release((void *)1);provider->release((void *)2);return 0;
}}
