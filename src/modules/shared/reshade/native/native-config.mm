// Copyright (c) MacLauncher contributors. MIT license.
#include "native-config.hpp"
#include <atomic>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <dispatch/dispatch.h>
#include <initializer_list>
#include <mutex>
#include <unistd.h>
namespace macfx {
namespace {
std::optional<std::string> text(const char *name){const auto value=std::getenv(name);return value?std::optional<std::string>(value):std::nullopt;}
bool present(const char *name){return std::getenv(name)!=nullptr;}
bool selected(const std::optional<std::string> &value){return value&&!value->empty()&&*value!="off";}
// The parsers keep the messages and precedence of the former per-call readers.
LaunchSetting<bool> renderAutomatic(){
    const char *text=std::getenv("RESHADE_RENDER_AUTO");if(!text||!*text)return {false,{}};
    if(std::strcmp(text,"1"))return {{},"Automatic game rendering must be enabled with 1"};
    for(const char *name:{"RESHADE_RENDER_HEIGHT","RESHADE_RENDER_MAX_HEIGHT","RESHADE_RENDER_MULTIPLIER","RESHADE_RENDER_SOURCE_METHOD"})
        if(const char *other=std::getenv(name);other&&*other)return {{},"Automatic game rendering cannot include a manual source setting"};
    return {true,{}};
}
LaunchSetting<double> renderMultiplier(){
    const char *render=std::getenv("RESHADE_RENDER_MULTIPLIER");
    if(render&&*render){
        char *end=nullptr;const double divisor=std::strtod(render,&end);
        if(end!=render&&!*end&&std::isfinite(divisor)&&divisor>=1)return {divisor,{}};
        return {{},"Game rendering percentage must be above 0 and up to 100%"};
    }
    const char *method=std::getenv("RESHADE_SPATIAL_METHOD");
    const char *text=std::getenv("RESHADE_RESOLUTION_MULTIPLIER");
    if(!method||!*method||!std::strcmp(method,"off")||!text||!*text)return {};
    if(!std::strcmp(text,"1"))return {1.0,{}};
    if(!std::strcmp(text,"1.5"))return {1.5,{}};
    if(!std::strcmp(text,"2"))return {2.0,{}};
    return {{},"Resolution multiplier must be 1, 1.5 or 2"};
}
LaunchSetting<unsigned> renderHeight(const char *name,const char *error){
    const char *text=std::getenv(name);if(!text||!*text)return {};
    unsigned height=0;const char *end=text+std::strlen(text);const auto parsed=std::from_chars(text,end,height);
    if(parsed.ec!=std::errc{}||parsed.ptr!=end||height<1||height>16384)return {{},error};
    return {height,{}};
}
NativeConfig parse(){
    NativeConfig config;
    config.effectPlanFile=text("RESHADE_EFFECT_PLAN");config.controlFile=text("RESHADE_CONTROL_FILE");
    config.liveEffectsDirectory=text("RESHADE_LIVE_EFFECTS");config.effectFile=text("RESHADE_EFFECT");
    config.effectKey=text("RESHADE_EFFECT_KEY");config.technique=text("RESHADE_TECHNIQUE");
    const auto placement=std::getenv("RESHADE_EFFECT_PLACEMENT");config.effectAfterScaling=placement&&!std::strcmp(placement,"after");
    auto &graphics=config.graphics;
    graphics.spatialMethod=text("RESHADE_SPATIAL_METHOD");graphics.spatialSharpness=text("RESHADE_SPATIAL_SHARPNESS");graphics.ls1Mode=text("RESHADE_LS1_MODE");
    graphics.frameGeneration=text("RESHADE_FRAME_GENERATION");graphics.frameMultiplier=text("RESHADE_FRAME_MULTIPLIER");graphics.framePacing=text("RESHADE_FRAME_PACING");
    graphics.targetHz=text("RESHADE_TARGET_HZ");graphics.stableCadence=text("RESHADE_STABLE_CADENCE");graphics.lsfgMode=text("RESHADE_LSFG_MODE");
    graphics.lsfgFP16=text("RESHADE_LSFG_FP16");graphics.lsfgFlowScale=text("RESHADE_LSFG_FLOW_SCALE");graphics.losslessModel=text("RESHADE_LOSSLESS_MODEL");
    graphics.spatialRequested=selected(graphics.spatialMethod);graphics.generationRequested=selected(graphics.frameGeneration);
    auto &render=config.render;
    render.automatic=renderAutomatic();render.multiplier=renderMultiplier();
    render.height=renderHeight("RESHADE_RENDER_HEIGHT","Game rendering height must be an integer from 1 to 16384");
    render.maximum=renderHeight("RESHADE_RENDER_MAX_HEIGHT","Maximum game rendering height must be an integer from 1 to 16384");
    render.variables=present("RESHADE_RENDER_HEIGHT")||present("RESHADE_RENDER_MAX_HEIGHT")||present("RESHADE_RENDER_MULTIPLIER");
    render.control=text("RESHADE_RENDER_SOURCE_CONTROL").value_or("");
    for(const char *name:{"RESHADE_VIRTUAL_SOURCE_CONTROL_FILE","RESHADE_VIRTUAL_SOURCE_STATUS_FILE","RESHADE_VIRTUAL_SOURCE_LAUNCH_ID","RESHADE_VIRTUAL_SOURCE_ACTIVATION_API"})
        render.virtualChannel=render.virtualChannel||!text(name).value_or("").empty();
    config.capture.prefix=text("RESHADE_CAPTURE_PREFIX").value_or("");config.capture.trigger=text("RESHADE_CAPTURE_TRIGGER");
    if(const auto at=std::getenv("RESHADE_CAPTURE_FRAME"))config.capture.frame=std::strtoull(at,nullptr,10);
    auto &diagnostics=config.diagnostics;
    diagnostics.enabled=present("RESHADE_DIAGNOSTICS");diagnostics.path=text("RESHADE_DIAGNOSTICS").value_or("");diagnostics.trace=present("RESHADE_TRACE");
    diagnostics.metalPresentation=present("RESHADE_DIAGNOSTICS_METAL_PRESENTATION");
    diagnostics.openGLTransport=text("RESHADE_DIAGNOSTICS_OPENGL_TRANSPORT").value_or("");
    diagnostics.openGLPassthrough=text("RESHADE_DIAGNOSTICS_OPENGL_PASSTHROUGH").value_or("");
    config.temporal.method=text("RESHADE_TEMPORAL_METHOD").value_or("");config.temporal.asrQuality=text("RESHADE_ASR_QUALITY").value_or("");
    config.temporal.fsr4Profile=text("RESHADE_FSR4_PROFILE").value_or("");config.temporal.controlFile=text("RESHADE_TEMPORAL_CONTROL_FILE");
    auto &hold=config.presentationHold;
    hold.controlFile=text("RESHADE_PRESENTATION_CONTROL_FILE");hold.statusFile=text("RESHADE_PRESENTATION_STATUS_FILE");
    hold.launchId=text("RESHADE_PRESENTATION_LAUNCH_ID");hold.token=text("RESHADE_PRESENTATION_TOKEN");
    if(const auto number=std::getenv("RESHADE_WINDOW_ID"))config.windowId=std::strtol(number,nullptr,10);
    config.windowTitle=text("RESHADE_WINDOW_TITLE");
    const auto host=std::getenv("RESHADE_EXPLICIT_HOST");config.explicitHost=host&&!std::strcmp(host,"1");
    return config;
}
// Published configurations are leaked: hooks may run during static destruction
// and callers keep plain references. Only a changed setter value publishes.
std::atomic<const NativeConfig*> current{nullptr};
std::mutex &publishMutex(){static auto *value=new std::mutex;return *value;}
const NativeConfig &initialize(){
    std::lock_guard lock(publishMutex());
    if(const auto config=current.load(std::memory_order_acquire))return *config;
    auto *config=new NativeConfig(parse());config->generation=1;current.store(config,std::memory_order_release);return *config;
}
struct CaptureWatch {
    std::string trigger;std::atomic<uint64_t> requested{0},published{0},owner{0},ownerRequest{0},nextTicket{1};
    std::mutex pollMutex,reservationMutex;dispatch_source_t timer=nullptr;
};
void checkCaptureTrigger(void *context){
    auto *watch=static_cast<CaptureWatch*>(context);
    if(watch->trigger.empty())return;
    std::lock_guard guard(watch->pollMutex);
    if(unlink(watch->trigger.c_str())==0)watch->requested.fetch_add(1,std::memory_order_release);
}
CaptureWatch *captureWatch() noexcept {
    static CaptureWatch *const watch=[]()->CaptureWatch*{
        const auto &capture=nativeConfig().capture;if(!capture.configured())return nullptr;
        auto *value=new CaptureWatch;
        if(!capture.trigger){value->requested=1;return value;}
        value->trigger=*capture.trigger;
        value->timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_global_queue(QOS_CLASS_UTILITY,0));
        if(!value->timer)return value;
        dispatch_set_context(value->timer,value);dispatch_source_set_event_handler_f(value->timer,checkCaptureTrigger);
        dispatch_source_set_timer(value->timer,dispatch_time(DISPATCH_TIME_NOW,0),250*NSEC_PER_MSEC,25*NSEC_PER_MSEC);
        dispatch_resume(value->timer);return value;
    }();
    return watch;
}
}
const std::optional<std::string> *LegacyGraphicsConfig::find(const char *key) const noexcept {
    static constexpr struct {const char *name;std::optional<std::string> LegacyGraphicsConfig::*value;} keys[]{
        {"RESHADE_SPATIAL_METHOD",&LegacyGraphicsConfig::spatialMethod},{"RESHADE_SPATIAL_SHARPNESS",&LegacyGraphicsConfig::spatialSharpness},
        {"RESHADE_LS1_MODE",&LegacyGraphicsConfig::ls1Mode},{"RESHADE_FRAME_GENERATION",&LegacyGraphicsConfig::frameGeneration},
        {"RESHADE_FRAME_MULTIPLIER",&LegacyGraphicsConfig::frameMultiplier},{"RESHADE_FRAME_PACING",&LegacyGraphicsConfig::framePacing},
        {"RESHADE_TARGET_HZ",&LegacyGraphicsConfig::targetHz},{"RESHADE_STABLE_CADENCE",&LegacyGraphicsConfig::stableCadence},
        {"RESHADE_LSFG_MODE",&LegacyGraphicsConfig::lsfgMode},{"RESHADE_LSFG_FP16",&LegacyGraphicsConfig::lsfgFP16},
        {"RESHADE_LSFG_FLOW_SCALE",&LegacyGraphicsConfig::lsfgFlowScale},{"RESHADE_LOSSLESS_MODEL",&LegacyGraphicsConfig::losslessModel}};
    for(const auto &entry:keys)if(!std::strcmp(entry.name,key))return &(this->*entry.value);
    return nullptr;
}
const NativeConfig &nativeConfig() noexcept {
    if(const auto config=current.load(std::memory_order_acquire))return *config;
    return initialize();
}
bool captureTriggerPending() noexcept {const auto watch=captureWatch();return watch&&!watch->trigger.empty()&&watch->requested.load(std::memory_order_acquire)>watch->published.load(std::memory_order_acquire);}
uint64_t claimCaptureFrame(uint64_t frame) noexcept {
    const auto&capture=nativeConfig().capture;if(!capture.configured()||(!capture.trigger&&frame!=capture.frame))return 0;
    auto*watch=captureWatch();if(!watch)return 0;
    std::unique_lock lock(watch->reservationMutex,std::try_to_lock);if(!lock.owns_lock())return 0;
    const auto request=watch->requested.load(std::memory_order_acquire);if(request<=watch->published.load(std::memory_order_acquire))return 0;
    const auto ticket=watch->nextTicket.fetch_add(1,std::memory_order_relaxed);uint64_t expected=0;
    if(!watch->owner.compare_exchange_strong(expected,ticket,std::memory_order_acq_rel))return 0;
    watch->ownerRequest.store(request,std::memory_order_release);return ticket;
}
bool captureFrameCurrent(uint64_t ticket) noexcept {
    auto*watch=captureWatch();if(!ticket||!watch)return false;
    std::lock_guard guard(watch->reservationMutex);if(watch->owner.load(std::memory_order_acquire)!=ticket)return false;
    checkCaptureTrigger(watch);
    return watch->owner.load(std::memory_order_acquire)==ticket&&watch->ownerRequest.load(std::memory_order_acquire)==watch->requested.load(std::memory_order_acquire);
}
void finishCaptureFrame(uint64_t ticket,bool published) noexcept {
    auto*watch=captureWatch();if(!ticket||!watch)return;
    std::lock_guard guard(watch->reservationMutex);if(watch->owner.load(std::memory_order_acquire)!=ticket)return;
    if(published){checkCaptureTrigger(watch);if(watch->ownerRequest.load(std::memory_order_acquire)==watch->requested.load(std::memory_order_acquire))watch->published.store(watch->ownerRequest.load(std::memory_order_acquire),std::memory_order_release);}
    watch->owner.compare_exchange_strong(ticket,0,std::memory_order_acq_rel);
}
}
extern "C" int rsSetExplicitHost(uint32_t version,int enabled){
    if(version!=1||(enabled!=0&&enabled!=1))return 0;
    macfx::nativeConfig();   // the launch generation, read outside the publish lock
    std::lock_guard lock(macfx::publishMutex());
    const auto previous=macfx::current.load(std::memory_order_acquire);
    if(previous->explicitHost==bool(enabled))return 1;
    auto *next=new macfx::NativeConfig(*previous);
    next->explicitHost=enabled;next->generation=previous->generation+1;
    macfx::current.store(next,std::memory_order_release);return 1;
}
