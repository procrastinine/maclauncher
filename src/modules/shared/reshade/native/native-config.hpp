#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <cstdint>
#include <optional>
#include <string>
namespace macfx {
// A launch setting validated once. An invalid value keeps its message and the
// accessor that reads it rethrows it, so an unused invalid setting stays inert.
template<class T> struct LaunchSetting {std::optional<T> value;std::string error;};
// Source reduction (RESHADE_RENDER_*, resolution-scale.hpp).
struct RenderSourceConfig {
    LaunchSetting<bool> automatic;
    LaunchSetting<unsigned> height,maximum;
    LaunchSetting<double> multiplier;
    bool variables=false;          // RESHADE_RENDER_HEIGHT, _MAX_HEIGHT or _MULTIPLIER is present
    std::string control;           // RESHADE_RENDER_SOURCE_CONTROL
    // A RESHADE_VIRTUAL_SOURCE_* channel variable is set. A partial dedicated
    // channel stays dormant rather than falling back to the shared one.
    bool virtualChannel=false;
};
// Legacy Simple selection. Values stay text; graphicsConfig() validates them.
struct LegacyGraphicsConfig {
    std::optional<std::string> spatialMethod,spatialSharpness,ls1Mode,frameGeneration,frameMultiplier,framePacing,
        targetHz,stableCadence,lsfgMode,lsfgFP16,lsfgFlowScale,losslessModel;
    bool spatialRequested=false,generationRequested=false;   // a value other than empty or "off"
    // The launch value of one RESHADE_* key read by graphicsConfig(), or null.
    const std::optional<std::string> *find(const char *key) const noexcept;
};
// Diagnostic frame capture: a fixed frame number, or one capture per trigger file.
struct CaptureConfig {
    std::string prefix;std::optional<std::string> trigger;uint64_t frame=120;
    bool configured() const noexcept {return !prefix.empty();}
};
// enabled: RESHADE_DIAGNOSTICS is present; path: its value, the prefix of diagnostic files.
struct DiagnosticConfig {bool enabled=false,trace=false,metalPresentation=false;std::string path,openGLTransport,openGLPassthrough;};
// Legacy temporal selection (RESHADE_TEMPORAL_*); a control file overrides it during the process.
struct TemporalLaunchConfig {std::string method,asrQuality,fsr4Profile;std::optional<std::string> controlFile;};
// Presentation hold channel (RESHADE_PRESENTATION_*, presentation-hold.hpp). The
// files and identity are fixed at launch; commands arrive through the file.
struct PresentationHoldConfig {
    std::optional<std::string> controlFile,statusFile,launchId,token;
    bool configured() const noexcept {return controlFile&&!controlFile->empty();}
};
struct NativeConfig {
    uint64_t generation=0;
    // Launch-fixed; read from the process environment once, at first use.
    std::optional<std::string> effectPlanFile,controlFile,liveEffectsDirectory,effectFile,effectKey,technique;
    bool effectAfterScaling=false;
    LegacyGraphicsConfig graphics;
    RenderSourceConfig render;
    CaptureConfig capture;
    DiagnosticConfig diagnostics;
    TemporalLaunchConfig temporal;
    PresentationHoldConfig presentationHold;
    std::optional<long> windowId;std::optional<std::string> windowTitle;
    // RESHADE_EXPLICIT_HOST=1 at launch, or rsSetExplicitHost during the process.
    bool explicitHost=false;
    bool effectPlanRequested() const noexcept {return effectPlanFile&&!effectPlanFile->empty();}
    bool liveEffects() const noexcept {return liveEffectsDirectory&&!explicitHost;}
};
// One acquire load. A configuration is immutable and never freed; a setter
// publishes a new generation instead of changing the current one.
const NativeConfig &nativeConfig() noexcept;
// The capture trigger is checked every 250 ms off the frame path, starting at
// the first query. Reservations leave it pending until successful publication.
bool captureTriggerPending() noexcept;
uint64_t claimCaptureFrame(uint64_t frame) noexcept;
// Completion-time check; also drains a newer trigger off the frame path.
bool captureFrameCurrent(uint64_t ticket) noexcept;
void finishCaptureFrame(uint64_t ticket,bool published) noexcept;
}
// Version 1. Returns 1 when applied and 0 for an unsupported version or value.
extern "C" int rsSetExplicitHost(uint32_t version,int enabled);
