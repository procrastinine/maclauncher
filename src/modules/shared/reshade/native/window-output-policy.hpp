#pragma once
#include "window-overlay-policy.hpp"
namespace macfx {
inline WindowRect windowFactorArea(const WindowRect&t,const WindowRect&v,double factor)noexcept {
 if(!windowRectValid(t)||!windowRectValid(v)||!std::isfinite(factor)||factor<=0)return {};
 const double f=std::min({factor,v.width/t.width,v.height/t.height});
 const double w=std::floor(t.width*f),h=std::floor(t.height*f);
 return {std::clamp(std::floor(t.x+(t.width-w)/2),v.x,v.x+v.width-w),std::clamp(std::floor(t.y+(t.height-h)/2),v.y,v.y+v.height-h),w,h};
}
inline WindowPoint windowImagePoint(const WindowRect&i,const WindowRect&t,double x,double y)noexcept {
 return {i.x+(x-t.x)*i.width/t.width,i.y+(y-t.y)*i.height/t.height};
}
}
