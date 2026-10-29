// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include <algorithm>
#include <cstdint>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <string>
#include <unistd.h>
#if !__has_feature(objc_arc)
#error "path-watch.hpp returns dispatch objects with ARC ownership"
#endif
namespace macfx {
// Bounded backoff for re-arming a watcher or retrying a read: 50 ms doubling
// to 2 s. No failure is final; a success resets the delay.
struct RetryBackoff {
    uint64_t delay=0;
    uint64_t next()noexcept{delay=delay?std::min<uint64_t>(delay*2,2*NSEC_PER_SEC):50*NSEC_PER_MSEC;return delay;}
    void reset()noexcept{delay=0;}
};
// A resumed vnode source for entry changes in a directory, or nil while the
// directory cannot be opened. changed(true) reports that the watched directory
// itself was deleted, renamed or revoked: the source no longer observes the
// path, so the owner cancels it and arms a new one. A nil result is retried
// after RetryBackoff, never treated as final.
inline dispatch_source_t watchDirectory(const std::string &directory,dispatch_queue_t queue,void(^changed)(bool replaced))noexcept{
    if(directory.empty())return nil;
    const int descriptor=open(directory.c_str(),O_EVTONLY|O_DIRECTORY|O_CLOEXEC);if(descriptor<0)return nil;
    constexpr unsigned long replacedMask=DISPATCH_VNODE_DELETE|DISPATCH_VNODE_RENAME|DISPATCH_VNODE_REVOKE;
    dispatch_source_t source=dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE,uintptr_t(descriptor),DISPATCH_VNODE_WRITE|DISPATCH_VNODE_LINK|replacedMask,queue);
    if(!source){close(descriptor);return nil;}
    // Dispatch keeps a source alive while its handler runs; the handler does
    // not retain its own source.
    __unsafe_unretained dispatch_source_t unretained=source;
    dispatch_source_set_event_handler(source,^{changed(dispatch_source_get_data(unretained)&replacedMask);});
    dispatch_source_set_cancel_handler(source,^{close(descriptor);});
    dispatch_resume(source);return source;
}
}
