#include "video-pixels.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>

int main(){@autoreleasepool{
    const uint8_t rgba[]={255,0,0,255, 0,255,0,128, 7,7,7,7};
    KljSurfacePixels frame{};frame.width=2;frame.height=1;frame.format=KLJ_SURFACE_RGBA8;
    frame.planes[0]={rgba,12,4};frame.color=KLJ_SURFACE_BT709;frame.full_range=1;
    auto image=klj_surface_copy_pixels(&frame);assert(image);
    CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly);
    const uint8_t expected[]={0,0,255,255, 0,255,0,128};
    assert(!memcmp(CVPixelBufferGetBaseAddress(image),expected,sizeof(expected)));
    CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);CVPixelBufferRelease(image);

    const uint16_t rgb565[]={0xf800,0x07e0};frame.format=KLJ_SURFACE_RGB565;frame.planes[0]={rgb565,4,2};
    image=klj_surface_copy_pixels(&frame);assert(image);CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly);
    const uint8_t expected565[]={0,0,255,255,0,255,0,255};
    assert(!memcmp(CVPixelBufferGetBaseAddress(image),expected565,sizeof(expected565)));
    CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);CVPixelBufferRelease(image);

    // Separate, padded, pixel-strided Cb/Cr planes become the platform's real
    // interleaved chroma plane without borrowing original Android storage.
    uint16_t y[]={64<<6,940<<6,0,0, 120<<6,880<<6,0,0},cb[]={310<<6,0},cr[]={710<<6,0};
    frame.width=2;frame.height=2;frame.format=KLJ_SURFACE_P010;frame.color=KLJ_SURFACE_BT2020;
    frame.transfer=KLJ_SURFACE_PQ;frame.full_range=0;
    frame.planes[0]={y,8,2};frame.planes[1]={cb,4,4};frame.planes[2]={cr,4,4};
    image=klj_surface_copy_pixels(&frame);assert(image);
    y[0]=cb[0]=cr[0]=0;
    CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly);
    assert(static_cast<const uint16_t*>(CVPixelBufferGetBaseAddressOfPlane(image,0))[0]==64<<6);
    const auto*uv=static_cast<const uint16_t*>(CVPixelBufferGetBaseAddressOfPlane(image,1));
    assert(uv[0]==310<<6&&uv[1]==710<<6);
    assert(CFEqual(CVBufferGetAttachment(image,kCVImageBufferTransferFunctionKey,nullptr),kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ));
    CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);CVPixelBufferRelease(image);
    frame.planes[0].row_bytes=1;assert(!klj_surface_copy_pixels(&frame));
    puts("PASS original surface plane ownership, packing and color metadata");
}}
