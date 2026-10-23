// Copyright (c) MacLauncher contributors. MIT license.
// CPU-only milestone and lease checks with controlled NSObject callbacks.
#include "command-deadline.hpp"
#import <Foundation/Foundation.h>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <vector>
@interface DeadlineCommands:NSObject
@property MTLCommandBufferStatus status;
@property(strong)NSMutableArray *scheduled,*completed;
@end
@implementation DeadlineCommands
- (instancetype)init{if((self=[super init])){_scheduled=[NSMutableArray new];_completed=[NSMutableArray new];_status=MTLCommandBufferStatusCommitted;}return self;}
- (void)addScheduledHandler:(MTLCommandBufferHandler)value{[self.scheduled addObject:[value copy]];}
- (void)addCompletedHandler:(MTLCommandBufferHandler)value{[self.completed addObject:[value copy]];}
- (void)schedule{self.status=MTLCommandBufferStatusScheduled;NSArray *saved=[self.scheduled copy];[self.scheduled removeAllObjects];for(MTLCommandBufferHandler callback in saved)callback((id<MTLCommandBuffer>)self);}
- (void)finish:(MTLCommandBufferStatus)status{self.status=status;NSArray *saved=[self.completed copy];[self.completed removeAllObjects];[self.scheduled removeAllObjects];for(MTLCommandBufferHandler callback in saved)callback((id<MTLCommandBuffer>)self);}
@end
int main(){@autoreleasepool{
    using Gate=macfx::CommandDeadline;
    std::weak_ptr<std::vector<unsigned char>>retained;
    @autoreleasepool {
    auto stalled=[DeadlineCommands new];auto busy=std::make_shared<std::atomic<bool>>(true);std::vector<unsigned char>original(16,0xAA);
    auto image=std::make_shared<std::vector<unsigned char>>(16,0x55);retained=image;
    [stalled addCompletedHandler:^(id<MTLCommandBuffer>commands){if(commands.status==MTLCommandBufferStatusCompleted)std::fill(image->begin(),image->end(),0x77);busy->store(false);}];
    image.reset();
    {Gate pending((id<MTLCommandBuffer>)stalled,Gate::Milestone::Scheduled);const auto begun=std::chrono::steady_clock::now();assert(!pending.wait());
     assert(std::chrono::steady_clock::now()-begun<std::chrono::seconds(1));assert(busy->load()&&!retained.expired());}
    assert(busy->load()&&!retained.expired()); // Deadline destruction never retires work.
    auto exact=retained.lock();[stalled finish:MTLCommandBufferStatusCompleted];assert(!busy->load()&&(*exact)[0]==0x77);
    assert(original==std::vector<unsigned char>(16,0xAA)); // A late owned image has no reference to a publisher backbuffer.
    exact.reset();
    }assert(retained.expired());
    auto scheduled=[DeadlineCommands new];Gate timing((id<MTLCommandBuffer>)scheduled,Gate::Milestone::Scheduled);[scheduled schedule];assert(timing.wait(0));
    Gate completion((id<MTLCommandBuffer>)scheduled,Gate::Milestone::Completed);assert(!completion.wait(0));[scheduled finish:MTLCommandBufferStatusCompleted];assert(completion.wait(0));
    auto failed=[DeadlineCommands new];Gate failure((id<MTLCommandBuffer>)failed,Gate::Milestone::Completed);[failed finish:MTLCommandBufferStatusError];assert(!failure.wait(0));
    puts("Bounded scheduling/completion deadlines preserve pending owned leases until controlled late completion, leave publisher bytes untouched and reject errors; no Metal device, queue, GPU or display.");
}}
