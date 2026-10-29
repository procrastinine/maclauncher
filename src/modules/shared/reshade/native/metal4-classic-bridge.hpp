#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include <functional>
#import <dispatch/dispatch.h>
namespace macfx {
// A Metal 4 recording is bridged only with its actual future submission
// context. The producer must commit this recording to this queue/options pair.
// Missing/unobserved contexts preserve the original SDK operation.
struct Metal4SubmissionContext {
    id queue=nil,options=nil;
    dispatch_queue_t feedbackQueue=nullptr;
};
struct Metal4ClassicJob {
    id<MTLFence>producerFence=nil;
    // Safe base mode: the original producer has already encoded the complete
    // image in the preceding Metal 4 segment. Unknown submission contexts can
    // discard this optional job without losing the producer's actual output.
    bool completeProducerImage=false;
    // An ingress may instead supply its exact original SDK invocation. The
    // bridge records it in the prefix or an isolated fallback and reports it
    // separately
    // so a busy candidate cannot cause the caller to invoke the SDK twice.
    std::function<ShaderResult(id)>recordOriginal;
    // The replacement reads the original inputs rather than the SDK output.
    // Its SDK-only recording may be omitted after actual GPU success, only
    // when an exact owned/event consumer and SDK history authorize it.
    bool isolateOriginal=false;
    std::function<bool()>omitOriginal;
    std::function<bool()>mayOmitOriginal;
    std::function<void()>originalKept;
    std::function<void()>originalAbandoned;
    // encode is consumed during recording, then released. The remaining
    // callbacks retain scratch/resources, never an SDK that owns its commands.
    std::function<ShaderResult(id<MTLCommandBuffer>)>encode;
    std::function<ShaderResult()>completion;
    // The actual commit, not a guessed future queue, authorizes consumers.
    std::function<void(bool,id<MTLSharedEvent>,uint64_t)>submitted;
    // Publish the completed result or a complete composed-color fallback into
    // the producer's real target. Both paths must already be GPU-prepared.
    std::function<ShaderResult(id<MTLCommandBuffer>,bool)>publish;
    std::function<void(ShaderResult)>publicationCompleted;
    std::function<void()>originalOutputRetained;
    std::function<void(ShaderResult)>retired;
};
class Metal4ClassicBridge {
    struct Impl;std::shared_ptr<Impl>impl;
public:
    explicit Metal4ClassicBridge(id<MTLDevice>);~Metal4ClassicBridge();
    // Metadata-only hooks observe new public recording/options objects.
    static void install(id<MTLDevice>);
    static id recordingTarget(id logicalCommands);
    // Worker-only bounded events/allocators/continuations, no image/pipeline.
    ShaderResult prepare(unsigned capacity=4);
    id<MTLCommandQueue>classicQueue()const;
    bool needsPreparation()const;
    ShaderResult declareSubmission(id logicalCommands,const Metal4SubmissionContext&);
    // Must be called between closed, unsuspended encoders. Failed/busy
    // candidate encoding leaves the current original recording untouched.
    ShaderResult encode(id logicalCommands,Metal4ClassicJob,bool*originalEncoded=nullptr);
};
}
