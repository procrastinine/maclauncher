#pragma once
#include "window-stream.hpp"
#include "window-source.h"
#include "iosurface-texture.hpp"
#include <functional>
#include <algorithm>
#include <cstring>
namespace macfx {
inline RSWindowSourceFrame forwardedFrameInfo(const RSWindowSourceFrame *source){
 RSWindowSourceFrame info{};info.contentScale=info.scaleFactor=1;
 if(!source)return info;
 const size_t prefix=std::min(size_t(source->size),size_t(RS_WINDOW_SOURCE_FRAME_BASE_SIZE));
 std::memcpy(&info,source,prefix);
 if(source->size>=sizeof(info))std::memcpy(&info,source,sizeof(info));
 return info;
}
struct ForwardedFrame:WindowStreamSlot {
 IOSurfaceRef surface;RSWindowSourceFrame info;RSWindowSourceReleased released;void *context;
 ForwardedFrame(IOSurfaceRef s,const RSWindowSourceFrame&i,RSWindowSourceReleased r,void*c):surface(s),info(i),released(r),context(c){if(s)CFRetain(s);}
 void release(){auto callback=released;released=nullptr;if(callback)callback(context,info.sequence);}
 ~ForwardedFrame(){release();if(surface)CFRelease(surface);}
};
struct ForwardedStream:WindowStream {
 std::atomic<uint64_t>serviceGeneration{0};std::shared_ptr<ForwardedFrame>forwardPending;bool forwardRetry=false;
 // A held image stays on screen while frames of the service's current
 // generation from `from` onward are dropped: those may show the target
 // moved within the capture. A hold that awaits a generation ends with the
 // service's next one, any other with release(), and every hold at `until`.
 std::atomic<uint64_t>holdGeneration{0};std::atomic<double>holdFrom{0},holdUntil{0};bool holdAwaits=false;
 void hold(double from,double until,bool awaitGeneration); // main thread
 void release(); // main thread
 bool held(const RSWindowSourceFrame&)const;
 // Whether the windows that shape the capture still match the source's last
 // check, asked on the render queue for each frame. A frame that arrives
 // while they do not is dropped, so the shown image stays until that check
 // places its hold or finds nothing that moves the image.
 std::function<bool()>settled;
 void updateForwarded(const BrowserFrameGeometry&,uint64_t,NSRect,CGFloat,CGSize);
 void submit(std::shared_ptr<ForwardedFrame>);
 void consume(std::shared_ptr<ForwardedFrame>);
};
}
