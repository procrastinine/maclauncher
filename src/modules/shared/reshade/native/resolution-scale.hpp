#pragma once
#include "automatic-resolution.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <optional>
#include <stdexcept>

namespace macfx {
// Per-process launch settings. No request leaves allocation with the publisher.
inline bool resolutionAutomatic() {
    static const bool value=[] {
        const char *text=std::getenv("RESHADE_RENDER_AUTO");if(!text||!*text)return false;
        if(std::strcmp(text,"1"))throw std::runtime_error("Automatic game rendering must be enabled with 1");
        for(const char *name:{"RESHADE_RENDER_HEIGHT","RESHADE_RENDER_MAX_HEIGHT","RESHADE_RENDER_MULTIPLIER","RESHADE_RENDER_SOURCE_METHOD"})
            if(const char *other=std::getenv(name);other&&*other)throw std::runtime_error("Automatic game rendering cannot include a manual source setting");
        return true;
    }();return value;
}
inline std::optional<double> resolutionMultiplier() {
    static const auto value=[]()->std::optional<double>{
        const char *render=std::getenv("RESHADE_RENDER_MULTIPLIER");
        if(render&&*render){
            if(!std::strcmp(render,"1"))return 1;
            if(!std::strcmp(render,"1.5"))return 1.5;
            if(!std::strcmp(render,"2"))return 2;
            if(!std::strcmp(render,"3"))return 3;
            throw std::runtime_error("Game rendering divisor must be 1, 1.5, 2 or 3");
        }
        const char *method=std::getenv("RESHADE_SPATIAL_METHOD");
        const char *text=std::getenv("RESHADE_RESOLUTION_MULTIPLIER");
        if(!method||!*method||!std::strcmp(method,"off")||!text||!*text)return {};
        if(!std::strcmp(text,"1"))return 1;
        if(!std::strcmp(text,"1.5"))return 1.5;
        if(!std::strcmp(text,"2"))return 2;
        throw std::runtime_error("Resolution multiplier must be 1, 1.5 or 2");
    }();
    return value;
}
inline std::optional<unsigned> resolutionHeight() {
    static const auto value=[]()->std::optional<unsigned>{
        const char *text=std::getenv("RESHADE_RENDER_HEIGHT");
        if(!text||!*text)return {};
        unsigned height=0;const char *end=text+std::strlen(text);
        const auto parsed=std::from_chars(text,end,height);
        if(parsed.ec!=std::errc{}||parsed.ptr!=end||height<1||height>16384)
            throw std::runtime_error("Game rendering height must be an integer from 1 to 16384");
        return height;
    }();
    return value;
}
inline std::optional<unsigned> resolutionMaxHeight() {
    static const auto value=[]()->std::optional<unsigned>{
        const char *text=std::getenv("RESHADE_RENDER_MAX_HEIGHT");if(!text||!*text)return {};
        unsigned height=0;const char *end=text+std::strlen(text);const auto parsed=std::from_chars(text,end,height);
        if(parsed.ec!=std::errc{}||parsed.ptr!=end||height<1||height>16384)throw std::runtime_error("Maximum game rendering height must be an integer from 1 to 16384");
        return height;
    }();return value;
}
inline bool resolutionRequested() {return resolutionAutomatic()||resolutionHeight().has_value()||resolutionMaxHeight().has_value()||resolutionMultiplier().has_value();}
// Only a cooperating publisher can change its final drawable allocation.
// Engines with fixed final viewports/blits must use their renderer API instead;
// their requested dimensions still remain available to that engine adapter.
inline bool drawableResolutionRequested() {
    const char *control=std::getenv("RESHADE_RENDER_SOURCE_CONTROL");
    return control&&!std::strcmp(control,"drawable")&&resolutionRequested();
}
struct RenderSourceSize {double width,height;};
// A live request is an immutable snapshot. Launch settings remain cached and
// no process environment is changed when a window accepts a newer snapshot.
struct RenderSourceRequest {
    std::optional<unsigned> height,maximum;
    std::optional<double> multiplier;
    bool automatic=false;
};
inline RenderSourceRequest launchRenderSourceRequest() {
    if(resolutionAutomatic())return {{},{},{},true};
    const auto height=resolutionHeight();const auto maximum=height?std::optional<unsigned>{}:resolutionMaxHeight();
    return {height,maximum,height||maximum?std::optional<double>{}:resolutionMultiplier()};
}
inline RenderSourceSize renderSourceSize(const RenderSourceRequest &request,double outputWidth,double outputHeight,double publisherWidth,double publisherHeight) {
    const auto height=request.height,maximum=request.maximum;const auto multiplier=request.multiplier;
    if((!request.automatic&&!height&&!maximum&&!multiplier)||!std::isfinite(outputWidth)||!std::isfinite(outputHeight)||outputWidth<1||outputHeight<1)
        return {publisherWidth,publisherHeight};
    if(request.automatic){
        const auto target=automaticResolutionTarget(outputWidth,outputHeight,publisherWidth,publisherHeight);
        return {target.width,target.height};
    }
    if(maximum){
        if(!std::isfinite(publisherWidth)||!std::isfinite(publisherHeight)||publisherWidth<1||publisherHeight<1)return {publisherWidth,publisherHeight};
        const double scale=std::min({1.0,double(*maximum)/publisherHeight,outputWidth/publisherWidth,outputHeight/publisherHeight});
        return {std::max(1.0,std::min({publisherWidth,outputWidth,std::ceil(publisherWidth*scale)})),std::max(1.0,std::min({publisherHeight,outputHeight,std::ceil(publisherHeight*scale)}))};
    }
    double targetHeight=height?std::min(outputHeight,double(*height)):std::max(1.0,std::ceil(outputHeight/ *multiplier));
    const double targetWidth=height?std::ceil(outputWidth*targetHeight/outputHeight):std::ceil(outputWidth/ *multiplier);
    return {std::max(1.0,std::min(outputWidth,targetWidth)),std::max(1.0,std::min(outputHeight,targetHeight))};
}
inline RenderSourceSize renderSourceSize(double outputWidth,double outputHeight,double publisherWidth,double publisherHeight) {
    return renderSourceSize(launchRenderSourceRequest(),outputWidth,outputHeight,publisherWidth,publisherHeight);
}
}
