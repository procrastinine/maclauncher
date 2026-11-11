#include "presentation.hpp"
#include "fixture-files.hpp"
#include "fixture-colour-shaders.hpp"
#include "effects-execution.hpp"
#include "live-controls.hpp"
#include "process-phase.hpp"
#import <Cocoa/Cocoa.h>
#import <CommonCrypto/CommonDigest.h>
#import <QuartzCore/CATransaction.h>
#include <array>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
#include <unistd.h>

namespace {
NSString *shaderRoot;
void idle(double seconds){const auto until=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<until){
    CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);
    if(NSApp){NSEvent *event;while((event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES]))[NSApp sendEvent:event];[NSApp updateWindows];}
}}
NSString *hex(NSString *value){return [@"" stringByPaddingToLength:64 withString:value startingAtIndex:0];}
std::string hash(NSData *data){unsigned char bytes[CC_SHA256_DIGEST_LENGTH];CC_SHA256(data.bytes,CC_LONG(data.length),bytes);char text[65];for(unsigned i=0;i<sizeof(bytes);++i)std::snprintf(text+2*i,3,"%02x",bytes[i]);return text;}
NSData *packet(bool enabled,float sharpness=.5){macfx::LivePacket value{};std::memcpy(value.magic,"MLFXCTL2",8);value.flags=enabled?8:0;value.targetHz=60;value.multiplier=2;value.sharpness=sharpness;value.flowScale=1;
    std::memset(value.effectKey,'a',64);std::memset(value.revision,'b',64);return [NSData dataWithBytes:&value length:sizeof(value)];}
