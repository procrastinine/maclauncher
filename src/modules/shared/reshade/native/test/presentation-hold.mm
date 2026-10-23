#include "presentation.hpp"
#include "effects-execution.hpp"
#include "live-controls.hpp"
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
std::atomic<unsigned> constructions{0};
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
    auto input=[directory stringByAppendingPathComponent:@"presentation-control-hold-test.json"],output=[directory stringByAppendingPathComponent:@"presentation-status-hold-test.json"];
    setenv("RESHADE_PRESENTATION_CONTROL_FILE",input.fileSystemRepresentation,1);setenv("RESHADE_PRESENTATION_STATUS_FILE",output.fileSystemRepresentation,1);
    setenv("RESHADE_PRESENTATION_LAUNCH_ID","hold-test",1);setenv("RESHADE_PRESENTATION_TOKEN","hold-token",1);
    macfx::PresentationHoldReader reader;assert(reader.configured());assert([valid writeToFile:input atomically:YES]);assert(reader.poll()->epoch==1);
    assert([command(1,@"present",b,b)writeToFile:input atomically:YES]);assert(!reader.poll());
    assert([command(2,@"cancel",a,b)writeToFile:input atomically:YES]);assert(reader.poll()->action=="cancel");
    macfx::PresentationHoldStatus state;state.state="held";state.epoch=2;state.transactionId="transaction";state.contract=a;state.presentedTime=1;state.width=128;state.height=96;state.frameId=1;
    state.holding=true;reader.status(state,42);auto status=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:output]options:0 error:nil];assert([status[@"window"] intValue]==42&&[status[@"state"] isEqual:@"held"]&&CFGetTypeID((__bridge CFTypeRef)status[@"holding"])==CFBooleanGetTypeID()&&[status[@"holding"] boolValue]);
    state.state="failed";state.holding=false;reader.status(state,42);status=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:output]options:0 error:nil];assert(![status[@"holding"] boolValue]);
}
struct Colour final:macfx::ShaderNode {
    id<MTLComputePipelineState> pipeline;float gain=.2;
    Colour(){++constructions;}
    void setParameters(const macfx::ShaderParameters&p)override{if(auto value=p.find("Gain");value!=p.end())gain=value->second[0];}
    macfx::ShaderResult prepare(const macfx::ShaderFrame&frame)override{
        if(!pipeline){NSError *error=nil;auto library=[frame.commands.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void colour(texture2d<float,access::read>a[[texture(0)]],texture2d<float,access::write>b[[texture(1)]],constant float&gain[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(p.x>=b.get_width()||p.y>=b.get_height())return;uint2 q=min(p,uint2(a.get_width()-1,a.get_height()-1));float4 v=a.read(q);v.b=gain;b.write(v,p);}" options:nil error:&error];assert(library);pipeline=[frame.commands.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"colour"]error:&error];assert(pipeline);}return {true,{}};
    }
    macfx::ShaderResult encode(const macfx::ShaderFrame&frame)override{prepare(frame);auto encoder=[frame.commands computeCommandEncoder];[encoder setComputePipelineState:pipeline];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.target atIndex:1];[encoder setBytes:&gain length:sizeof(gain)atIndex:0];[encoder dispatchThreads:MTLSizeMake(frame.target.width,frame.target.height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];return {true,{}};}
};
void publish(NSString *file,NSString *revision,double gain,bool enabled=true,bool settle=true){
    auto row=@{@"id":@"display",@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":@"/proof/display",@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":@{@"Gain":@[@(gain)]},@"preservesCoordinates":@YES};
    auto value=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":enabled?@[row]:@[]};
    assert([[NSJSONSerialization dataWithJSONObject:value options:0 error:nil]writeToFile:file atomically:YES]);if(settle)idle(.12);
}
void commit(id<MTLCommandBuffer>commands){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}
void awaitState(macfx::FramePresenter &presenter,const std::string &expected){const auto deadline=CACurrentMediaTime()+3;while(presenter.presentationHoldStatus().state!=expected&&CACurrentMediaTime()<deadline)idle(.005);assert(presenter.presentationHoldStatus().state==expected);}
id<MTLTexture> image(id<MTLDevice>device,unsigned width,unsigned height){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto value=[device newTextureWithDescriptor:descriptor];assert(value);std::vector<unsigned char>bytes(width*height*4,255);[value replaceRegion:MTLRegionMake2D(0,0,width,height)mipmapLevel:0 withBytes:bytes.data() bytesPerRow:width*4];return value;}
}
namespace macfx {std::shared_ptr<ShaderNode>makeShaderNode(const ShaderSpec&){return std::make_shared<Colour>();}}
int main(int argc,char **argv){@autoreleasepool{
    char temporary[]="/tmp/maclauncher-presentation-hold-XXXXXX";assert(mkdtemp(temporary));NSString *directory=@(temporary),*plan=[directory stringByAppendingPathComponent:@"plan.json"],*control=[directory stringByAppendingPathComponent:@"controls.bin"];
    auto first=packet(true),second=packet(true,.8);macfx::PresentationContract a{[hex(@"a")UTF8String],hash(first)},b{[hex(@"b")UTF8String],hash(second)};
    protocol(directory,a,b);if(argc==2&&!std::strcmp(argv[1],"--protocol")){assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);std::puts("Presentation hold protocol: bounded identities, candidates, stale epochs and status passed");return 0;}
    setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_LIVE_EFFECTS",directory.fileSystemRepresentation,1);setenv("RESHADE_CONTROL_FILE",control.fileSystemRepresentation,1);setenv("RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation,1);
    assert([first writeToFile:control atomically:YES]);publish(plan,@"a",.2);[NSApplication sharedApplication];assert([NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]);[NSApp finishLaunching];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    const auto initialUntil=CACurrentMediaTime()+3;
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,256,192)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    auto layer=[CAMetalLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.opaque=YES;layer.displaySyncEnabled=YES;window.contentView.wantsLayer=YES;window.contentView.layer=layer;
    // An unbundled executable defaults to prohibited activation. Ordered
    // windows can remain fully occluded and correctly report a zero display
    // timestamp. Establish the actual physical-display precondition first.
    [window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];[NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateAllWindows|NSApplicationActivateIgnoringOtherApps];
    while((!NSApp.active||!window.keyWindow||!(window.occlusionState&NSWindowOcclusionStateVisible))&&CACurrentMediaTime()<initialUntil)idle(.005);
    std::fprintf(stderr,"Hold window ready: active=%u key=%u occlusion=%lu window=%ld\n",NSApp.active,window.keyWindow,(unsigned long)window.occlusionState,(long)window.windowNumber);
    assert(NSApp.active&&window.keyWindow&&(window.occlusionState&NSWindowOcclusionStateVisible));
    std::fprintf(stderr,"Hold layer before display: viewNeedsDisplay=%u layerNeedsDisplay=%u redrawPolicy=%ld assigned=%u layer=%p viewLayer=%p\n",window.contentView.needsDisplay,layer.needsDisplay,(long)window.contentView.layerContentsRedrawPolicy,window.contentView.layer==layer,(__bridge void*)layer,(__bridge void*)window.contentView.layer);
    [window display];[window.contentView displayIfNeeded];layer.drawableSize=CGSizeMake(128,96);[CATransaction flush];
    std::fprintf(stderr,"Hold layer after display: viewNeedsDisplay=%u layerNeedsDisplay=%u redrawPolicy=%ld assigned=%u layer=%p viewLayer=%p size=%.0fx%.0f\n",window.contentView.needsDisplay,layer.needsDisplay,(long)window.contentView.layerContentsRedrawPolicy,window.contentView.layer==layer,(__bridge void*)layer,(__bridge void*)window.contentView.layer,layer.drawableSize.width,layer.drawableSize.height);
    assert(window.contentView.layer==layer);
    int owner=0;uint64_t epoch=0;macfx::FramePresenter presenter(layer,&owner);auto source=image(device,128,96);macfx::PresentationHoldCommand begin{++epoch,"transaction","hold",a,b};
    const auto finish=[&](const std::string&transaction,const macfx::PresentationContract&expected){macfx::PresentationHoldCommand value{++epoch,transaction,"finish",expected,{}};auto status=presenter.resumePresentationHold(value);assert(status.state=="finished"&&!status.holding&&!presenter.presentationHeld());};
    const auto unsupported=presenter.beginPresentationHold(begin);assert(unsupported.state=="failed"&&!unsupported.holding&&!presenter.presentationHeld());
    auto warm=[queue commandBuffer];assert(presenter.submitDisplayFrame(warm,source,1,CACurrentMediaTime(),true).encoded);commit(warm);
    while(presenter.snapshot().lastPresentedFrame!=1&&CACurrentMediaTime()<initialUntil)idle(.005);
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
    assert([second writeToFile:control atomically:YES]);publish(plan,@"c",.8);macfx::PresentationHoldCommand resume{++epoch,"transaction","present",b,{}};
    assert(presenter.resumePresentationHold(resume).state=="presenting");blocked=[queue commandBuffer];busy=presenter.submitDisplayFrame(blocked,source,3,CACurrentMediaTime(),true);assert(!busy.encoded&&busy.busy&&presenter.snapshot().lastPresentedFrame==1);
    publish(plan,@"b",.8);auto current=[queue commandBuffer];assert(presenter.submitDisplayFrame(current,source,4,CACurrentMediaTime(),true).encoded);commit(current);awaitState(presenter,"presented");
    const auto accepted=presenter.presentationHoldStatus();assert(presenter.presentationHeld()&&accepted.holding&&accepted.frameId==4&&accepted.presentedTime>0&&accepted.contract==b);
    blocked=[queue commandBuffer];assert(presenter.submitDisplayFrame(blocked,source,5,CACurrentMediaTime(),true).busy);finish("transaction",b);
    const auto constructed=constructions.load();begin={++epoch,"transaction-two","hold",b,b};assert(presenter.beginPresentationHold(begin).state=="held");
    resume={++epoch,"transaction-two","cancel",b,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");current=[queue commandBuffer];assert(presenter.submitDisplayFrame(current,source,5,CACurrentMediaTime(),true).encoded);commit(current);awaitState(presenter,"cancelled");assert(constructions.load()>constructed);finish("transaction-two",b);
    begin={++epoch,"resize","hold",b,a};assert(presenter.beginPresentationHold(begin).state=="held");layer.drawableSize=CGSizeMake(160,104);source=image(device,160,104);
    // A new epoch must accept one immediate paused redraw, without waiting
    // for the ordinary100ms reader interval or issuing a second source frame.
    assert([first writeToFile:control atomically:YES]);publish(plan,@"a",.2,true,false);resume={++epoch,"resize","present",a,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");current=[queue commandBuffer];assert(presenter.submitDisplayFrame(current,source,6,CACurrentMediaTime(),true).encoded);commit(current);awaitState(presenter,"presented");assert(presenter.presentationHoldStatus().width==160&&presenter.presentationHoldStatus().height==104);finish("resize",a);
    auto off=packet(false);macfx::PresentationContract empty{[hex(@"d")UTF8String],hash(off)};begin={++epoch,"no-removal","hold",a,empty};assert(presenter.beginPresentationHold(begin).state=="held");
    assert([off writeToFile:control atomically:YES]);publish(plan,@"d",0,false,false);resume={++epoch,"no-removal","present",empty,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");blocked=[queue commandBuffer];busy=presenter.submitDisplayFrame(blocked,source,7,CACurrentMediaTime(),true);assert(!busy.encoded&&busy.busy&&presenter.presentationHeld()&&presenter.presentationHoldStatus().state=="failed"&&presenter.presentationHoldStatus().holding);
    assert([first writeToFile:control atomically:YES]);publish(plan,@"a",.2,true,false);resume={++epoch,"no-removal","cancel",a,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");current=[queue commandBuffer];assert(presenter.submitDisplayFrame(current,source,8,CACurrentMediaTime(),true).encoded);commit(current);awaitState(presenter,"cancelled");finish("no-removal",a);
    begin={++epoch,"stopped","hold",a,b};assert(presenter.beginPresentationHold(begin).state=="held");assert([second writeToFile:control atomically:YES]);publish(plan,@"b",.8);resume={++epoch,"stopped","present",b,{}};assert(presenter.resumePresentationHold(resume).state=="presenting");
    late=[queue commandBuffer];assert(presenter.submitDisplayFrame(late,source,9,CACurrentMediaTime(),true).encoded);const auto shown=presenter.snapshot();presenter.stop();commit(late);idle(.1);assert(!presenter.presentationHeld()&&!presenter.presentationHoldStatus().holding&&presenter.presentationHoldStatus().state=="failed"&&presenter.snapshot().presentedReal==shown.presentedReal);
    [window close];assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);std::puts("Presentation hold: actual display ACK, late-buffer retirement, matching publication, same-contract history reset, resize, fail-closed removal, rollback and Stop passed");
}}
