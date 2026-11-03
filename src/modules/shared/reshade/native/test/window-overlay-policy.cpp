#include "window-overlay-policy.hpp"
#include <cassert>
#include <cstdio>
#include <vector>
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
    // Overlap of rectangles, which shares no edge-only contact.
    const WindowRect target{100,100,800,600};
    assert(windowRectsOverlap(target,{850,650,200,200})&&!windowRectsOverlap(target,{900,100,200,200})&&!windowRectsOverlap(target,{950,100,200,200}));
    // Level: floating above ordinary windows, one above a target that floats itself, below pop-up menus.
    assert(windowOverlayLevel(0)==3&&windowOverlayLevel(-20)==3&&windowOverlayLevel(3)==4&&windowOverlayLevel(19)==20&&windowOverlayLevel(101)==3);
    // Visibility: shown while processing an on-screen target, whichever app is active; hidden when off screen or suspended.
    assert(windowOverlayShown({true,true,false})&&windowOverlayShown({true,true,false,false,false}));
    assert(!windowOverlayShown({false,true,false})&&!windowOverlayShown({true,false,false})&&!windowOverlayShown({true,true,true}));
    // Scaled output shows only while the target's app is active.
    assert(windowOverlayShown({true,true,false,true,true})&&!windowOverlayShown({true,true,false,true,false}));
    assert(!windowOverlayShown({true,false,false,true,true})&&!windowOverlayShown({true,true,true,true,true}));
    // Stacking. In front of a target that nothing covers, the overlay keeps the front level.
    const int app=100; // The target's process; `target` above is its window.
    auto place=[&](std::initializer_list<WindowAbove> above,int layer=0){const std::vector<WindowAbove> list(above);
        return windowOverlayPlacement(app,layer,target,list.data(),list.size());};
    const WindowOverlayPlacement front{3,WindowOverlayOrder::front},aboveTarget{0,WindowOverlayOrder::aboveTarget};
    assert(place({})==front);
    // Another app's window over the target covers it; one beside it, the menu bar and the Dock do not.
    assert(place({{1,200,0,1,{500,400,600,500}}})==aboveTarget);
    assert(place({{1,200,0,1,{950,100,300,300}},{2,300,24,1,{0,0,1920,30}},{3,300,20,1,{0,1000,1920,80}}})==front);
    // An invisible window, a pop-up menu above the front level and the process's own overlays never cover it.
    assert(place({{1,200,0,0,{100,100,800,600}},{2,200,101,1,{200,200,100,100}},{3,app,3,1,{100,100,800,600},true},{4,500,0,1,{100,100,800,600},true}})==front);
    // The target's own child windows (a sheet, a small window over its title bar) lie within it at its layer and do not cover it;
    // another window of the same app that reaches outside it does, as does one at a layer between the target's and the front level.
    assert(place({{1,app,0,1,{106,106,66,20}},{2,app,0,1,{300,130,400,300}}})==front);
    assert(place({{1,app,0,1,{600,300,500,500}}})==aboveTarget);
    assert(place({{1,app,1,1,{300,300,100,100}}})==aboveTarget);
    // A floating target keeps one level above its own; only windows from its layer up to that level cover it.
    assert(place({},3)==(WindowOverlayPlacement{4,WindowOverlayOrder::front}));
    assert(place({{1,200,0,1,{100,100,800,600}}},3)==(WindowOverlayPlacement{4,WindowOverlayOrder::front}));
    assert(place({{1,200,3,1,{100,100,800,600}}},3)==(WindowOverlayPlacement{3,WindowOverlayOrder::aboveTarget}));
    // A known child window never covers the target, wherever it reaches; the capture shows it.
    assert(place({{1,app,0,1,{600,300,500,500},false,true},{2,app,0,1,{50,300,120,60},false,true}})==front);
    // Windows after the overlay in the list above the target, once it is directly above the target, are its child windows.
    const std::vector<WindowAbove> grouped{{7,200,0,1,{500,400,600,500}},{9,app,0,1,{100,100,800,600},true},{4,app,0,1,{50,300,120,60}},{5,app,0,1,{106,106,66,20}}};
    assert(windowChildWindows(9,grouped.data(),grouped.size())==2&&windowChildWindows(7,grouped.data(),grouped.size())==3);
    assert(windowChildWindows(3,grouped.data(),grouped.size())==0&&windowChildWindows(5,grouped.data(),grouped.size())==0);
    // The crop keeps the image on the target: a child window past its left or top edge moves the crop by that much,
    // one past its right or bottom edge, an unknown window and another window do not.
    auto crop=[&](std::initializer_list<WindowAbove> above){const std::vector<WindowAbove> list(above);
        return windowCaptureCrop(target,list.data(),list.size());};
    auto at=[](const WindowRect &r,double x,double y){return r.x==x&&r.y==y&&r.width==800&&r.height==600;};
    assert(at(crop({}),0,0)&&at(crop({{1,app,0,1,{600,300,500,500},false,true},{2,app,0,1,{50,300,120,60}},{3,200,0,1,{0,0,50,50}}}),0,0));
    assert(at(crop({{1,app,0,1,{50,300,120,60},false,true}}),50,0)&&at(crop({{1,app,0,1,{300,60,120,60},false,true},{2,app,3,1,{70,500,40,40},false,true}}),30,40));
    // Applied: in front at the level and visible; above the target, behind every window that covers it.
    const std::vector<WindowAbove> covering{{7,200,0,1,{500,400,600,500}},{9,app,3,1,{100,100,800,600},true},{8,app,0,1,{106,106,66,20}}};
    assert(windowOverlayPlaced(front,3,true,9,nullptr,0,app,0,target)&&!windowOverlayPlaced(front,3,false,9,nullptr,0,app,0,target));
    assert(!windowOverlayPlaced(front,0,true,9,nullptr,0,app,0,target));
    assert(!windowOverlayPlaced(aboveTarget,3,true,9,covering.data(),covering.size(),app,0,target)); // Still at the front level.
    const std::vector<WindowAbove> placedList{{7,200,0,1,{500,400,600,500}},{8,app,0,1,{106,106,66,20}},{9,app,0,1,{100,100,800,600},true}};
    assert(windowOverlayPlaced(aboveTarget,0,true,9,placedList.data(),placedList.size(),app,0,target));
    const std::vector<WindowAbove> inFront{{9,app,0,1,{100,100,800,600},true},{7,200,0,1,{500,400,600,500}}};
    assert(!windowOverlayPlaced(aboveTarget,0,true,9,inFront.data(),inFront.size(),app,0,target)); // In front of the covering window.
    const std::vector<WindowAbove> raised{{7,200,0,1,{500,400,600,500}}};
    assert(!windowOverlayPlaced(aboveTarget,0,true,9,raised.data(),raised.size(),app,0,target)); // The target was raised above it.
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
    std::puts("window overlay policy: capture-rate cap, frame conversion, pixel extent, overlap, visibility, stacking, letterbox and pointer mapping passed");
    return 0;
}