NSDictionary *contract(const macfx::PresentationContract &value,bool candidate=false){NSMutableDictionary *result=[@{@"planRevision":@(value.planRevision.c_str()),@"controlsDigest":@(value.controlsDigest.c_str())}mutableCopy];if(candidate)result[@"requiresPresentation"]=@YES;return result;}
NSData *command(uint64_t epoch,NSString *action,const macfx::PresentationContract &expected,const macfx::PresentationContract &candidate){
    NSMutableDictionary *root=[@{@"schema":@1,@"launchId":@"hold-test",@"token":@"hold-token",@"epoch":@(epoch),@"transactionId":@"transaction",@"action":action,@"expected":contract(expected)}mutableCopy];
    if([action isEqual:@"hold"])root[@"candidate"]=contract(candidate,true);return [NSJSONSerialization dataWithJSONObject:root options:0 error:nil];
}
void protocol(NSString *directory,const macfx::PresentationContract &a,const macfx::PresentationContract &b){
    auto valid=command(1,@"hold",a,b);auto parsed=macfx::PresentationHoldReader::parse(valid,"hold-test","hold-token");assert(parsed.epoch==1&&parsed.expected==a&&parsed.candidate==b);
    const auto reject=[&](NSData *data){bool failed=false;try{macfx::PresentationHoldReader::parse(data,"hold-test","hold-token");}catch(const std::exception&){failed=true;}assert(failed);};
    for(NSString *field in @[@"token",@"launchId",@"epoch",@"action",@"expected",@"candidate"]){
        auto root=[[NSJSONSerialization JSONObjectWithData:valid options:NSJSONReadingMutableContainers error:nil]mutableCopy];
        root[field]=[field isEqual:@"epoch"]?@YES:[field isEqual:@"expected"]||[field isEqual:@"candidate"]?@{}:@"invalid";
        reject([NSJSONSerialization dataWithJSONObject:root options:0 error:nil]);
    }
    reject([NSMutableData dataWithLength:4097]);
    const auto abandoned=macfx::PresentationHoldReader::parse(command(3,@"abandon",a,b),"hold-test","hold-token");assert(abandoned.action=="abandon"&&abandoned.expected==a&&abandoned.candidate.planRevision.empty());
    // The phase was launched with this channel (see main).
    auto input=[directory stringByAppendingPathComponent:@"presentation-control-hold-test.json"],output=[directory stringByAppendingPathComponent:@"presentation-status-hold-test.json"];
    macfx::PresentationHoldReader reader;assert(reader.configured());assert(replaceFile(valid,input));assert(reader.poll()->epoch==1);
    assert(replaceFile(command(1,@"present",b,b),input));assert(!reader.poll());
    assert(replaceFile(command(2,@"cancel",a,b),input));assert(reader.poll()->action=="cancel");
    macfx::PresentationHoldStatus state;state.state="held";state.epoch=2;state.transactionId="transaction";state.contract=a;state.presentedTime=1;state.width=128;state.height=96;state.frameId=1;
    state.holding=true;reader.status(state,42);auto status=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:output]options:0 error:nil];assert([status[@"window"] intValue]==42&&[status[@"state"] isEqual:@"held"]&&CFGetTypeID((__bridge CFTypeRef)status[@"holding"])==CFBooleanGetTypeID()&&[status[@"holding"] boolValue]);
    state.state="failed";state.holding=false;reader.status(state,42);status=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:output]options:0 error:nil];assert(![status[@"holding"] boolValue]);
}
void publish(NSString *file,NSString *revision,double gain,bool enabled=true,bool settle=true){
    auto row=@{@"id":@"display",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":fixture::colourShaderPath(shaderRoot),@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":@{@"Gain":@[@(gain)]},@"preservesCoordinates":@YES};
    auto value=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":enabled?@[row]:@[]};
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:value options:0 error:nil],file));if(settle)idle(.12);
}
void commit(id<MTLCommandBuffer>commands){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}
void awaitState(macfx::FramePresenter &presenter,const std::string &expected){const auto deadline=CACurrentMediaTime()+3;while(presenter.presentationHoldStatus().state!=expected&&CACurrentMediaTime()<deadline)idle(.005);assert(presenter.presentationHoldStatus().state==expected);}
id<MTLTexture> image(id<MTLDevice>device,unsigned width,unsigned height){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto value=[device newTextureWithDescriptor:descriptor];assert(value);std::vector<unsigned char>bytes(width*height*4,255);[value replaceRegion:MTLRegionMake2D(0,0,width,height)mipmapLevel:0 withBytes:bytes.data() bytesPerRow:width*4];return value;}
}
int main(int argc,char **argv){@autoreleasepool{
    auto first=packet(true),second=packet(true,.8);macfx::PresentationContract a{[hex(@"a")UTF8String],hash(first)},b{[hex(@"b")UTF8String],hash(second)};
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        char temporary[1024];temporaryPath(temporary,"maclauncher-presentation-hold-XXXXXX");assert(mkdtemp(temporary));NSString *directory=@(temporary);fixture::writeColourShaders(directory);
        // The hold channel, explicit host, live controls and plan file are
        // launch settings, so each part runs as a phase launched with them.
        fixture::Environment environment{{"RESHADE_PRESENTATION_CONTROL_FILE",[directory stringByAppendingPathComponent:@"presentation-control-hold-test.json"].fileSystemRepresentation},
            {"RESHADE_PRESENTATION_STATUS_FILE",[directory stringByAppendingPathComponent:@"presentation-status-hold-test.json"].fileSystemRepresentation},
            {"RESHADE_PRESENTATION_LAUNCH_ID","hold-test"},{"RESHADE_PRESENTATION_TOKEN","hold-token"}};
        int status=fixture::runPhase("protocol",environment,{temporary});
        const bool protocolOnly=argc==2&&!std::strcmp(argv[1],"--protocol");
        if(!status&&protocolOnly)std::puts("Presentation hold protocol: bounded identities, candidates, stale epochs and status passed");
        if(!status&&!protocolOnly){
            environment.insert(environment.end(),{{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_LIVE_EFFECTS",temporary},
                {"RESHADE_CONTROL_FILE",[directory stringByAppendingPathComponent:@"controls.bin"].fileSystemRepresentation},{"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation}});
            status=fixture::runPhase("window",environment,{temporary});
        }
        [NSFileManager.defaultManager removeItemAtPath:directory error:nil];return status;
    }
    assert(phase.argc==2);NSString *directory=@(phase.argv[1]),*plan=[directory stringByAppendingPathComponent:@"plan.json"],*control=[directory stringByAppendingPathComponent:@"controls.bin"];
    if(phase.name=="protocol"){protocol(directory,a,b);return 0;}
    shaderRoot=directory;
    assert(replaceFile(first,control));publish(plan,@"a",.2);[NSApplication sharedApplication];assert([NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]);[NSApp finishLaunching];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    const auto initialUntil=CACurrentMediaTime()+3;
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,256,192)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    auto layer=[CAMetalLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.opaque=YES;layer.displaySyncEnabled=YES;window.contentView.wantsLayer=YES;window.contentView.layer=[CALayer layer];layer.frame=window.contentView.bounds;[window.contentView.layer addSublayer:layer];
    // Keep the CAMetalLayer below the view backing layer: AppKit owns the
    // backing layer contents and may clear a drawable during view display.
    // A fully occluded window correctly reports a zero display timestamp, so
    // the window must actually be visible on a display. Activation is not
    // needed for that and is not available everywhere (another process may
    // hold secure input, and from macOS 14 activation is a request the active
    // application may decline): the window is ordered above ordinary windows
    // without activating the fixture.
    window.level=NSStatusWindowLevel;[window orderFrontRegardless];
    while(!(window.occlusionState&NSWindowOcclusionStateVisible)&&CACurrentMediaTime()<initialUntil)idle(.005);
    std::fprintf(stderr,"Hold window ready: occlusion=%lu window=%ld\n",(unsigned long)window.occlusionState,(long)window.windowNumber);
    assert(window.isVisible&&(window.occlusionState&NSWindowOcclusionStateVisible));
    [window display];[window.contentView displayIfNeeded];layer.drawableSize=CGSizeMake(128,96);[CATransaction flush];
    assert(layer.superlayer==window.contentView.layer);
    int owner=0;uint64_t epoch=0;macfx::FramePresenter presenter(layer,&owner);presenter.retainCompletedFrameForReplay(true);const auto preparations=std::make_shared<std::atomic<unsigned>>(0);presenter.setPreparationObserver([preparations](const macfx::EffectPreparationNotice&){++*preparations;});auto source=image(device,128,96);macfx::PresentationHoldCommand begin{++epoch,"transaction","hold",a,b};
    const auto finish=[&](const std::string&transaction,const macfx::PresentationContract&expected){macfx::PresentationHoldCommand value{++epoch,transaction,"finish",expected,{}};auto status=presenter.resumePresentationHold(value);assert(status.state=="finished"&&!status.holding&&!presenter.presentationHeld());};
    const auto unsupported=presenter.beginPresentationHold(begin);assert(unsupported.state=="failed"&&!unsupported.holding&&!presenter.presentationHeld());
    // The plan's resources prepare off the frame path; the first frame waits for them.
    id<MTLCommandBuffer> warm=nil;auto warmed=presenter.submitDisplayFrame(warm=[queue commandBuffer],source,1,CACurrentMediaTime(),true);
    for(const auto preparedUntil=CACurrentMediaTime()+5;!warmed.encoded&&warmed.busy&&CACurrentMediaTime()<preparedUntil;){idle(.005);warmed=presenter.submitDisplayFrame(warm=[queue commandBuffer],source,1,CACurrentMediaTime(),true);}
    if(!warmed.encoded)std::fprintf(stderr,"Hold first frame: busy=%u %s\n",warmed.busy,warmed.reason.c_str());assert(warmed.encoded);commit(warm);
    const auto shownUntil=CACurrentMediaTime()+10;
    bool initialReplay=false;
    while(presenter.snapshot().lastPresentedFrame!=1&&CACurrentMediaTime()<shownUntil){
        // A window can discard its initial drawable before attaching it to the
        // display. Keep the same completed source image and identity; one
        // replay must still earn a real positive display acknowledgment.
        if(!initialReplay&&presenter.snapshot().dropped&&presenter.completedFrameReplayReady()){
            initialReplay=presenter.replayCompletedFrame();
            if(initialReplay)std::fprintf(stderr,"Hold initial drawable dropped; replaying completed frame 1 once\n");
        }
        idle(.005);
    }
    const auto initial=presenter.snapshot();std::fprintf(stderr,"Hold initial display: submitted=%llu encoded=%llu completed=%llu real=%llu generated=%llu dropped=%llu pending=%u frame=%llu stopped=%u size=%.0fx%.0f bounds=%.0fx%.0f visible=%u transaction=%u reason=%s\n",(unsigned long long)initial.submitted,(unsigned long long)initial.encoded,(unsigned long long)initial.completedReal,(unsigned long long)initial.presentedReal,(unsigned long long)initial.presentedGenerated,(unsigned long long)initial.dropped,initial.pending,(unsigned long long)initial.lastPresentedFrame,initial.stopped,layer.drawableSize.width,layer.drawableSize.height,layer.bounds.size.width,layer.bounds.size.height,window.visible,layer.presentsWithTransaction,initial.reason.c_str());
    assert(presenter.snapshot().lastPresentedFrame==1);
    auto late=[queue commandBuffer];assert(presenter.submitDisplayFrame(late,source,2,CACurrentMediaTime(),true).encoded);const auto before=presenter.snapshot();
    const auto draining=presenter.beginPresentationHold(begin);assert(draining.state=="draining"&&draining.holding&&presenter.presentationHeld());const auto conflict=presenter.beginPresentationHold(begin);assert(conflict.state=="failed"&&conflict.holding);commit(late);awaitState(presenter,"held");
    assert(presenter.snapshot().lastPresentedFrame==1&&presenter.snapshot().presentedReal==before.presentedReal);
    // Input rejection happens before candidate preparation too. A stale or
    // invalid producer frame must not grant ingress permission to remove the
    // already positively displayed cover while the transaction is held.
    auto invalid=[queue commandBuffer];auto rejected=presenter.submitDisplayFrame(invalid,source,1,CACurrentMediaTime(),true);
    assert(!rejected.encoded&&rejected.busy&&presenter.presentationHeld()&&!presenter.snapshot().stopped);
    rejected=presenter.submitDisplayFrame(invalid,nil,3,CACurrentMediaTime(),true);
    assert(!rejected.encoded&&rejected.busy&&presenter.presentationHeld()&&!presenter.snapshot().stopped);
    auto blocked=[queue commandBuffer];auto busy=presenter.submitDisplayFrame(blocked,source,3,CACurrentMediaTime(),true);assert(!busy.encoded&&busy.busy);
    assert(replaceFile(second,control));publish(plan,@"c",.8);macfx::PresentationHoldCommand resume{++epoch,"transaction","present",b,{}};
    assert(presenter.resumePresentationHold(resume).state=="presenting");blocked=[queue commandBuffer];busy=presenter.submitDisplayFrame(blocked,source,3,CACurrentMediaTime(),true);assert(!busy.encoded&&busy.busy&&presenter.snapshot().lastPresentedFrame==1);
    const auto preparedSubmission=[&](uint64_t frame,id<MTLCommandBuffer> __strong &commands,bool matchingPublication=false){
        const auto until=CACurrentMediaTime()+5;const auto cover=presenter.snapshot().lastPresentedFrame;std::string reason;
        for(;;){commands=[queue commandBuffer];const auto result=presenter.submitDisplayFrame(commands,source,frame,CACurrentMediaTime(),true);if(result.encoded)return;
            if(reason!=result.reason){reason=result.reason;std::fprintf(stderr,"Hold frame %llu not encoded: busy=%u reason=%s\n",(unsigned long long)frame,result.busy,result.reason.c_str());}
            // A paused redraw must see the newly published contract on its
            // first attempt. Its resources may still prepare on the worker.
            if(matchingPublication)assert(result.reason=="Preparing graphics resources");
            assert(result.busy&&CACurrentMediaTime()<until&&presenter.snapshot().lastPresentedFrame==cover);commit(commands);idle(.005);
        }
    };
    publish(plan,@"b",.8);id<MTLCommandBuffer>current=nil;preparedSubmission(4,current);commit(current);awaitState(presenter,"presented");
    const auto accepted=presenter.presentationHoldStatus();assert(presenter.presentationHeld()&&accepted.holding&&accepted.frameId==4&&accepted.presentedTime>0&&accepted.contract==b);
    blocked=[queue commandBuffer];assert(presenter.submitDisplayFrame(blocked,source,5,CACurrentMediaTime(),true).busy);finish("transaction",b);
    const auto prepared=preparations->load();begin={++epoch,"transaction-two","hold",b,b};assert(presenter.beginPresentationHold(begin).state=="held");
    resume={++epoch,"transaction-two","cancel",b,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");preparedSubmission(5,current);commit(current);awaitState(presenter,"cancelled");const auto readyUntil=CACurrentMediaTime()+3;while(preparations->load()<=prepared&&CACurrentMediaTime()<readyUntil)idle(.005);assert(preparations->load()>prepared);const auto cancelled=presenter.presentationHoldStatus();assert(cancelled.frameId==5&&cancelled.contract==b&&cancelled.presentedTime>0);finish("transaction-two",b);
    begin={++epoch,"resize","hold",b,a};assert(presenter.beginPresentationHold(begin).state=="held");layer.drawableSize=CGSizeMake(160,104);source=image(device,160,104);
    // A new epoch must read the matching publication immediately, without
    // waiting for the ordinary100ms reader interval. Retrying the same source
    // identity while resources prepare must preserve the displayed cover.
    assert(replaceFile(first,control));publish(plan,@"a",.2,true,false);resume={++epoch,"resize","present",a,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");preparedSubmission(6,current,true);commit(current);awaitState(presenter,"presented");assert(presenter.presentationHoldStatus().width==160&&presenter.presentationHoldStatus().height==104);finish("resize",a);
    auto off=packet(false);macfx::PresentationContract empty{[hex(@"d")UTF8String],hash(off)};begin={++epoch,"no-removal","hold",a,empty};assert(presenter.beginPresentationHold(begin).state=="held");
    assert(replaceFile(off,control));publish(plan,@"d",0,false,false);resume={++epoch,"no-removal","present",empty,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");blocked=[queue commandBuffer];busy=presenter.submitDisplayFrame(blocked,source,7,CACurrentMediaTime(),true);assert(!busy.encoded&&busy.busy&&presenter.presentationHeld()&&presenter.presentationHoldStatus().state=="failed"&&presenter.presentationHoldStatus().holding);
    assert(replaceFile(first,control));publish(plan,@"a",.2,true,false);resume={++epoch,"no-removal","cancel",a,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");preparedSubmission(8,current);commit(current);awaitState(presenter,"cancelled");finish("no-removal",a);
    begin={++epoch,"stopped","hold",a,b};assert(presenter.beginPresentationHold(begin).state=="held");assert(replaceFile(second,control));publish(plan,@"b",.8);resume={++epoch,"stopped","present",b,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");
    preparedSubmission(9,late);const auto shown=presenter.snapshot();presenter.stop();commit(late);idle(.1);assert(!presenter.presentationHeld()&&!presenter.presentationHoldStatus().holding&&presenter.presentationHoldStatus().state=="failed"&&presenter.snapshot().presentedReal==shown.presentedReal);
    [window close];std::puts("Presentation hold: actual display ACK, late-buffer retirement, matching publication, same-contract history reset, resize, fail-closed removal, rollback and Stop passed");
}}
