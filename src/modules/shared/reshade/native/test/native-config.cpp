// Copyright (c) MacLauncher contributors. MIT license.
// The native launch configuration is parsed once, published without locks and
// changed only by its versioned setter. Each launch environment is a phase.
#include "native-config.hpp"
#include "process-phase.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>
namespace {
const char *const variables[]{"RESHADE_EFFECT_PLAN","RESHADE_CONTROL_FILE","RESHADE_LIVE_EFFECTS","RESHADE_EFFECT","RESHADE_EFFECT_KEY",
    "RESHADE_TECHNIQUE","RESHADE_EFFECT_PLACEMENT","RESHADE_SPATIAL_METHOD","RESHADE_FRAME_GENERATION","RESHADE_RESOLUTION_MULTIPLIER",
    "RESHADE_LOSSLESS_MODEL","RESHADE_RENDER_AUTO","RESHADE_RENDER_HEIGHT","RESHADE_RENDER_MAX_HEIGHT","RESHADE_RENDER_MULTIPLIER",
    "RESHADE_RENDER_SOURCE_METHOD","RESHADE_RENDER_SOURCE_CONTROL","RESHADE_CAPTURE_PREFIX","RESHADE_CAPTURE_TRIGGER","RESHADE_CAPTURE_FRAME",
    "RESHADE_DIAGNOSTICS","RESHADE_TRACE","RESHADE_WINDOW_ID","RESHADE_WINDOW_TITLE","RESHADE_EXPLICIT_HOST",
    "RESHADE_TEMPORAL_METHOD","RESHADE_ASR_QUALITY","RESHADE_FSR4_PROFILE","RESHADE_TEMPORAL_CONTROL_FILE",
    "RESHADE_PRESENTATION_CONTROL_FILE","RESHADE_PRESENTATION_STATUS_FILE","RESHADE_PRESENTATION_LAUNCH_ID","RESHADE_PRESENTATION_TOKEN",
    "RESHADE_VIRTUAL_SOURCE_CONTROL_FILE","RESHADE_VIRTUAL_SOURCE_STATUS_FILE","RESHADE_VIRTUAL_SOURCE_LAUNCH_ID","RESHADE_VIRTUAL_SOURCE_ACTIVATION_API"};
// Runs one phase with only the given launch variables set.
int launch(const char *name,const fixture::Environment &settings,const std::vector<std::string> &arguments={}){
    fixture::Environment environment;for(const char *variable:variables)environment.emplace_back(variable,nullptr);
    for(const auto &[variable,value]:settings)for(auto &entry:environment)if(!std::strcmp(entry.first,variable))entry.second=value;
    return fixture::runPhase(name,environment,arguments);
}
bool exists(const std::string &path){return access(path.c_str(),F_OK)==0;}
int launchValues(){
    const auto &config=macfx::nativeConfig();assert(config.generation==1);
    assert(config.effectPlanRequested()&&*config.effectPlanFile=="/plan/effects.json"&&*config.controlFile=="/plan/controls.bin");
    assert(*config.liveEffectsDirectory=="/plan/live"&&*config.effectFile=="/plan/effect.fx"&&*config.effectKey=="key"&&*config.technique=="Main");
    assert(config.effectAfterScaling&&config.explicitHost&&!config.liveEffects());
    assert(config.graphics.spatialRequested&&!config.graphics.generationRequested&&*config.graphics.frameGeneration=="off");
    assert(config.graphics.find("RESHADE_SPATIAL_METHOD")==&config.graphics.spatialMethod&&config.graphics.find("RESHADE_LOSSLESS_MODEL")->value()=="/model.dll");
    assert(!config.graphics.find("RESHADE_FRAME_MULTIPLIER")->has_value()&&!config.graphics.find("RESHADE_EFFECT_PLAN"));
    // Invalid render settings keep their message for the accessor that reads them.
    const auto &render=config.render;assert(render.variables&&render.control=="drawable"&&!render.virtualChannel);
    assert(*render.height.value==480&&render.height.error.empty()&&!render.maximum.value&&render.maximum.error.empty());
    assert(!render.multiplier.value&&render.multiplier.error=="Game rendering percentage must be above 0 and up to 100%");
    assert(*render.automatic.value==false&&render.automatic.error.empty());
    assert(config.capture.configured()&&config.capture.prefix=="/captures/frame"&&!config.capture.trigger&&config.capture.frame==7);
    assert(!macfx::captureTriggerPending()&&!macfx::claimCaptureFrame(0));
    assert(config.diagnostics.enabled&&config.diagnostics.path=="/diagnostics/run"&&!config.diagnostics.trace&&*config.windowId==42&&*config.windowTitle=="Game");
    assert(config.temporal.method=="fsr3"&&config.temporal.asrQuality=="quality"&&config.temporal.fsr4Profile.empty()&&*config.temporal.controlFile=="/plan/temporal.bin");
    const auto &hold=config.presentationHold;
    assert(hold.configured()&&*hold.controlFile=="/plan/presentation-control-a.json"&&*hold.statusFile=="/plan/presentation-status-a.json"&&*hold.launchId=="a"&&*hold.token=="t");
    // Later environment changes do not reach the launch configuration.
    setenv("RESHADE_EFFECT_PLAN","/other",1);unsetenv("RESHADE_EXPLICIT_HOST");setenv("RESHADE_TRACE","1",1);
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);setenv("RESHADE_VIRTUAL_SOURCE_LAUNCH_ID","late",1);
    assert(&macfx::nativeConfig()==&config&&*config.effectPlanFile=="/plan/effects.json"&&config.explicitHost&&!config.diagnostics.trace);
    assert(render.control=="drawable"&&!render.virtualChannel);
    return 0;
}
// Per-frame virtual source checks read the selected control and channel here.
int virtualChannel(bool expected){
    const auto &render=macfx::nativeConfig().render;assert(render.control=="virtual"&&render.virtualChannel==expected);
    unsetenv("RESHADE_RENDER_SOURCE_CONTROL");unsetenv("RESHADE_VIRTUAL_SOURCE_STATUS_FILE");
    assert(macfx::nativeConfig().render.control=="virtual"&&macfx::nativeConfig().render.virtualChannel==expected);
    return 0;
}
int emptyLaunch(){
    // Concurrent first use publishes exactly one configuration.
    std::vector<const macfx::NativeConfig*> seen(8);std::vector<std::thread> threads;
    for(auto &entry:seen)threads.emplace_back([&entry]{entry=&macfx::nativeConfig();});
    for(auto &thread:threads)thread.join();
    for(const auto *entry:seen)assert(entry==seen[0]);
    const auto &config=*seen[0];
    assert(!config.effectPlanFile&&!config.effectPlanRequested()&&!config.controlFile&&!config.liveEffects()&&!config.effectAfterScaling);
    assert(!config.graphics.spatialRequested&&!config.graphics.generationRequested&&!config.render.variables&&config.render.control.empty());
    assert(!config.render.height.value&&!config.render.maximum.value&&!config.render.multiplier.value&&!*config.render.automatic.value);
    assert(!config.capture.configured()&&config.capture.frame==120&&!macfx::captureTriggerPending()&&!macfx::claimCaptureFrame(120));
    assert(!config.explicitHost&&!config.windowId&&!config.windowTitle&&!config.diagnostics.enabled&&config.diagnostics.path.empty());
    assert(config.temporal.method.empty()&&config.temporal.asrQuality.empty()&&!config.temporal.controlFile);
    assert(!config.presentationHold.configured()&&!config.presentationHold.statusFile&&!config.presentationHold.token);
    return 0;
}
int explicitHost(){
    // Only "1" selects the explicit host; any other value leaves live effects on.
    const auto &launch=macfx::nativeConfig();assert(!launch.explicitHost&&launch.liveEffects()&&launch.generation==1);
    assert(launch.render.automatic.error=="Automatic game rendering must be enabled with 1");
    assert(launch.render.height.error=="Game rendering height must be an integer from 1 to 16384");
    assert(launch.render.maximum.error=="Maximum game rendering height must be an integer from 1 to 16384");
    assert(launch.render.multiplier.error=="Resolution multiplier must be 1, 1.5 or 2");
    assert(rsSetExplicitHost(2,1)==0&&rsSetExplicitHost(1,2)==0&&rsSetExplicitHost(1,-1)==0);
    assert(rsSetExplicitHost(1,0)==1&&&macfx::nativeConfig()==&launch);
    assert(rsSetExplicitHost(1,1)==1);const auto &host=macfx::nativeConfig();
    assert(&host!=&launch&&host.generation==2&&host.explicitHost&&!host.liveEffects()&&*host.liveEffectsDirectory=="/live");
    // The earlier generation stays valid for callers that kept a reference.
    assert(!launch.explicitHost&&launch.liveEffects());
    assert(rsSetExplicitHost(1,1)==1&&&macfx::nativeConfig()==&host);
    assert(rsSetExplicitHost(1,0)==1&&macfx::nativeConfig().generation==3&&!macfx::nativeConfig().explicitHost);
    return 0;
}
// The trigger file is consumed off the frame path within the 250 ms interval;
// A reservation stays pending until publication; stale completions cannot
// consume a retry of the same request.
int capture(const std::string &directory){
    const auto trigger=directory+"/trigger";
    assert(!macfx::captureTriggerPending());std::this_thread::sleep_for(std::chrono::milliseconds(300));assert(!macfx::claimCaptureFrame(0));
    for(unsigned request=0;request<2;++request){
        {std::ofstream out(trigger);out<<"capture\n";assert(out.good());}
        const auto start=std::chrono::steady_clock::now();
        while(!macfx::captureTriggerPending()&&std::chrono::steady_clock::now()-start<std::chrono::seconds(2))std::this_thread::sleep_for(std::chrono::milliseconds(5));
        const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
        assert(macfx::captureTriggerPending()&&!exists(trigger));
        std::printf("capture trigger %u consumed after %lld ms\n",request+1,static_cast<long long>(elapsed));
        const auto ticket=macfx::claimCaptureFrame(0);assert(ticket&&macfx::captureTriggerPending()&&!macfx::claimCaptureFrame(0));
        macfx::finishCaptureFrame(ticket,false);assert(macfx::captureTriggerPending());
        const auto retry=macfx::claimCaptureFrame(0);assert(retry&&retry!=ticket&&macfx::captureFrameCurrent(retry));
        macfx::finishCaptureFrame(ticket,true);assert(macfx::captureTriggerPending());
        macfx::finishCaptureFrame(retry,true);assert(!macfx::captureTriggerPending()&&!macfx::claimCaptureFrame(0));
    }
    return 0;
}
}
int main(int argc,char **argv){
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        assert(argc==2);const std::string directory=argv[1];
        const auto prefix=directory+"/frame",trigger=directory+"/trigger";
        if(const int status=launch("launch",{{"RESHADE_EFFECT_PLAN","/plan/effects.json"},{"RESHADE_CONTROL_FILE","/plan/controls.bin"},
            {"RESHADE_LIVE_EFFECTS","/plan/live"},{"RESHADE_EFFECT","/plan/effect.fx"},{"RESHADE_EFFECT_KEY","key"},{"RESHADE_TECHNIQUE","Main"},
            {"RESHADE_EFFECT_PLACEMENT","after"},{"RESHADE_SPATIAL_METHOD","fsr"},{"RESHADE_FRAME_GENERATION","off"},{"RESHADE_LOSSLESS_MODEL","/model.dll"},
            {"RESHADE_RENDER_HEIGHT","480"},{"RESHADE_RENDER_MULTIPLIER","0.5"},{"RESHADE_RENDER_SOURCE_CONTROL","drawable"},
            {"RESHADE_CAPTURE_PREFIX","/captures/frame"},{"RESHADE_CAPTURE_FRAME","7"},{"RESHADE_DIAGNOSTICS","/diagnostics/run"},
            {"RESHADE_TEMPORAL_METHOD","fsr3"},{"RESHADE_ASR_QUALITY","quality"},{"RESHADE_TEMPORAL_CONTROL_FILE","/plan/temporal.bin"},
            {"RESHADE_PRESENTATION_CONTROL_FILE","/plan/presentation-control-a.json"},{"RESHADE_PRESENTATION_STATUS_FILE","/plan/presentation-status-a.json"},
            {"RESHADE_PRESENTATION_LAUNCH_ID","a"},{"RESHADE_PRESENTATION_TOKEN","t"},
            {"RESHADE_WINDOW_ID","42"},{"RESHADE_WINDOW_TITLE","Game"},{"RESHADE_EXPLICIT_HOST","1"}}))return status;
        if(const int status=launch("empty",{}))return status;
        if(const int status=launch("shared-channel",{{"RESHADE_RENDER_SOURCE_CONTROL","virtual"},{"RESHADE_VIRTUAL_SOURCE_LAUNCH_ID",""}}))return status;
        if(const int status=launch("virtual-channel",{{"RESHADE_RENDER_SOURCE_CONTROL","virtual"},{"RESHADE_VIRTUAL_SOURCE_STATUS_FILE","/status.json"}}))return status;
        if(const int status=launch("explicit-host",{{"RESHADE_LIVE_EFFECTS","/live"},{"RESHADE_EXPLICIT_HOST","true"},{"RESHADE_RENDER_AUTO","true"},
            {"RESHADE_RENDER_HEIGHT","0"},{"RESHADE_RENDER_MAX_HEIGHT","16385"},{"RESHADE_SPATIAL_METHOD","fsr"},{"RESHADE_RESOLUTION_MULTIPLIER","3"}}))return status;
        if(const int status=launch("capture",{{"RESHADE_CAPTURE_PREFIX",prefix.c_str()},{"RESHADE_CAPTURE_TRIGGER",trigger.c_str()}},{directory}))return status;
        std::puts("Native configuration: launch values parsed once, concurrent first use, lazy setting errors, versioned explicit-host setter, virtual source channel, off-frame capture trigger");
        return 0;
    }
    if(phase.name=="launch")return launchValues();
    if(phase.name=="empty")return emptyLaunch();
    if(phase.name=="shared-channel")return virtualChannel(false);
    if(phase.name=="virtual-channel")return virtualChannel(true);
    if(phase.name=="explicit-host")return explicitHost();
    if(phase.name=="capture"){assert(phase.argc==2);return capture(phase.argv[1]);}
    return 2;
}
