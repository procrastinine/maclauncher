#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <memory>
#include "window-capture-wire.hpp"

namespace macfx::wcap {
struct ClientCallbacks {
    void (^connected)(void)=nil;
    void (^disconnected)(NSString *reason)=nil;
    void (^failed)(NSString *reason)=nil;
    void (^feedEvent)(uint32_t feed,NSDictionary *event)=nil;
    void (^catalogEvent)(NSDictionary *event)=nil;
    void (*frame)(void *context,uint32_t feed,IOSurfaceRef surface,const FrameInfo &info)=nullptr;
    void *frameContext=nullptr;
};
class Client {
public:
    static std::shared_ptr<Client> connect(NSString *serviceId,NSString *role,ClientCallbacks callbacks,NSString **error);
    void setOverlays(NSArray<NSNumber*> *windowIDs);
    void open(uint32_t feed,NSDictionary *request);
    void options(uint32_t feed,NSDictionary *options);
    void close(uint32_t feed);
    void release(uint32_t feed,uint64_t sequence);
    void catalog(NSDictionary *request);
    void stop();
    pid_t servicePid() const;
    virtual ~Client();
private:
    struct Impl;
    std::shared_ptr<Impl> implementation;
    Client()=default;
};
}
