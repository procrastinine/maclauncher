#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "overlay.h"
#include <stdexcept>
#include <vector>
#include <array>

static void check(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
extern "C" JNIEXPORT jintArray JNICALL Java_OverlayOrigin_compose(JNIEnv* env,jclass,jintArray pixels,jint width,jint height,jboolean topLeft){@autoreleasepool{
    void* owner=nullptr;
    try{
        auto device=MTLCreateSystemDefaultDevice();check(device!=nil,"Metal device unavailable");
        auto queue=[device newCommandQueue];check(queue!=nil,"Metal queue unavailable");
        owner=klj_overlay_create(env,width,height);check(owner!=nullptr,"Overlay owner unavailable");
        check(klj_overlay_set_surface(env,owner,(__bridge void*)device,width,height)==0,"Overlay setup failed");
        check(klj_overlay_submit(env,owner,pixels,0,2,2,2,1)==0,"Original Canvas upload failed");
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
        descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead;
        auto source=[device newTextureWithDescriptor:descriptor];check(source!=nil,"Source allocation failed");
        std::vector<uint32_t> empty(size_t(width)*height);
        [source replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:empty.data() bytesPerRow:width*4];
        auto commands=[queue commandBuffer];KLJOverlayFrame output{};
        check(klj_overlay_encode(env,owner,(__bridge void*)commands,(__bridge void*)source,topLeft,&output)==0&&output.texture,"Original composition failed");
        auto texture=(__bridge id<MTLTexture>)output.texture;
        auto data=[device newBufferWithLength:1024 options:MTLResourceStorageModeShared];
        auto copy=[commands blitCommandEncoder];
        for(unsigned i=0;i<4;i++)[copy copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(i%2?width-1:0,i/2?height-1:0,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:data destinationOffset:i*256 destinationBytesPerRow:256 destinationBytesPerImage:256];
        [copy endEncoding];[commands commit];[commands waitUntilCompleted];
        check(commands.status==MTLCommandBufferStatusCompleted,"Metal command failed");
        jint values[4];auto bytes=(const unsigned char*)data.contents;
        for(unsigned i=0;i<4;i++){auto p=bytes+i*256;values[i]=(uint32_t(p[3])<<24)|(uint32_t(p[0])<<16)|(uint32_t(p[1])<<8)|p[2];}
        klj_overlay_destroy(owner);owner=nullptr;
        auto result=env->NewIntArray(4);if(result)env->SetIntArrayRegion(result,0,4,values);return result;
    }catch(const std::exception& failure){
        if(owner)klj_overlay_destroy(owner);
        if(!env->ExceptionCheck()){auto type=env->FindClass("java/lang/AssertionError");if(type)env->ThrowNew(type,failure.what());}
        return nullptr;
    }
}}

static std::array<uint32_t,4> pixels(id<MTLCommandQueue> queue,id<MTLCommandBuffer> commands,const KLJOverlayFrame& frame){
    auto texture=(__bridge id<MTLTexture>)frame.texture;check(texture!=nil,"Encoded image unavailable");
    auto data=[queue.device newBufferWithLength:1024 options:MTLResourceStorageModeShared];
    auto copy=[commands blitCommandEncoder];
    for(unsigned i=0;i<4;i++)[copy copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(i%2,i/2,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:data destinationOffset:i*256 destinationBytesPerRow:256 destinationBytesPerImage:256];
    [copy endEncoding];[commands commit];[commands waitUntilCompleted];check(commands.status==MTLCommandBufferStatusCompleted,"Cached image command failed");
    std::array<uint32_t,4> result;auto bytes=(const unsigned char*)data.contents;
    for(unsigned i=0;i<4;i++){auto p=bytes+i*256;bool bgra=texture.pixelFormat==MTLPixelFormatBGRA8Unorm;result[i]=(uint32_t(p[3])<<24)|(uint32_t(p[bgra?2:0])<<16)|(uint32_t(p[1])<<8)|p[bgra?0:2];}
    return result;
}
extern "C" JNIEXPORT void JNICALL Java_OverlayOrigin_cached(JNIEnv* env,jclass,jboolean topLeft){@autoreleasepool{
    void* owner=nullptr;
    try{
        auto device=MTLCreateSystemDefaultDevice();check(device!=nil,"Metal device unavailable");auto queue=[device newCommandQueue];
        owner=klj_overlay_create(env,2,2);check(owner&&klj_overlay_set_surface(env,owner,(__bridge void*)device,2,2)==0,"Cached setup failed");
        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:2 height:2 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead;
        auto source=[device newTextureWithDescriptor:descriptor];
        // Opaque native pixels have different channels and corners. The UI
        // changes only one corner, leaving base ownership visible elsewhere.
        std::array<uint32_t,4> original={0xff102030,0xff405060,0xff708090,0xffa0b0c0};std::array<uint32_t,4> rgba;
        for(unsigned i=0;i<4;i++){auto c=original[i];rgba[i]=(c&0xff00ff00)|((c&0xff)<<16)|((c>>16)&0xff);}
        [source replaceRegion:MTLRegionMake2D(0,0,2,2) mipmapLevel:0 withBytes:rgba.data() bytesPerRow:8];
        auto array=env->NewIntArray(4);check(array!=nullptr,"UI array unavailable");
        auto upload=[&](uint64_t id,uint32_t color){jint ui[4]={(jint)color,0,0,0};env->SetIntArrayRegion(array,0,4,ui);check(klj_overlay_submit(env,owner,array,0,2,2,2,id)==0,"Cached UI upload failed");};
        upload(1,0xffff0000);auto commands=[queue commandBuffer];KLJOverlayFrame frame{};
        check(klj_overlay_encode(env,owner,(__bridge void*)commands,(__bridge void*)source,topLeft,&frame)==0,"Initial native image failed");
        klj_overlay_frame_submitted(owner,&frame);auto expected=original;expected[topLeft?0:2]=0xffff0000;check(pixels(queue,commands,frame)==expected,"Initial native image differs");
        // Recycle the actual producer texture without submitting another
        // native frame. Canvas must keep using the immutable completed copy.
        rgba.fill(0xff000000);[source replaceRegion:MTLRegionMake2D(0,0,2,2) mipmapLevel:0 withBytes:rgba.data() bytesPerRow:8];
        for(unsigned i=2;i<10;i++){
            uint32_t color=0xff000000|(i*0x00112203);upload(i,color);commands=[queue commandBuffer];
            check(klj_overlay_encode_cached(env,owner,(__bridge void*)commands,&frame)==0&&frame.texture,"Canvas edit waited for a native frame");
            klj_overlay_frame_submitted(owner,&frame);expected=original;expected[topLeft?0:2]=color;check(pixels(queue,commands,frame)==expected,"Canvas edit reused mutable or old pixels");
        }
        check(klj_overlay_clear(env,owner,10)==0,"Clear upload failed");commands=nil;
        // A rejected/abandoned submission must not discard the only base.
        @autoreleasepool{auto abandoned=[queue commandBuffer];check(klj_overlay_encode_cached(env,owner,(__bridge void*)abandoned,&frame)==0&&frame.texture,"UI clear waited for a native frame");}
        commands=[queue commandBuffer];check(klj_overlay_encode_cached(env,owner,(__bridge void*)commands,&frame)==0&&frame.texture,"Rejected clear retired the base");
        klj_overlay_frame_submitted(owner,&frame);check(pixels(queue,commands,frame)==original,"Clear did not restore the pristine native image");
        commands=[queue commandBuffer];check(klj_overlay_encode_cached(env,owner,(__bridge void*)commands,&frame)==0&&!frame.texture,"Cleared overlay retained pending work");
        KLJOverlayStats stats{};check(klj_overlay_stats(owner,&stats)==0&&stats.baseSlots==0&&stats.inFlight==0&&stats.bytes<=192ull*1024*1024,"Image lifetime or GPU budget leaked");
        // Empty native frames keep their original zero-copy path.
        commands=[queue commandBuffer];check(klj_overlay_encode(env,owner,(__bridge void*)commands,(__bridge void*)source,topLeft,&frame)==0&&frame.texture==(__bridge void*)source,"Empty UI copied the native source");
        klj_overlay_frame_submitted(owner,&frame);[commands commit];[commands waitUntilCompleted];check(klj_overlay_stats(owner,&stats)==0&&stats.baseSlots==0,"Empty UI allocated a base");
        env->DeleteLocalRef(array);klj_overlay_destroy(owner);owner=nullptr;
    }catch(const std::exception& failure){if(owner)klj_overlay_destroy(owner);if(!env->ExceptionCheck()){auto type=env->FindClass("java/lang/AssertionError");if(type)env->ThrowNew(type,failure.what());}}
}}
