#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace macfx {
// Preparing: a candidate for the event's plan revision is still preparing, or
// waits for a transient resource inside its bounded retry.
// Hidden: macOS reports the game's window hidden and the game is not drawing
// to it; no change is accepted while such a context is current.
enum class RuntimeStatusPhase : uint32_t {Prepared=1,Encoded=2,Completed=3,Presented=4,Bypassed=5,Failed=6,Stopped=7,Preparing=8,Hidden=9};
enum class RuntimeFrameSource : uint32_t {Unknown=0,MetalDrawable=1,OpenGLFramebuffer=2,LayerSurface=3,SoftwareBitmap=4,BrowserWindow=5,ExplicitTexture=6,DecodedVideo=7};
enum RuntimeFrameInput : uint32_t {RuntimeInputDepth=1,RuntimeInputMotion=2,RuntimeInputJitter=4,RuntimeInputCamera=8,RuntimeInputExposure=16,RuntimeInputViewMatrix=32,RuntimeInputProjectionMatrix=64};
enum class RuntimeAdaptiveQualityState : uint32_t {Pending=1,Active=2,Off=3};
enum class RuntimeAdaptiveQualityScope : uint32_t {Unknown=0,SourceAndProcessing=1,ImageProcessing=2,FinalProcessing=3,OfflineFrame=4,ExternalProcessing=5};
struct RuntimeAdaptiveQualityEvent {
    uintptr_t context=0;RuntimeAdaptiveQualityState state=RuntimeAdaptiveQualityState::Pending;
    RuntimeAdaptiveQualityScope scope=RuntimeAdaptiveQualityScope::Unknown;
    double scale=1,meanMilliseconds=0;
    std::string_view nodeId,reason,planRevision,controlsDigest;
};
struct RuntimeStatusEvent {
    uintptr_t context=0;
    RuntimeStatusPhase phase=RuntimeStatusPhase::Prepared;
    bool processing=false,generated=false,resourceAccepted=false,asynchronous=false;
    // A valid plan that selects no image processing is adopted without an
    // executor. Such an event writes only a page this process already mapped
    // while a reader holds its lease, and requests no poll.
    bool idle=false;
    uint64_t frameId=0,requestedBytes=0,admittedBytes=0;
    double sourceTime=0,presentedTime=0;
    unsigned inputWidth=0,inputHeight=0,outputWidth=0,outputHeight=0;
    std::string_view planRevision,controlsDigest,stageId,requestedMethod,activeMethod,reason;
};
// Called from the existing control poll, never a producer/render callback.
// Without processing it only maps a leased page this process has not mapped,
// at most once per second, and never records frames; a mapped process
// returns after atomic deactivation.
void pollRuntimeStatus(bool processingRequested) noexcept;
// Explicit producers may request the same poll through a bounded, coalesced
// utility-queue task. No task is scheduled Off or after the page is mapped.
void requestRuntimeStatusPoll(bool processingRequested) noexcept;
// Copies borrowed string_views synchronously into fixed slots. Actual work can
// arm the bounded utility-queue metadata request above; the caller performs no
// filesystem access, wait, serialization or GPU work for this observation.
void observeRuntimeStatus(const RuntimeStatusEvent&) noexcept;
// Whether a reader currently leases a page this process already mapped. It
// performs no environment, file or mapping work, so Off callers can gate on it.
bool runtimeStatusLeased() noexcept;
// Actual producer observations use the existing inspector lease and slot.
// This does not discover a renderer, open a page or enable image processing.
void observeRuntimeFrameSource(uintptr_t,RuntimeFrameSource,uint32_t inputs=0) noexcept;
// Optional metadata on the existing leased context. No mapping, polling or
// timing is created here; the caller supplies its completed GPU-work scope.
void observeRuntimeAdaptiveQuality(const RuntimeAdaptiveQualityEvent&) noexcept;
// Admission checks are metadata observations, never encoded/completed frames.
// This uses only an existing, currently leased page and the same bounded writer.
void observeRuntimeAdmission(uintptr_t context,std::string_view reason,unsigned width=0,unsigned height=0,
    uintptr_t queue=0,uint32_t format=0) noexcept;
void retireRuntimeStatus(uintptr_t context) noexcept;

namespace runtime_status {
constexpr uint32_t schema=1,headerSize=4096,slotSize=32768,slotCount=8,stageCount=32;
constexpr size_t pageSize=headerSize+size_t(slotSize)*slotCount;
struct Header {
    char magic[8];uint32_t version,bytes;uint64_t leaseUntil;
    uint32_t launchIdLength,reserved;char token[64],launchId[128];
};
struct Stage {
    char id[129],requested[128],active[128],reason[256];
    uint32_t phase,inputWidth,inputHeight,outputWidth,outputHeight,reserved;
    uint64_t frameId,encoded,completed,presented,observedAt;char padding[56];
};
struct Admission {
    uint32_t schema,reason;uint64_t observedAt,counts[24],queue,generation;
    uint32_t format,width,height,reserved;
};
struct FrameSource {uint32_t schema,source,inputs,reserved;uint64_t observedAt;char padding[88];};
struct AdaptiveQuality {
    uint32_t schema,state,scope,reserved;double scale,meanMilliseconds;uint64_t observedAt;
    char nodeId[129],reason[256],padding[23];
};
struct Context {
    uint32_t pid,sequence;uint64_t id;
    uint32_t phase,stages;uint64_t frameId,encoded,completed,presentedReal,presentedGenerated;
    double sourceTime,presentedTime;uint32_t inputWidth,inputHeight,outputWidth,outputHeight;
    uint64_t requestedBytes,admittedBytes;char planRevision[65],controlsDigest[65],reason[256],padding[6];
    uint64_t observedAt,processStartSeconds,processStartMicroseconds;
    // Resource adoption is separate from an attempted or observed frame.
    // Only synchronous adoption/current-encoding events may update this proof;
    // delayed completion/presentation of an older batch must leave it intact.
    char acceptedRevision[65],acceptedControlsDigest[65],acceptedPadding[6];uint64_t acceptedAt;
    Admission admission;FrameSource frameSource;
    Stage rows[stageCount];
    AdaptiveQuality adaptiveQuality;
};
static_assert(sizeof(Stage)==768 && offsetof(Stage,frameId)==672 && offsetof(Stage,phase)==644);
static_assert(offsetof(Context,rows)==1024 && sizeof(Context)<=slotSize);
static_assert(offsetof(Context,planRevision)==112 && offsetof(Context,reason)==242);
static_assert(offsetof(Context,acceptedRevision)==528 && offsetof(Context,acceptedAt)==664);
static_assert(sizeof(Admission)==240 && offsetof(Context,admission)==672);
static_assert(sizeof(FrameSource)==112 && offsetof(Context,frameSource)==912);
static_assert(sizeof(AdaptiveQuality)==448 && offsetof(Context,adaptiveQuality)==25600);
}
}
