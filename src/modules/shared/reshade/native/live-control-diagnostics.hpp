#pragma once
#include <cstdint>

namespace macfx {
// An observation of an existing reader attempt, never a request to poll.
// This internal metadata has no shader/model contents or public ABI layout.
enum class LiveControlPollResult : unsigned {
    Never,NoPath,OpenFailed,FstatFailed,NotRegular,WrongSize,PreadFailed,ShortRead,
    Magic,TargetRate,Multiplier,Flags,UniformCount,Spatial,Sharpness,LS1Mode,LSFGMode,
    FlowScale,UniformName,UniformComponents,UniformValue,Unchanged,Accepted
};
inline const char *liveControlPollResultName(LiveControlPollResult value) noexcept {
    switch(value){
#define ML_CONTROL_RESULT(name) case LiveControlPollResult::name:return #name;
        ML_CONTROL_RESULT(Never) ML_CONTROL_RESULT(NoPath) ML_CONTROL_RESULT(OpenFailed)
        ML_CONTROL_RESULT(FstatFailed) ML_CONTROL_RESULT(NotRegular) ML_CONTROL_RESULT(WrongSize)
        ML_CONTROL_RESULT(PreadFailed) ML_CONTROL_RESULT(ShortRead) ML_CONTROL_RESULT(Magic)
        ML_CONTROL_RESULT(TargetRate) ML_CONTROL_RESULT(Multiplier) ML_CONTROL_RESULT(Flags)
        ML_CONTROL_RESULT(UniformCount) ML_CONTROL_RESULT(Spatial) ML_CONTROL_RESULT(Sharpness)
        ML_CONTROL_RESULT(LS1Mode) ML_CONTROL_RESULT(LSFGMode) ML_CONTROL_RESULT(FlowScale)
        ML_CONTROL_RESULT(UniformName) ML_CONTROL_RESULT(UniformComponents) ML_CONTROL_RESULT(UniformValue)
        ML_CONTROL_RESULT(Unchanged) ML_CONTROL_RESULT(Accepted)
#undef ML_CONTROL_RESULT
    }
    return "Unknown";
}
struct LiveControlPollDiagnostic {
    uintptr_t reader=0;
    uint64_t attempts=0,generation=0;
    LiveControlPollResult result=LiveControlPollResult::Never;
    int error=0,planMode=0;
    uint32_t flags=0,uniformIndex=UINT32_MAX;
    bool loaded=false,live=false,explicitHost=false,requested=false;
};
inline LiveControlPollDiagnostic &liveControlPollDiagnosticState() noexcept {
    static thread_local LiveControlPollDiagnostic value;return value;
}
// Caller must already be inside an opted-in diagnostic path. No reads, polls,
// timestamps, allocation or logging occur in this getter.
inline const LiveControlPollDiagnostic &lastLiveControlPollDiagnostic() noexcept {
    return liveControlPollDiagnosticState();
}
}
