#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
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
// The overlay shows while effects run and the target is on screen. A
// minimized target or one on another Space has nothing to draw over, and its
// capture continues. Scaled output covers the target's screen and takes the
// pointer, so it shows only while the target's app is active; otherwise it
// would cover every other app.
struct WindowOverlayState {bool processing=false,onScreen=false,suspended=false,scaled=false,targetActive=true;};
inline bool windowOverlayShown(const WindowOverlayState &s)noexcept {
    return s.processing&&s.onScreen&&!s.suspended&&(!s.scaled||s.targetActive);
}
// A window's overlay level: one fixed level above the target's own, at least
// the floating level (3) that keeps it above ordinary windows (0), and below
// pop-up menus (101), so the Dock (20), the menu bar (24), menus and the
// target app's panels above ordinary windows stay in front of it.
inline int windowOverlayLevel(int targetLayer)noexcept {
    constexpr int floating=3,belowMenus=100;
    return targetLayer>=floating&&targetLayer<belowMenus?targetLayer+1:floating;
}
inline bool windowRectContains(const WindowRect &outer,const WindowRect &inner)noexcept {
    return inner.x>=outer.x&&inner.y>=outer.y&&inner.x+inner.width<=outer.x+outer.width&&inner.y+inner.height<=outer.y+outer.height;
}
// A window above the target in the window server's list, front to back.
// `overlay` marks the overlays of this process, which never cover a target.
// `child` marks a known child window of the target (see windowChildWindows).
struct WindowAbove {uint32_t id=0;int pid=0,layer=0;double alpha=1;WindowRect bounds;bool overlay=false,child=false;};
// Whether a window above the target covers it: a visible window that
// overlaps the target, at the target's layer or above and below the level
// the overlay keeps in front. The target's capture shows its child windows,
// so they never cover it. Windows of the target's app at the target's own
// layer that lie within it, such as sheets, count as child windows before
// they are known.
inline bool windowCoversTarget(const WindowAbove &w,int targetPid,int targetLayer,const WindowRect &target)noexcept {
    if(w.overlay||w.child||!(w.alpha>.01)||w.layer<targetLayer||w.layer>=windowOverlayLevel(targetLayer))return false;
    if(w.pid==targetPid&&w.layer==targetLayer&&windowRectContains(target,w.bounds))return false;
    return windowRectsOverlap(w.bounds,target);
}
// The window server orders a window together with its child windows, which
// stay directly above it. An overlay ordered directly above the target
// therefore lands above the target's child windows, and the windows listed
// between the overlay and the target are exactly those child windows.
// Returns how many windows follow the overlay in a front-to-back list of the
// windows above the target, or zero when the overlay is not in it.
inline size_t windowChildWindows(uint32_t overlay,const WindowAbove *above,size_t count)noexcept {
    for(size_t i=0;i<count;++i)if(above[i].id==overlay)return count-i-1;
    return 0;
}
// ScreenCaptureKit crops a window's capture from the bounds of the window and
// its child windows together, so a child window that reaches past the
// window's left or top edge moves the crop by that much, and the capture
// reports no such offset. The crop that keeps the image on the target: its
// offset within those bounds, in points, and its size.
inline WindowRect windowCaptureCrop(const WindowRect &target,const WindowAbove *above,size_t count)noexcept {
    double left=target.x,top=target.y;
    for(size_t i=0;i<count;++i)if(above[i].child){left=std::min(left,above[i].bounds.x);top=std::min(top,above[i].bounds.y);}
    return {target.x-left,target.y-top,target.width,target.height};
}
// Where an in-place overlay stacks. With nothing over the target, it keeps
// the front level and is ordered front, so the target's app raising its own
// window within the ordinary levels leaves the overlay above it. When a
// window covers the target, the overlay takes the target's level, directly
// above the target, so that window covers the effect as it covers the
// target.
enum class WindowOverlayOrder {front,aboveTarget};
struct WindowOverlayPlacement {int level=0;WindowOverlayOrder order=WindowOverlayOrder::front;};
inline bool operator==(const WindowOverlayPlacement &a,const WindowOverlayPlacement &b)noexcept {return a.level==b.level&&a.order==b.order;}
inline WindowOverlayPlacement windowOverlayPlacement(int targetPid,int targetLayer,const WindowRect &target,const WindowAbove *above,size_t count)noexcept {
    for(size_t i=0;i<count;++i)if(windowCoversTarget(above[i],targetPid,targetLayer,target))return {targetLayer,WindowOverlayOrder::aboveTarget};
    return {windowOverlayLevel(targetLayer),WindowOverlayOrder::front};
}
// Whether the overlay already stacks as `placement` asks, from the list of
// windows above the target, front to back, which includes the overlay when
// it is above the target. In front it is at its level and visible. Above the
// target it is at the target's level, above the target and behind every
// window that covers the target.
inline bool windowOverlayPlaced(const WindowOverlayPlacement &placement,int level,bool visible,uint32_t overlay,
                                const WindowAbove *above,size_t count,int targetPid,int targetLayer,const WindowRect &target)noexcept {
    if(!visible||level!=placement.level)return false;
    if(placement.order==WindowOverlayOrder::front)return true;
    size_t index=count;for(size_t i=0;i<count;++i)if(above[i].id==overlay){index=i;break;}
    if(index==count)return false;
    for(size_t i=index+1;i<count;++i)if(windowCoversTarget(above[i],targetPid,targetLayer,target))return false;
    return true;
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
