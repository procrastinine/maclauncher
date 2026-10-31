#include "window-overlay-policy.hpp"
#include <cassert>
#include <cstdio>
using namespace macfx;
int main(){
    // Capture-rate cap: 0.75 of the interval separates accepted captures.
    assert(windowCaptureInterval(0)==0&&windowCaptureInterval(-1)==0&&windowCaptureInterval(NAN)==0&&windowCaptureInterval(5000)==0);
    const double interval=windowCaptureInterval(30);assert(std::fabs(interval-1./30)<1e-12);
    assert(windowCaptureIntervalAccepted(1,0,interval)); // First capture.
    assert(windowCaptureIntervalAccepted(1.001,1,0)); // No cap.
    assert(!windowCaptureIntervalAccepted(1+interval*.7,1,interval));
    assert(windowCaptureIntervalAccepted(1+interval*.75,1,interval));
    assert(windowCaptureIntervalAccepted(1+interval*.8,1,interval));
    // A 60 Hz source under a 30 fps cap keeps every other frame.
    unsigned kept=0;double last=0;for(unsigned i=1;i<=60;++i){const double t=i/60.;if(windowCaptureIntervalAccepted(t,last,interval)){++kept;last=t;}}
    assert(kept==30);
    // Window-server top-left bounds become AppKit bottom-left frames.
    const auto frame=windowOverlayFrame({100,50,800,600},1080);
    assert(frame.x==100&&frame.y==430&&frame.width==800&&frame.height==600);
    // A secondary display above the primary has negative window-server y.
    const auto above=windowOverlayFrame({0,-1440,2560,1440},1080);assert(above.y==1080);
    assert(windowRectValid({0,0,1,1})&&!windowRectValid({0,0,0,10})&&!windowRectValid({0,0,NAN,10})&&!windowRectValid({0,0,20000,10}));
    // Pixel extent at the screen's backing scale.
    assert(windowPixelExtent(800,2)==1600&&windowPixelExtent(800.5,2)==1601&&windowPixelExtent(1000,1.5)==1500);
    assert(windowPixelExtent(0,2)==0&&windowPixelExtent(10000,2)==0&&windowPixelExtent(100,0)==0);
    // Overlap: only ordinary windows of other processes that intersect.
    const WindowRect target{100,100,800,600};
    const WindowAbove rows[]={{{0,0,1920,24},25,1,1},{{950,100,200,200},0,2,1},{{850,650,200,200},0,3,0},{{300,300,100,100},0,42,1}};
    assert(!windowOverlapped(target,rows,4,42)); // Menu bar, disjoint, transparent, own overlay.
    const WindowAbove covering[]={{{850,650,200,200},0,3,1}};
    assert(windowOverlapped(target,covering,1,42));
    const WindowAbove touching[]={{{900,100,200,200},0,3,1}};
    assert(!windowOverlapped(target,touching,1,42)); // Shares only an edge.
    // Visibility.
    assert(windowOverlayShown({true,true,false,false}));
    assert(!windowOverlayShown({false,true,false,false})&&!windowOverlayShown({true,false,false,false})&&
        !windowOverlayShown({true,true,true,false})&&!windowOverlayShown({true,true,false,true}));
    // Scaled output shows only while the target's app is active and none of its own windows covers the target.
    assert(windowOverlayShown({true,true,false,false,true,true})&&!windowOverlayShown({true,true,false,false,true,false}));
    assert(!windowOverlayShown({true,true,true,false,true,true})&&!windowOverlayShown({true,true,false,true,true,true}));
    assert(windowOverlapped(target,covering,1,42,3)&&!windowOverlapped(target,covering,1,42,7));
    // Scaled area: the visible frame, or the whole screen for a window that fills it.
    const WindowRect screen{0,0,1512,982},visible{0,33,1512,949};
    const auto area=windowScaledArea({200,200,640,360},screen,visible);assert(area.y==33&&area.height==949);
    assert(windowScaledArea(screen,screen,visible).height==982&&windowScaledArea({200,200,640,360},screen,{}).height==982);
    // Letterbox: a 16:9 window on a taller area gets bars above and below,
    // a 4:3 window on a wide area bars on the sides.
    const auto wide=windowLetterbox(area,640,360);
    assert(wide.x==0&&wide.width==1512&&wide.height==850&&wide.y==33+49);
    const auto narrow=windowLetterbox({0,0,1920,1080},800,600);
    assert(narrow.width==1440&&narrow.height==1080&&narrow.x==240&&narrow.y==0);
    assert(windowLetterbox({0,0,0,0},800,600).width==0&&windowLetterbox({0,0,1920,1080},0,600).width==0);
    // Inside the overlay view (bottom-left origin) the image keeps its bars.
    const auto inView=windowLetterboxInView(area,wide);assert(inView.x==0&&inView.y==50&&inView.height==850); // The bottom bar is 50 points.
    // Retina: the drawable covers the image at the screen's backing scale.
    assert(windowPixelExtent(wide.width,2)==3024&&windowPixelExtent(wide.height,2)==1700);
    // Pointer mapping: image corners and center map to the target window; bars map nowhere.
    const WindowRect window{200,300,640,360};
    const auto center=windowMapPoint(wide,window,wide.x+wide.width/2,wide.y+wide.height/2);
    assert(center&&std::fabs(center->x-520)<1e-9&&std::fabs(center->y-480)<1e-9);
    const auto origin=windowMapPoint(wide,window,wide.x,wide.y);assert(origin&&origin->x==200&&origin->y==300);
    const auto corner=windowMapPoint(wide,window,wide.x+wide.width,wide.y+wide.height);
    assert(corner&&corner->x==200+640-.5&&corner->y==300+360-.5);
    assert(!windowMapPoint(wide,window,10,area.y+5)); // Top bar.
    assert(!windowMapPoint(wide,window,-1,wide.y+10));
    // A view point converts to window-server coordinates before mapping.
    const auto viewPoint=windowViewPoint(area,wide.width/2,50+850/2.);
    const auto viaView=windowMapPoint(wide,window,viewPoint.x,viewPoint.y);assert(viaView&&std::fabs(viaView->x-520)<1e-9&&std::fabs(viaView->y-480)<1e-9);
    // A second display to the left of the primary has negative x.
    const WindowRect left{-1920,0,1920,1080};const auto leftImage=windowLetterbox(left,1280,720);
    assert(leftImage.x==-1920&&leftImage.width==1920);
    const auto leftPoint=windowMapPoint(leftImage,{-1700,100,1280,720},-960,540);assert(leftPoint&&leftPoint->x==-1700+640&&leftPoint->y==100+360);
    std::puts("window overlay policy: capture-rate cap, frame conversion, pixel extent, overlap, visibility, letterbox and pointer mapping passed");
    return 0;
}
