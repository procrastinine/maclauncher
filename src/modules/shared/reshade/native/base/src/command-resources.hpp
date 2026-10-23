#pragma once
#import <Metal/Metal.h>
#include <atomic>
#include <memory>
#include <stdexcept>

namespace macfx::borrowed {
struct Busy final : std::runtime_error {
    Busy() : std::runtime_error("Effect resource capacity is busy") {}
};
struct Owner { std::atomic<unsigned> pending{0}; };
// Completion callbacks can outlive other process statics. This fixed counter
// owns no frame objects and stays available through their final retirement.
inline std::atomic<unsigned> &total() {
    static auto *value=new std::atomic<unsigned>{0};
    return *value;
}
inline bool reserve(std::atomic<unsigned> &count,unsigned limit) {
    unsigned value=count.load();
    while(value<limit) if(count.compare_exchange_weak(value,value+1)) return true;
    return false;
}
struct Lease {
    std::shared_ptr<Owner> owner;
    NSMutableArray *objects=[NSMutableArray new];
    std::atomic<bool> retired{false};
    explicit Lease(std::shared_ptr<Owner> value) : owner(std::move(value)) {}
    void hold(id value) { if(value) [objects addObject:value]; }
    void retire() {
        if(!retired.exchange(true)) {
            objects=nil;
            owner->pending.fetch_sub(1);
            total().fetch_sub(1);
        }
    }
    ~Lease() { retire(); }
};
inline std::shared_ptr<Lease> acquire(id<MTLCommandBuffer> commands,std::shared_ptr<Owner> &owner) {
    if(commands.retainedReferences) return {};
    if(!owner) owner=std::make_shared<Owner>();
    if(!reserve(owner->pending,8)) throw Busy();
    if(!reserve(total(),32)) { owner->pending.fetch_sub(1);throw Busy(); }
    std::shared_ptr<Lease> lease;
    try { lease=std::make_shared<Lease>(owner); }
    catch(...) { owner->pending.fetch_sub(1);total().fetch_sub(1);throw; }
    // The block owns exactly this encoding's objects. Releasing an unsubmitted
    // buffer destroys the block and lease; completion retires them immediately.
    [commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->retire();}];
    return lease;
}
struct EmptyEncoding {
    std::shared_ptr<Lease> lease;
    bool started=false;
    ~EmptyEncoding() { if(lease&&!started) lease->retire(); }
};
}
