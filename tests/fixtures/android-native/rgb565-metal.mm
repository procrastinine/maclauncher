#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include <cassert>
#include <cstdio>
int main(){@autoreleasepool{
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();assert(device);
    NSDictionary *properties=@{(__bridge NSString*)kIOSurfaceWidth:@8,(__bridge NSString*)kIOSurfaceHeight:@4,(__bridge NSString*)kIOSurfaceBytesPerElement:@2,(__bridge NSString*)kIOSurfaceBytesPerRow:@16,(__bridge NSString*)kIOSurfacePixelFormat:@((uint32_t)'L565')};
    IOSurfaceRef storage=IOSurfaceCreate((__bridge CFDictionaryRef)properties);assert(storage);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatB5G6R5Unorm width:8 height:4 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead;
    id<MTLTexture> texture=[device newTextureWithDescriptor:descriptor iosurface:storage plane:0];assert(texture);
    auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=texture;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(1,0,0,1);
    id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLCommandBuffer> command=[queue commandBuffer];id<MTLRenderCommandEncoder> encoder=[command renderCommandEncoderWithDescriptor:pass];[encoder endEncoding];[command commit];[command waitUntilCompleted];assert(command.status==MTLCommandBufferStatusCompleted);
    uint16_t pixels[32]={};[texture getBytes:pixels bytesPerRow:16 fromRegion:MTLRegionMake2D(0,0,8,4) mipmapLevel:0];
    for(auto pixel:pixels)assert(pixel==0xf800);
    CFRelease(storage);std::puts("PASS actual RGB565 IOSurface Metal render target and packed red precision");return 0;
}}
