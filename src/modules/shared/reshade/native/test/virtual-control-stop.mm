// Copyright (c) MacLauncher contributors. MIT license.
// Actual virtual source-control state with NSObject geometry doubles only.
// No NSApplication, NSWindow, Metal device, queue or GPU work is created.
#include "virtual-window.hpp"
#include "fixture-files.hpp"
#include "source-control.hpp"
#include <cassert>
#include <cstdio>
#include <unistd.h>
@interface StoppedControlView:NSObject
@property(nonatomic,weak) id window;
@end
@implementation StoppedControlView
- (NSRect)bounds{return NSMakeRect(0,0,640,360);}
- (NSRect)convertRectToBacking:(NSRect)rect{return rect;}
@end
@interface StoppedControlWindow:NSObject
@property(nonatomic,strong) id contentView;
@end
@implementation StoppedControlWindow
@end
#ifndef MACFX_VIRTUAL_CONTROL_SOURCE
#define MACFX_VIRTUAL_CONTROL_SOURCE <virtual-window.mm>
#endif
#include MACFX_VIRTUAL_CONTROL_SOURCE
int main(){@autoreleasepool{
    char scratch[1024];temporaryPath(scratch,"macfx-virtual-stop-XXXXXX");assert(mkdtemp(scratch));
    NSString *directory=@(scratch),*command=[directory stringByAppendingPathComponent:@"source-control-stopped.json"],*status=[directory stringByAppendingPathComponent:@"source-status-stopped.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);setenv("RESHADE_RENDER_SOURCE_ACTIVATION_API","0",1);
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",command.fileSystemRepresentation,1);
    setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","stopped",1);
    auto view=[StoppedControlView new];auto window=[StoppedControlWindow new];window.contentView=view;view.window=window;
    auto channel=[MacFXVirtualControl new];channel.source=(NSView*)view;channel->sourceIdentity=(__bridge void*)view;
    channel->reader=std::make_shared<macfx::SourceControlReader>();assert(channel->reader->configured());macfx::SourceControlCommand accepted;
    accepted.epoch=4;accepted.revision=std::string(64,'a');accepted.requested=@{@"automatic":@YES};accepted.source=macfx::RenderSourceRequest{};accepted.source->automatic=true;
    channel->accepted=accepted;channel->reader->accept(accepted);channel.readyForSession=YES;channel.waitingForFrame=YES;
    const auto read=[&](){return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status]options:0 error:nil];};
    [channel sessionStopped:nil];assert(!channel.readyForSession&&!channel.waitingForFrame);
    NSString *reason=read()[@"reason"];assert([reason hasPrefix:@"The virtual render source was detached."]);
    [channel poll];
    assert(!channel.readyForSession&&!channel.waitingForFrame&&[read()[@"reason"]isEqualToString:reason]);
    // A later accepted request may wait for genuine new producer evidence.
    channel.readyForSession=YES;[channel poll];assert(channel.waitingForFrame&&[read()[@"reason"]hasPrefix:@"Waiting for "]);
    channel=nil;assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("Actual virtual control CPU: retired session preserves detached reason without impossible wait; new source attempt may await real completion; NSObject geometry only");
}}
