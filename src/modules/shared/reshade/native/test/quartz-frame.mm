#include "../quartz-frame.hpp"
#import <objc/message.h>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>

namespace {
unsigned checks=0,scopeCalls=0,baseCalls=0,childCalls=0,forwardCalls=0;
NSRect received;
void check(bool value,const char*message){++checks;if(!value){std::fprintf(stderr,"FAIL: %s\n",message);std::exit(1);}}
void scope(id object,NSRect rect,macfx::QuartzDrawImplementation original){++scopeCalls;original(object,@selector(drawRect:),rect);}
CGImageRef image(unsigned width=2,unsigned height=2){
    auto color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    auto context=CGBitmapContextCreate(nullptr,width,height,8,width*4,color,kCGImageAlphaNoneSkipFirst|kCGBitmapByteOrder32Little);
    auto result=CGBitmapContextCreateImage(context);CGContextRelease(context);CGColorSpaceRelease(color);return result;
}
}
@interface QuartzBaseTest : NSObject
- (void)drawRect:(NSRect)rect;
@end
@implementation QuartzBaseTest
- (void)drawRect:(NSRect)rect{++baseCalls;received=rect;}
@end
@interface QuartzChildTest : QuartzBaseTest
@end
@implementation QuartzChildTest
- (void)drawRect:(NSRect)rect{++childCalls;[super drawRect:rect];}
@end
@interface QuartzForwardTest : NSObject
@end
@implementation QuartzForwardTest
- (void)forwardInvocation:(NSInvocation*)invocation{
    check(invocation.selector==@selector(drawRect:),"forwarding preserves drawRect selector");
    [invocation getArgument:&received atIndex:2];++forwardCalls;
}
@end
int main(){@autoreleasepool{
    auto overlay=[[MacFXQuartzPresentationView alloc]initWithFrame:NSMakeRect(0,0,32,32)];
    check(!overlay.isOpaque,"presentation host does not occlude the original Quartz producer");
    check(!overlay.acceptsFirstResponder&&![overlay hitTest:NSMakePoint(1,1)],"presentation host leaves game input untouched");
    auto full=image(),other=image(),small=image(1,1);
    {
        auto retained=macfx::QuartzFrameImage::retain(full);
        check(retained&&macfx::quartzImageReservation()==CGImageGetBytesPerRow(full)*CGImageGetHeight(full),"queued source references are accounted");
        retained.reset();check(macfx::quartzImageReservation()==0,"queued source budget releases with its last reference");
        macfx::quartzImageReservation().store(256u*1024u*1024u);
        check(!macfx::QuartzFrameImage::retain(full),"queued source references respect the global bound");
        macfx::quartzImageReservation().store(0);
    }
    auto destination=reinterpret_cast<CGContextRef>(uintptr_t(1));
    auto unrelated=reinterpret_cast<CGContextRef>(uintptr_t(2));
    {
        macfx::QuartzFrameCapture capture(destination,CGSizeMake(2,2),CGSizeMake(4,4));
        capture.bitmap(full);check(!capture.completed(),"unused complete bitmap is not a displayed frame");
        capture.draw(unrelated,full);check(!capture.completed(),"offscreen drawing is not the view destination");
        capture.draw(destination,full);check(capture.completed()==full,"full image is retained after original drawing");
    }
    {
        macfx::QuartzFrameCapture capture(destination,CGSizeMake(2,2),CGSizeMake(4,4));
        capture.bitmap(small);capture.draw(destination,small);check(!capture.completed(),"small intermediate image is excluded");
        capture.bitmap(full);capture.draw(destination,other);check(!capture.completed(),"unrelated image does not admit a candidate");
        auto crop=CGImageCreateWithImageInRect(full,CGRectMake(0,0,1,1));
        capture.crop(full,crop);capture.draw(destination,crop);CGImageRelease(crop);
        check(capture.completed()==full,"dirty crop admits its complete source image");
    }
    {
        macfx::QuartzFrameCapture capture(destination,CGSizeMake(2,2),CGSizeMake(4,4));
        capture.bitmap(full);capture.draw(destination,full);capture.bitmap(other);
        check(!capture.completed(),"multiple full-size candidates fail closed");
    }
    {
        auto physical=image(4,4);macfx::QuartzFrameCapture capture(destination,CGSizeMake(2,2),CGSizeMake(4,4));
        capture.bitmap(physical);capture.draw(destination,physical);CGImageRelease(physical);
        check(capture.completed()!=nullptr,"backing-resolution image is admitted and retained");
    }
    {
        macfx::QuartzFrameCapture capture(destination,CGSizeMake(2,2),CGSizeMake(2,2));capture.bitmap(full);
        for(unsigned i=0;i<65;++i){auto crop=image(1,1);capture.crop(full,crop);CGImageRelease(crop);}
        capture.draw(destination,full);check(!capture.completed(),"crop identities are bounded");
    }
    const NSRect rect=NSMakeRect(3.25,4.5,120,81);
    check(macfx::installQuartzDrawScope(QuartzBaseTest.class,scope),"base draw method is wrapped");
    check(macfx::installQuartzDrawScope(QuartzChildTest.class,scope),"subclass override is wrapped");
    check(!macfx::installQuartzDrawScope(QuartzChildTest.class,scope),"repeat installation is idempotent");
    [[QuartzChildTest new]drawRect:rect];
    check(scopeCalls==2&&baseCalls==1&&childCalls==1,"superclass wrapper calls its exact original IMP once");
    check(NSEqualRects(received,rect),"NSRect ABI survives direct original invocation");
    auto method=class_getInstanceMethod(QuartzBaseTest.class,@selector(drawRect:));
    auto forwarding=reinterpret_cast<IMP>(dlsym(RTLD_DEFAULT,"_objc_msgForward"));
    check(forwarding!=nullptr,"Objective-C forwarding entry exists");
    check(class_addMethod(QuartzForwardTest.class,@selector(drawRect:),forwarding,method_getTypeEncoding(method)),"forwarding draw method is installed");
    check(macfx::installQuartzDrawScope(QuartzForwardTest.class,scope),"forwarded draw method is wrapped");
    reinterpret_cast<void(*)(id,SEL,NSRect)>(objc_msgSend)([QuartzForwardTest new],@selector(drawRect:),rect);
    check(forwardCalls==1&&scopeCalls==3&&NSEqualRects(received,rect),"forwardInvocation keeps original selector and NSRect ABI");
    CGImageRelease(full);CGImageRelease(other);CGImageRelease(small);
    std::printf("%u Quartz capture checks passed\n",checks);
}}
