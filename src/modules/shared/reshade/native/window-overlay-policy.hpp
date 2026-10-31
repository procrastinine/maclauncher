#pragma once
#include <algorithm>
#include <cmath>
#include <optional>
// Pure policy for a picked window or display: the capture-rate cap, the
// overlay frame, its visibility, the source extent and Scaled output's
// letterbox and pointer mapping. No AppKit, capture or GPU object is touched.
namespace macfx {
// A capture closer than 0.75 of the cap interval to the previous accepted one
// is dropped, so a source slightly faster than the cap keeps its cadence.
inline bool windowCaptureIntervalAccepted(double time,double previous,double interval)noexcept {
    return !(interval>0)||!(previous>0)||!std::isfinite(interval)||time-previous>=interval*.75-1e-9;
}
inline double windowCaptureInterval(double framesPerSecond)noexcept {
    return std::isfinite(framesPerSecond)&&framesPerSecond>=1&&framesPerSecond<=1000?1/framesPerSecond:0;
}
struct WindowRect {double x=0,y=0,width=0,height=0;};
inline bool windowRectValid(const WindowRect &r)noexcept {
    return std::isfinite(r.x)&&std::isfinite(r.y)&&std::isfinite(r.width)&&std::isfinite(r.height)&&r.width>=1&&r.height>=1&&r.width<=16384&&r.height<=16384;
}
// Window-server bounds have a top-left origin on the primary display; AppKit
// frames have a bottom-left origin there. Both use points.
inline WindowRect windowOverlayFrame(const WindowRect &bounds,double primaryHeight)noexcept {
    return {bounds.x,primaryHeight-bounds.y-bounds.height,bounds.width,bounds.height};
}
inline bool windowRectsOverlap(const WindowRect &a,const WindowRect &b)noexcept {
    const double w=std::min(a.x+a.width,b.x+b.width)-std::max(a.x,b.x),h=std::min(a.y+a.height,b.y+b.height)-std::max(a.y,b.y);
    return w>=1&&h>=1;
}
// Pixel extent of a captured source at the backing scale of its screen.
inline unsigned windowPixelExtent(double points,double scale)noexcept {
    if(!std::isfinite(points)||!std::isfinite(scale)||points<1||scale<=0)return 0;
    const double pixels=std::ceil(points*scale-1e-6);return pixels>16384?0:unsigned(pixels);
}
// A window above the target that intersects it would be covered by the
// overlay, which floats above ordinary windows. The overlay hides instead.
// Only ordinary windows (layer 0) of other processes count; menus, the
// menu bar and the Dock stay above the overlay. A nonzero onlyPid counts
// only that process's windows.
struct WindowAbove {WindowRect bounds;int layer=0;int pid=0;double alpha=1;};
inline bool windowOverlapped(const WindowRect &target,const WindowAbove *above,unsigned count,int ownPid,int onlyPid=0)noexcept {
    for(unsigned i=0;i<count;++i)if(above[i].layer==0&&above[i].pid!=ownPid&&(!onlyPid||above[i].pid==onlyPid)&&above[i].alpha>0&&
        windowRectsOverlap(target,above[i].bounds))return true;
    return false;
}
// In place, the overlay hides while another window covers the target. Scaled
// output covers the target's screen, so it shows only while the target's app
// is active, and overlapped counts only that app's own windows, such as a
// dialog in front of the target.
struct WindowOverlayState {bool processing=false,onScreen=false,overlapped=false,suspended=false,scaled=false,targetActive=true;};
inline bool windowOverlayShown(const WindowOverlayState &s)noexcept {
    return s.processing&&s.onScreen&&!s.suspended&&!s.overlapped&&(!s.scaled||s.targetActive);
}

// Scaled output. All rectangles here use window-server coordinates: points
// with a top-left origin on the primary display.
//
// The area a scaled image covers: the whole screen when the target fills it,
// as a native full-screen window does, and otherwise the screen's visible
// frame, which leaves out the menu bar and the Dock.
inline WindowRect windowScaledArea(const WindowRect &target,const WindowRect &screen,const WindowRect &visible)noexcept {
    const auto near=[](double a,double b){return std::fabs(a-b)<.5;};
    const bool fills=near(target.x,screen.x)&&near(target.y,screen.y)&&near(target.width,screen.width)&&near(target.height,screen.height);
    return fills||!windowRectValid(visible)?screen:visible;
}
// The largest rectangle with the source's aspect ratio centered in the area,
// on whole points so the image edges stay sharp.
inline WindowRect windowLetterbox(const WindowRect &area,double width,double height)noexcept {
    if(!windowRectValid(area)||!(width>0)||!(height>0)||!std::isfinite(width)||!std::isfinite(height))return {};
    const double scale=std::min(area.width/width,area.height/height);
    const double w=std::max(1.0,std::floor(width*scale+1e-6)),h=std::max(1.0,std::floor(height*scale+1e-6));
    return {area.x+std::floor((area.width-w)/2),area.y+std::floor((area.height-h)/2),w,h};
}
// The image's frame inside an overlay view whose frame is `area`; AppKit
// views have a bottom-left origin.
inline WindowRect windowLetterboxInView(const WindowRect &area,const WindowRect &image)noexcept {
    return {image.x-area.x,area.y+area.height-image.y-image.height,image.width,image.height};
}
struct WindowPoint {double x=0,y=0;};
// The point in the target window that corresponds to a point on the scaled
// image; empty on a letterbox bar. Points on the image's far edges map to the
// target's last point inside it.
inline std::optional<WindowPoint> windowMapPoint(const WindowRect &image,const WindowRect &target,double x,double y)noexcept {
    if(!windowRectValid(image)||!windowRectValid(target)||!std::isfinite(x)||!std::isfinite(y))return std::nullopt;
    if(x<image.x||y<image.y||x>image.x+image.width||y>image.y+image.height)return std::nullopt;
    const double u=(x-image.x)/image.width,v=(y-image.y)/image.height;
    return WindowPoint{target.x+std::min(u*target.width,target.width-.5),target.y+std::min(v*target.height,target.height-.5)};
}
// A point in an overlay view (bottom-left origin) whose frame is `area`, in
// window-server coordinates.
inline WindowPoint windowViewPoint(const WindowRect &area,double x,double y)noexcept {return {area.x+x,area.y+area.height-y};}
}
