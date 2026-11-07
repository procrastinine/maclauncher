#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
namespace macfx {
struct CaptureContentRect {double x=0,y=0,width=0,height=0;};
struct CaptureFrameGeometry {
    bool valid=false;uint32_t surfaceWidth=0,surfaceHeight=0,cropX=0,cropY=0,width=0,height=0;
    double contentScale=1,scaleFactor=1,logicalWidth=0,logicalHeight=0;
};
// ContentRect is in surface points. ScaleFactor converts those points to
// pixels; ContentScale describes how SCK fitted the original window into
// that content. In particular ContentScale is not necessarily one on macOS 15.
// Metadata interpretation follows MacShade (BSD-3-Clause); see package notice.
inline CaptureFrameGeometry captureFrameGeometry(uint32_t width,uint32_t height,
    std::optional<CaptureContentRect>content={},std::optional<double>scaleFactor={},std::optional<double>contentScale={})noexcept {
    CaptureFrameGeometry result;result.surfaceWidth=width;result.surfaceHeight=height;
    result.scaleFactor=scaleFactor.value_or(1);result.contentScale=contentScale.value_or(1);
    if(!width||!height||!std::isfinite(result.scaleFactor)||result.scaleFactor<=0||
        !std::isfinite(result.contentScale)||result.contentScale<=0)return result;
    const CaptureContentRect rect=content.value_or(CaptureContentRect{0,0,double(width)/result.scaleFactor,double(height)/result.scaleFactor});
    if(!std::isfinite(rect.x)||!std::isfinite(rect.y)||!std::isfinite(rect.width)||!std::isfinite(rect.height)||rect.width<=0||rect.height<=0)return result;
    const double x=rect.x*result.scaleFactor,y=rect.y*result.scaleFactor,
        right=(rect.x+rect.width)*result.scaleFactor,bottom=(rect.y+rect.height)*result.scaleFactor;
    if(!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(right)||!std::isfinite(bottom)||right<=x||bottom<=y)return result;
    // Best effort: finite positive but out-of-surface metadata can occur
    // during window/display transitions. Keep the usable full surface rather
    // than drop the frame or guess an intersection that crops the wrong area.
    if(x<0||y<0||right>double(width)||bottom>double(height)){
        result.width=width;result.height=height;
    }else {
        result.cropX=uint32_t(std::floor(x+1e-6));result.cropY=uint32_t(std::floor(y+1e-6));
        const auto endX=uint32_t(std::ceil(right-1e-6)),endY=uint32_t(std::ceil(bottom-1e-6));
        if(endX<=result.cropX||endY<=result.cropY)return result;
        result.width=endX-result.cropX;result.height=endY-result.cropY;
    }
    result.logicalWidth=rect.width/result.contentScale;result.logicalHeight=rect.height/result.contentScale;
    result.valid=std::isfinite(result.logicalWidth)&&std::isfinite(result.logicalHeight);return result;
}
// A current raw replay and the next GPU source need distinct capture leases.
// At most two sent samples and one coalesced latest sample retain the SCK pool.
// Release is by sequence so a late old frame cannot erase a newer lease.
template<class Sample>struct CaptureFrameLeases {
    std::array<std::shared_ptr<Sample>,2>sent{};std::shared_ptr<Sample>pending;
    unsigned retained()const noexcept{return unsigned(bool(sent[0]))+unsigned(bool(sent[1]));}
    unsigned size()const noexcept{return retained()+unsigned(bool(pending));}
    bool full()const noexcept{return retained()==sent.size();}
    bool retain(std::shared_ptr<Sample>sample){for(auto &slot:sent)if(!slot){slot=std::move(sample);return true;}return false;}
    bool release(uint64_t sequence){for(auto &slot:sent)if(slot&&slot->info.sequence==sequence){slot.reset();return true;}return false;}
    bool coalesce(std::shared_ptr<Sample>sample){const bool replaced=bool(pending);pending=std::move(sample);return replaced;}
    std::shared_ptr<Sample>takePending(){return full()?nullptr:std::move(pending);}
    void clearPending()noexcept{pending.reset();}
    void clear()noexcept{clearPending();for(auto &slot:sent)slot.reset();}
};
}
#ifdef __OBJC__
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <limits>
namespace macfx {
inline CaptureFrameGeometry captureFrameGeometry(NSDictionary *info,uint32_t width,uint32_t height)noexcept {
    std::optional<CaptureContentRect>rect;std::optional<double>factor,scale;
    if(id value=info[SCStreamFrameInfoContentRect]){
        CGRect parsed=CGRectZero;
        if(![value isKindOfClass:NSDictionary.class]||!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value,&parsed))return {};
        rect=CaptureContentRect{parsed.origin.x,parsed.origin.y,parsed.size.width,parsed.size.height};
    }
    const auto number=[](id value)->std::optional<double>{
        if(!value)return {};return [value isKindOfClass:NSNumber.class]?[value doubleValue]:std::numeric_limits<double>::quiet_NaN();
    };
    factor=number(info[SCStreamFrameInfoScaleFactor]);scale=number(info[SCStreamFrameInfoContentScale]);
    return captureFrameGeometry(width,height,rect,factor,scale);
}
}
#endif
