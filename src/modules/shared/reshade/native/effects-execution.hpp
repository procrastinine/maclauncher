#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-plan.hpp"
#include "graphics.hpp"
#include "temporal-frame.h"
#include "color-contract.hpp"
#include "generation-provider.hpp"
#include <atomic>
namespace macfx {
class ImageReservation;
struct EffectSceneLease;
class ComparisonEncoder;
class ImagePairAnalysis;
std::optional<RSTemporalFrame> retainedSceneFrame(const std::shared_ptr<const EffectSceneLease>&);
struct ImageContentStamp {
 uint64_t contentId=0,epoch=0,observationId=0,imageRevision=0;bool synthetic=false,displayMapped=false;std::shared_ptr<const EffectSceneLease>scene;
 // Work between generators belongs to its actual closing real input. These
 // fields group timing only; image identity and provider history stay above.
 uint64_t qualityContentId=0,qualityEpoch=0;
};
struct EffectGenerationStage {
 // inputIdentity names the exact input; historyIdentity names its input
 // contract, which an upstream control edit leaves unchanged.
 std::string id,inputIdentity,historyIdentity;size_t row=0;bool sceneCoordinates=true;unsigned width=0,height=0;GraphicsConfig graphics;
 std::shared_ptr<GenerationEncoder>encoder;
 struct State {uint64_t sequence=0,processingSequence=0,previousEventId=0;bool skippedSource=false;std::shared_ptr<ImageReservation>admission;std::shared_ptr<ImagePairAnalysis>pairAnalysis;std::vector<std::function<ShaderResult()>>previousCompletions;
  void startAfterCut(const State&previous)noexcept{sequence=previous.sequence+1;}
 };
 std::shared_ptr<State>state=std::make_shared<State>();
 // Candidate preparation may retain allocation without touching live history.
 // Only the serialized producer/adoption seam reads this predecessor's counter.
 std::shared_ptr<State>historySource;
};
class EffectExecution {
    struct Impl;
    std::shared_ptr<Impl> impl;
    explicit EffectExecution(std::shared_ptr<Impl>);
    friend class EffectPlanExecutor;
public:
    const std::string &revision() const;
    const GraphicsConfig &graphics() const;
    std::shared_ptr<GenerationEncoder> generator() const;
    const std::vector<EffectGenerationStage>&generationStages()const;
    bool generationGpuTimingRequested(size_t stage)const;
    void recordGenerationGpuTiming(id<MTLCommandBuffer>,size_t stage,const ImageContentStamp&,std::function<uint64_t()>);
    ShaderResult encodeGenerationSegment(const ShaderFrame&,size_t stage,bool generated,const ImageContentStamp*content=nullptr);
    ShaderResult encodeGenerationSegment(const ShaderFrame&,size_t stage,bool generated,const ImageContentStamp*content,bool*displayMapped);
    bool replacesTemporal()const;
    std::shared_ptr<const EffectPlanSnapshot>sceneSuffixSnapshot()const;
    const std::string&sceneOutputIdentity()const;
    void setSceneBoundarySuffix(std::shared_ptr<const EffectPlanSnapshot>,size_t consumedNodes);
    void markImageBoundary();
    ShaderResult encodeSceneBoundary(const ShaderFrame&,const RSTemporalFrame&,bool*displayMapped=nullptr);
    ShaderResult encodeRecordedScene(const ShaderFrame&,const RSTemporalFrame&,bool*displayMapped=nullptr,DepthFrame*alignedDepth=nullptr);
    const OutputPolicy&outputPolicy()const;
    std::shared_ptr<ComparisonEncoder>comparison()const;
    const ImageColorDescription&imageColor()const;
    EffectQualityStatus qualityStatus()const;
    bool supportsGpuQuality(EffectQualityPoint)const;
    uint64_t nextQualitySequence()noexcept;
    void observeGpuQuality(const AdaptiveQualitySample&,EffectQualityPoint,RuntimeAdaptiveQualityScope);
    void publishQualityStatus()const noexcept;
    bool frameContractMatches(const ShaderFrame&)const;
    bool frameContractMatches(const ShaderFrame&,id<MTLCommandQueue>)const;
    id<MTLCommandQueue>commandQueue()const;
    id<MTLCommandQueue>finalCommandQueue()const;
    bool hasDisplaySubframes()const;
    // Prefix includes all rows before generation; suffix runs separately on
    // every actual real/generated presentation. No generation means all rows
    // belong to the prefix. These functions never commit a command buffer.
    ShaderResult encode(const ShaderFrame &,bool suffix=false,bool generated=false);
    ShaderResult encode(const ShaderFrame &,bool suffix,bool generated,bool inputMapped,bool*displayMapped=nullptr);
    const std::string &generationInputIdentity()const;
    unsigned generationWidth()const;unsigned generationHeight()const;
    unsigned generationOutputWidth()const;unsigned generationOutputHeight()const;
    void setStatusContext(uintptr_t);
    bool hasTemporal() const;
    bool requiresDepth() const;
    // Ordinary owned presentation may process independent final images on its
    // own queue. Matched scene inputs and generated timelines stay in place.
    bool canDetachNeural() const;
    // Offline writers validate asynchronous inference before appending output.
    ShaderResult finishOffline();
    // Exact resource-only receipt for work recorded on this command buffer.
    std::function<ShaderResult()>completionTicket(id<MTLCommandBuffer>);
    // Scene input is the original renderer's matched temporal frame. The
    // remaining prefix resumes only from that frame's exact output receipt.
    ShaderResult encodeScene(const ShaderFrame &,const RSTemporalFrame &);
    ShaderResult encodeScene(const ShaderFrame &,const RSTemporalFrame &,bool*displayMapped);
    ShaderResult encodeScene(const ShaderFrame &,const RSTemporalFrame &,bool*displayMapped,DepthFrame*alignedDepth,bool inputMapped=false);
    ShaderResult bindGenerationScene(id<MTLCommandBuffer>,size_t stage,id<MTLTexture>colour,const std::shared_ptr<const EffectSceneLease>&scene={},FrameOrigin origin=FrameOrigin::TopLeft,id<MTLTexture>copiedFrom=nil);
    std::shared_ptr<const EffectSceneLease>captureSceneLease(id<MTLCommandBuffer>);
    ShaderResult bindSceneImage(id<MTLCommandBuffer>,id<MTLTexture>colour,id<MTLTexture>output,const std::shared_ptr<const EffectSceneLease>&,std::shared_ptr<const EffectSceneLease>&normalized);
    ShaderResult bindSceneImage(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>,const std::shared_ptr<const EffectSceneLease>&,std::shared_ptr<const EffectSceneLease>&,FrameOrigin);
    ShaderResult encodeAfterScene(const ShaderFrame &,bool suffix=false,bool generated=false);
    ShaderResult encodeAfterScene(const ShaderFrame &,bool suffix,bool generated,bool inputMapped,bool*displayMapped=nullptr);
    // Reprocess one retained real image without submitting any generator.
    ShaderResult encodeRealImage(const ShaderFrame&,bool afterScene=false,bool suffix=false);
    ShaderResult encodeContentImage(const ShaderFrame&,const ImageContentStamp&,bool suffix=false,bool redraw=false);
    ShaderResult encodeContentImage(const ShaderFrame&,const ImageContentStamp&,bool suffix,bool redraw,bool*displayMapped);
private:
    ShaderResult encodeRange(const ShaderFrame &,size_t begin,size_t end,bool generated,const RSTemporalFrame *,bool redraw=false,const ImageContentStamp*content=nullptr);
    ShaderResult encodeRange(const ShaderFrame &,size_t begin,size_t end,bool generated,const RSTemporalFrame *,bool redraw,const ImageContentStamp*content,bool inputMapped,bool*displayMapped=nullptr);
};
// A frame owner that adopts a valid pass-through plan (Off, master bypass or no
// enabled rows) acknowledges it while a status reader holds its lease, with the
// rows the reader rejected. Without a lease this returns after one load.
void observeBypassedPlan(uintptr_t owner) noexcept;
struct EffectExecutionSelection {
    bool active=false,changed=false;
    std::shared_ptr<EffectExecution> execution;
    std::string error;
    bool preparing=false,holdPrevious=false;
    bool qualityPreparing=false;
};
struct EffectPreparationNotice {std::string revision,contract;uint64_t sequence=0;};
using EffectPreparationObserver=std::function<void(const EffectPreparationNotice&)>;
class EffectPlanExecutor {
    struct Impl;
    std::unique_ptr<Impl> impl;
public:
    EffectPlanExecutor();~EffectPlanExecutor();
    EffectExecutionSelection prepare(const ShaderFrame &,bool presentation=false,const RSTemporalFrame *temporal=nullptr);
    EffectExecutionSelection prepareWithColor(const ShaderFrame &,bool,const RSTemporalFrame *,ImageColorSpace);
    EffectExecutionSelection prepareWithColorDescription(const ShaderFrame &,bool,const RSTemporalFrame *,ImageColorSpace,const ImageColorDescription&);
    EffectExecutionSelection prepareRecordedScene(const ShaderFrame&,const RSTemporalFrame&,const ImageColorDescription&);
    // Prepare color-only work for its actual eventual execution queue. The
    // producer buffer remains borrowed and receives no validation commands.
    EffectExecutionSelection prepareForQueue(const ShaderFrame&,id<MTLCommandQueue>,bool,ImageColorSpace,const ImageColorDescription&);
    bool prefersIndependentImageQueue();
    bool requiresPresentationQueue();
    // Rows after the final generator/display split prepare on this queue.
    // Set before preparation; nil keeps source and final work on one queue.
    void setFinalQueue(id<MTLCommandQueue>);
    EffectExecutionSelection prepareSceneContinuation(const ShaderFrame&,const RSTemporalFrame*,ImageColorSpace,const ImageColorDescription&,std::shared_ptr<const EffectPlanSnapshot>,const std::string&prefixIdentity);
    EffectExecutionSelection prepareSceneContinuation(const ShaderFrame&,const RSTemporalFrame*,ImageColorSpace,const ImageColorDescription&,std::shared_ptr<const EffectPlanSnapshot>,const std::string&,const std::shared_ptr<const EffectSceneLease>&);
    EffectExecutionSelection prepareSceneBoundary(const ShaderFrame&,const RSTemporalFrame&,const ImageColorDescription&,std::shared_ptr<const EffectPlanSnapshot>,size_t consumedNodes);
    void setStatusContext(uintptr_t);
    // Resource readiness only; the producer performs ordinary latest-plan adoption.
    // The observer must post to its own serialized producer queue.
    void setPreparationObserver(EffectPreparationObserver);
    // Offline producers wait for transient preparation instead of adopting
    // a graph with a still-preparing row. Permanent row bypasses are unchanged.
    void requireCompletePreparation(bool);
    bool requiresDepth();
    bool requiresTemporal();
    std::shared_ptr<const EffectPlanSnapshot> snapshot()const;
    EffectQualityStatus qualityStatus()const;
private:
    EffectExecutionSelection prepareSnapshot(const ShaderFrame&,bool,const RSTemporalFrame*,ImageColorSpace,const ImageColorDescription&,std::shared_ptr<const EffectPlanSnapshot>,const std::string&prefixIdentity,id<MTLCommandQueue>executionQueue=nil,const std::shared_ptr<const EffectSceneLease>&sceneLease={});
    EffectExecutionSelection buildSnapshot(const ShaderFrame&,bool,const RSTemporalFrame*,ImageColorSpace,const ImageColorDescription&,std::shared_ptr<const EffectPlanSnapshot>,const std::string&prefixIdentity,const std::string&requestIdentity,const RSTemporalFrame*rawGuides=nullptr,const std::shared_ptr<const EffectSceneLease>&sourceLease={});
};
}
