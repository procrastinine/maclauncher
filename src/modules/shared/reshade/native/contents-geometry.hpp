#pragma once
#import <QuartzCore/QuartzCore.h>

namespace macfx {
// How Core Animation maps a source layer's contents into its bounds. A
// stretched mapping (resize gravity over the whole image) lets an owned output
// fill those bounds at any extent. Every other mapping keeps the contents' own
// extent: the output then has the publisher's image extent and repeats the
// source gravity, contents rectangles, scale and orientation, so processing
// neither rescales the image nor reveals pixels the source layer hides.
struct ContentsGeometry {
    bool stretched=true;
    NSString *gravity=kCAGravityResize;
    CGRect rect=CGRectMake(0,0,1,1),center=CGRectMake(0,0,1,1);
    CGFloat scale=1;bool flipped=false;
};
inline ContentsGeometry contentsGeometry(CALayer *layer){
    ContentsGeometry result;if(!layer)return result;
    if(layer.contentsGravity)result.gravity=layer.contentsGravity;
    result.rect=layer.contentsRect;result.center=layer.contentsCenter;result.scale=layer.contentsScale;result.flipped=layer.contentsAreFlipped;
    result.stretched=[result.gravity isEqualToString:kCAGravityResize]&&CGRectEqualToRect(result.rect,CGRectMake(0,0,1,1))&&
        CGRectEqualToRect(result.center,CGRectMake(0,0,1,1));
    return result;
}
inline bool sameContentsGeometry(const ContentsGeometry &a,const ContentsGeometry &b){
    if(a.stretched||b.stretched)return a.stretched==b.stretched;
    return [a.gravity isEqualToString:b.gravity]&&CGRectEqualToRect(a.rect,b.rect)&&CGRectEqualToRect(a.center,b.center)&&
        a.scale==b.scale&&a.flipped==b.flipped;
}
// The output covers the source bounds and is attached to its final
// superlayer; orientation is matched against the source after attachment.
inline void applyContentsGeometry(CALayer *output,const ContentsGeometry &geometry){
    output.contentsGravity=geometry.gravity;output.contentsRect=geometry.rect;output.contentsCenter=geometry.center;
    if(!geometry.stretched)output.contentsScale=geometry.scale;
    if(!geometry.stretched&&output.contentsAreFlipped!=geometry.flipped)output.geometryFlipped=!output.geometryFlipped;
}
// The drawable extent the publisher itself requested. Drawable resolution
// may reduce the current drawable; the presented extent stays the publisher's.
CGSize publisherDrawableSize(CAMetalLayer *layer);
}
