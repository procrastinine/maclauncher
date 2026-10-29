// Copyright (c) MacLauncher contributors. MIT license.
// An owned output repeats its source layer's contents mapping: Core Animation
// renders the output exactly as it renders the original contents, and a
// stretched output (the previous behavior) visibly rescales a layer that
// does not stretch its image. The remote presenter configures its output so.
#include "contents-geometry.hpp"
#include "layer-presentation.hpp"
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {
id<MTLDevice> device;id<MTLCommandQueue> queue;
// Rows and columns are encoded in the color so any shift or scale shows.
CGImageRef image(unsigned w,unsigned h){
    std::vector<uint8_t> pixels(size_t(w)*h*4);
    for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x){auto p=&pixels[(size_t(y)*w+x)*4];p[0]=uint8_t(x*3);p[1]=uint8_t(y*3);p[2]=uint8_t(64+(x^y)%128);p[3]=255;}
    auto space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    auto context=CGBitmapContextCreate(pixels.data(),w,h,8,w*4,space,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
    auto result=CGBitmapContextCreateImage(context);CGContextRelease(context);CGColorSpaceRelease(space);return result;
}
std::vector<uint8_t> render(CALayer *root,unsigned w,unsigned h){
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];
    d.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead;d.storageMode=MTLStorageModeShared;
    auto texture=[device newTextureWithDescriptor:d];assert(texture);
    // The renderer reads the tree committed after it is bound.
    CARenderer *renderer=[CARenderer rendererWithMTLTexture:texture options:@{kCARendererMetalCommandQueue:queue}];
    renderer.layer=root;renderer.bounds=CGRectMake(0,0,w,h);[CATransaction flush];
    [renderer beginFrameAtTime:CACurrentMediaTime() timeStamp:nullptr];[renderer addUpdateRect:renderer.bounds];[renderer render];[renderer endFrame];
    auto fence=[queue commandBuffer];[fence commit];[fence waitUntilCompleted];
    std::vector<uint8_t> result(size_t(w)*h*4);
    [texture getBytes:result.data() bytesPerRow:w*4 fromRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0];return result;
}
struct Case {const char *name;NSString *gravity;unsigned imageWidth,imageHeight;CGRect rect;bool flipped;};
// One source layer over an 80×60 target: alone, then with its contents moved
// to a child output configured from it, to a stretched child, and to an
// output configured from it under a flipped host layer.
void compare(const Case &test,unsigned &checks){
    constexpr unsigned W=80,H=60;auto picture=image(test.imageWidth,test.imageHeight);
    const auto tree=[&](int mode){
        [CATransaction begin];[CATransaction setDisableActions:YES];
        auto root=[CALayer layer];root.frame=CGRectMake(0,0,W,H);root.geometryFlipped=test.flipped;root.backgroundColor=CGColorGetConstantColor(kCGColorBlack);
        auto source=[CALayer layer];source.frame=CGRectMake(0,0,W,H);source.contentsGravity=test.gravity;source.contentsRect=test.rect;source.contentsScale=1;
        [root addSublayer:source];
        if(!mode)source.contents=(__bridge id)picture;
        else {
            // Mode 3 hosts the output under a flipped intermediate layer, as
            // an AppKit overlay can be; its orientation must still match.
            CALayer *parent=source;if(mode==3){parent=[CALayer layer];parent.frame=source.bounds;parent.geometryFlipped=YES;[source addSublayer:parent];}
            auto output=[CALayer layer];[parent addSublayer:output];output.frame=parent.bounds;
            if(mode!=2)macfx::applyContentsGeometry(output,macfx::contentsGeometry(source));
            output.contents=(__bridge id)picture;}
        [CATransaction commit];return root;};
    const auto original=render(tree(0),W,H),mirrored=render(tree(1),W,H),stretched=render(tree(2),W,H),hosted=render(tree(3),W,H);
    // The source image must actually be drawn for the comparisons to mean anything.
    bool drawn=false;for(size_t i=0;i<original.size();i+=4)drawn|=original[i+1]>0||original[i+2]>0;
    if(!drawn)std::fprintf(stderr,"%s: Core Animation drew nothing\n",test.name);
    assert(drawn);
    if(original!=mirrored)std::fprintf(stderr,"%s: the configured output differs from the source mapping\n",test.name);
    assert(original==mirrored);++checks;
    if(original!=hosted)std::fprintf(stderr,"%s: the output under a flipped host differs from the source mapping\n",test.name);
    assert(original==hosted);++checks;
    if(original==stretched)std::fprintf(stderr,"%s: the stretched output matches, so this case cannot show the defect\n",test.name);
    assert(original!=stretched);++checks;
    CGImageRelease(picture);
}
// The remote presenter's output child takes the source mapping and the
// requested surface extent, and returns to stretching when the source does.
void remote(unsigned &checks){
    for(const bool flipped:{false,true}){
        auto root=[CALayer layer];root.frame=CGRectMake(0,0,432,302);root.geometryFlipped=flipped;
        auto source=[CALayer layer];source.frame=CGRectMake(0,0,432,288);source.contentsScale=2;source.contentsGravity=kCAGravityTopLeft;source.opaque=YES;[root addSublayer:source];
        auto presentation=std::make_shared<macfx::LayerPresentation>(source,864,604,macfx::PresenterConfig{});
        auto output=(CAMetalLayer*)source.sublayers.firstObject;assert([output isKindOfClass:CAMetalLayer.class]);
        assert([output.contentsGravity isEqualToString:kCAGravityTopLeft]&&output.contentsScale==2&&CGSizeEqualToSize(output.drawableSize,CGSizeMake(864,604)));
        assert(CGRectEqualToRect(output.frame,source.bounds)&&output.contentsAreFlipped==source.contentsAreFlipped);checks+=2;
        source.contentsGravity=kCAGravityResize;presentation->update(864,576);
        assert([output.contentsGravity isEqualToString:kCAGravityResize]&&output.contentsScale==2&&CGSizeEqualToSize(output.drawableSize,CGSizeMake(864,576)));++checks;
        source.contentsRect=CGRectMake(0,0,1,.5);presentation->update(864,604);
        assert([output.contentsGravity isEqualToString:kCAGravityResize]&&CGRectEqualToRect(output.contentsRect,CGRectMake(0,0,1,.5))&&output.contentsScale==2);++checks;
        presentation->stop();
    }
}
}
int main(){@autoreleasepool{
    for(const char *name:{"RESHADE_EFFECT_PLAN","RESHADE_EFFECT","RESHADE_CONTROL_FILE","RESHADE_PRESENTATION_CONTROL_FILE","RESHADE_RUNTIME_STATUS_FILE","RESHADE_FRAME_GENERATION"})unsetenv(name);
    device=MTLCreateSystemDefaultDevice();if(!device){std::puts("Metal is unavailable");return 77;}queue=[device newCommandQueue];
    unsigned checks=0;
    // Java's AWT layer: a drawable taller than its layer, anchored at the top
    // and clipped at the bottom; then the other unstretched mappings.
    for(const auto &test:{Case{"top-left, taller image",kCAGravityTopLeft,80,70,CGRectMake(0,0,1,1),false},
                          Case{"top-left, taller image, flipped geometry",kCAGravityTopLeft,80,70,CGRectMake(0,0,1,1),true},
                          Case{"bottom, narrower image",kCAGravityBottom,60,70,CGRectMake(0,0,1,1),false},
                          Case{"center, smaller image",kCAGravityCenter,50,40,CGRectMake(0,0,1,1),true},
                          Case{"aspect fit",kCAGravityResizeAspect,40,40,CGRectMake(0,0,1,1),false},
                          Case{"resize over half the image",kCAGravityResize,80,60,CGRectMake(0,0,1,.5),false}})
        compare(test,checks);
    remote(checks);
    std::printf("contents geometry: %u checks; owned outputs reproduce top-left, bottom, center, aspect-fit and partial-rectangle mappings in plain and flipped layers, and the remote output repeats its source mapping: pass\n",checks);
    return 0;
}}
