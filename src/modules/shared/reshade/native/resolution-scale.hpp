#pragma once
#include "automatic-resolution.hpp"
#include "native-config.hpp"
#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>

namespace macfx {
// Per-process launch settings, parsed once with the native configuration. An
// invalid value is rethrown here, by the accessor that reads it. No request
// leaves allocation with the publisher.
template<class T> inline const std::optional<T> &launchSetting(const LaunchSetting<T> &setting) {
    if(!setting.error.empty())throw std::runtime_error(setting.error);
    return setting.value;
}
inline bool resolutionAutomatic() {return launchSetting(nativeConfig().render.automatic).value_or(false);}
inline std::optional<double> resolutionMultiplier() {return launchSetting(nativeConfig().render.multiplier);}
inline std::optional<unsigned> resolutionHeight() {return launchSetting(nativeConfig().render.height);}
inline std::optional<unsigned> resolutionMaxHeight() {return launchSetting(nativeConfig().render.maximum);}
// One configuration load; the settings are checked in the accessors' order.
inline bool resolutionRequested() {
    const auto &render=nativeConfig().render;
    return launchSetting(render.automatic).value_or(false)||launchSetting(render.height).has_value()||launchSetting(render.maximum).has_value()||launchSetting(render.multiplier).has_value();
}
// Only a cooperating publisher can change its final drawable allocation.
// Engines with fixed final viewports/blits must use their renderer API instead;
// their requested dimensions still remain available to that engine adapter.
inline bool drawableResolutionRequested() {
    return nativeConfig().render.control=="drawable"&&resolutionRequested();
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
