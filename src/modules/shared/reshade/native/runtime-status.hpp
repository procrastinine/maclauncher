#pragma once
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace macfx {
enum class RuntimeStatusPhase : uint32_t {Prepared=1,Encoded=2,Completed=3,Presented=4,Bypassed=5,Failed=6,Stopped=7};
struct RuntimeStatusEvent {
    uintptr_t context=0;
    RuntimeStatusPhase phase=RuntimeStatusPhase::Prepared;
    bool processing=false,generated=false,resourceAccepted=false;
    uint64_t frameId=0,requestedBytes=0,admittedBytes=0;
    double sourceTime=0,presentedTime=0;
    unsigned inputWidth=0,inputHeight=0,outputWidth=0,outputHeight=0;
    std::string_view planRevision,controlsDigest,stageId,requestedMethod,activeMethod,reason;
};
// Called from the existing control poll, never a producer/render callback.
// No-demand returns before environment, file, mapping or allocation work.
void pollRuntimeStatus(bool processingRequested) noexcept;
// Explicit producers may request the same poll through a bounded, coalesced
// utility-queue task. No task is scheduled Off or after the page is mapped.
void requestRuntimeStatusPoll(bool processingRequested) noexcept;
// Copies borrowed string_views synchronously into fixed slots. No allocation,
// filesystem calls, wait, serialization, GPU work or worker thread occurs here.
void observeRuntimeStatus(const RuntimeStatusEvent&) noexcept;
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
    Admission admission;char reserved[112];
    Stage rows[stageCount];
};
static_assert(sizeof(Stage)==768 && offsetof(Stage,frameId)==672 && offsetof(Stage,phase)==644);
static_assert(offsetof(Context,rows)==1024 && sizeof(Context)<=slotSize);
static_assert(offsetof(Context,planRevision)==112 && offsetof(Context,reason)==242);
static_assert(offsetof(Context,acceptedRevision)==528 && offsetof(Context,acceptedAt)==664);
static_assert(sizeof(Admission)==240 && offsetof(Context,admission)==672);
}
}
