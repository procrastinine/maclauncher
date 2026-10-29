#pragma once
#import <Metal/Metal.h>

namespace macfx {
// Enqueue reserves a queue position; encoding alone does not. This observes
// caller ordering without enqueueing, committing or waiting on its commands.
inline bool orderedTemporalCommands(id<MTLCommandBuffer> previous,
                                    id<MTLCommandBuffer> current) {
    if (!previous || !current) return false;
    if (previous == current) return true;
    const auto status = previous.status;
    if (status == MTLCommandBufferStatusError) return false;
    if (status == MTLCommandBufferStatusCompleted) return true;
    if (previous.commandQueue != current.commandQueue) return false;
    return (current.status == MTLCommandBufferStatusNotEnqueued &&
            status >= MTLCommandBufferStatusEnqueued) ||
           status == MTLCommandBufferStatusScheduled;
}
}
