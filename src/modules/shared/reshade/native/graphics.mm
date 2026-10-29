#include "graphics.hpp"
#include "live-controls.hpp"
#include "effects-plan.hpp"
#include "native-config.hpp"
#include "generation-methods.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <locale>
#include <sstream>
#include <stdexcept>
namespace {
double number(const std::function<std::string(const char*)>&read,const char*key,double fallback,double minimum,double maximum) {
    const auto text=read(key);if(text.empty())return fallback;
    std::istringstream stream(text);stream.imbue(std::locale::classic());double value;
    if(!(stream>>value)||!stream.eof()||!std::isfinite(value)||value<minimum||value>maximum)
        throw std::runtime_error(std::string("Invalid graphics value: ")+key);
    return value;
}
bool mode(const std::string&value,const char*key) {
    if(value.empty()||value=="quality")return false;
    if(value=="performance")return true;
    throw std::runtime_error(std::string("Invalid graphics mode: ")+key);
}
}
macfx::GraphicsConfig macfx::graphicsConfig(const std::function<std::string(const char*)>&read) {
    GraphicsConfig value;
    const auto method=read("RESHADE_SPATIAL_METHOD");
    if(!method.empty())value.spatialMethod=method;
    if(value.spatialMethod!="off"&&value.spatialMethod!="bilinear"&&value.spatialMethod!="nearest"&&value.spatialMethod!="bicubic"&&value.spatialMethod!="area"&&value.spatialMethod!="metalfx"&&value.spatialMethod!="mako"&&value.spatialMethod!="ls1"&&value.spatialMethod!="fsr1")
        throw std::runtime_error("Unknown spatial scaling method");
    const auto generation=read("RESHADE_FRAME_GENERATION");
    if(!generation.empty()&&generation!="off"&&!macfx::generationMethodInfo(generation))
        throw std::runtime_error("Unknown frame-generation method");
    // Disabled processing does not inspect model paths or unrelated options.
    if(value.spatialMethod=="off"&&(generation.empty()||generation=="off"))return value;
    if(value.spatialMethod!="off") {
        value.sharpness=number(read,"RESHADE_SPATIAL_SHARPNESS",.5,0,1);
        if(value.spatialMethod=="ls1")value.ls1Performance=mode(read("RESHADE_LS1_MODE"),"RESHADE_LS1_MODE");
    }
    if(value.spatialMethod=="ls1"||generation=="lsfg") {
        value.modelPath=read("RESHADE_LOSSLESS_MODEL");
        if(value.modelPath.empty()||value.modelPath.front()!='/')throw std::runtime_error("A local model file with an absolute path is required");
    }
    if(!generation.empty()&&generation!="off") {
        value.generationMethod=generation;
        LsfgConfig graph;graph.modelPath=read("RESHADE_LOSSLESS_MODEL");
        if((generation=="mlx-interpolation"||generation=="rife")&&(graph.modelPath.empty()||graph.modelPath.front()!='/'))throw std::runtime_error("A local interpolation model is required");
        const double multiplier=number(read,"RESHADE_FRAME_MULTIPLIER",2,2,5);
        if(std::floor(multiplier)!=multiplier)throw std::runtime_error("Frame multiplier must be an integer");
        graph.multiplier=static_cast<unsigned>(multiplier);
        if(graph.multiplier>macfx::generationMethodInfo(generation)->maximumMultiplier)throw std::runtime_error("The requested multiplier exceeds this generation provider's phase contract");
        graph.flowScale=number(read,"RESHADE_LSFG_FLOW_SCALE",1,.25,1);
        graph.performance=mode(read("RESHADE_LSFG_MODE"),"RESHADE_LSFG_MODE");
        const auto precision=read("RESHADE_LSFG_FP16");
        if(!precision.empty()&&precision!="0"&&precision!="1")throw std::runtime_error("Frame precision must be zero or one");
        graph.fp16=precision!="0";
        const auto pacing=read("RESHADE_FRAME_PACING");
        if(!pacing.empty()&&pacing!="fixed"&&pacing!="adaptive")throw std::runtime_error("Unknown frame-pacing mode");
        if(pacing=="adaptive") {
            const double target=number(read,"RESHADE_TARGET_HZ",120,30,240);
            if(std::floor(target)!=target)throw std::runtime_error("Presentation target must be an integer");
            value.adaptive=AdaptivePacingConfig{static_cast<unsigned>(target),graph.multiplier};
            const auto stable=read("RESHADE_STABLE_CADENCE");
            if(!stable.empty()&&stable!="0"&&stable!="1")throw std::runtime_error("Smooth cadence must be zero or one");
            value.adaptive->stableCadence=stable=="1";
        }
        value.generation=std::move(graph);
    }
    return value;
}
namespace {
std::string environmentValue(const macfx::LivePacket *p,const char *key){
        if(p){const std::string k=key;
            if(k=="RESHADE_SPATIAL_METHOD"){const char*methods[]={"off","bilinear","metalfx","fsr1","mako","ls1","nearest","bicubic"};return std::string(methods[p->spatial]);}
            if(k=="RESHADE_SPATIAL_SHARPNESS")return std::to_string(p->sharpness);
            if(k=="RESHADE_LS1_MODE")return std::string(p->ls1Mode?"performance":"quality");
            if(k=="RESHADE_FRAME_GENERATION")return std::string(p->flags&1?"lsfg":"off");
            if(k=="RESHADE_FRAME_MULTIPLIER")return std::to_string(p->multiplier);
            if(k=="RESHADE_FRAME_PACING")return std::string(p->flags&2?"adaptive":"fixed");
            if(k=="RESHADE_TARGET_HZ")return std::to_string(p->targetHz);
            if(k=="RESHADE_STABLE_CADENCE")return std::string(p->flags&4?"1":"0");
            if(k=="RESHADE_LSFG_MODE")return std::string(p->lsfgMode&1?"performance":"quality");
            if(k=="RESHADE_LSFG_FP16")return std::string(p->lsfgMode&2?"1":"0");
            if(k=="RESHADE_LSFG_FLOW_SCALE")return std::to_string(p->flowScale);
        }const auto value=macfx::nativeConfig().graphics.find(key);return value&&*value?**value:std::string{};
}
bool legacyGraphicsRequested()noexcept{
    if(macfx::liveEffects()){const auto p=macfx::livePacket();return p&&(p->spatial||(p->flags&1));}
    const auto &graphics=macfx::nativeConfig().graphics;return graphics.spatialRequested||graphics.generationRequested;
}
}
// Launch values are immutable per configuration generation, so a parse
// without live controls is cached by configuration identity.
const macfx::GraphicsConfig &macfx::graphicsEnvironmentView() {
    const auto state=liveEffects()?&liveState():nullptr;const auto launch=&nativeConfig();
    thread_local uint64_t applied=~uint64_t(0);thread_local const NativeConfig *parsed=nullptr;thread_local GraphicsConfig cached;
    if(state?applied==state->generation:parsed==launch)return cached;
    const auto p=state?state->controls.get():nullptr;
    auto result=graphicsConfig([p](const char *key){return environmentValue(p,key);});
    cached=std::move(result);if(state){applied=state->generation;parsed=nullptr;}else{parsed=launch;applied=~uint64_t(0);}return cached;
}
macfx::GraphicsConfig macfx::graphicsEnvironment() {return graphicsEnvironmentView();}
const macfx::GraphicsConfig &macfx::presentationGraphicsEnvironment() {
    // Empty Advanced is explicit passthrough too. The executor, rather than
    // legacy startup options, adopts each ordered row and its model binding.
    const auto launch=&nativeConfig();
    if(launch->effectPlanRequested()&&effectPlanMode()!=0){static const GraphicsConfig inert;return inert;}
    const auto state=liveEffects()?&liveState():nullptr;
    thread_local uint64_t applied=~uint64_t(0);thread_local const NativeConfig *parsed=nullptr;thread_local GraphicsConfig cached;
    if(state?applied==state->generation:parsed==launch)return cached;
    const auto packet=state?state->controls.get():nullptr;
    const auto &model=launch->graphics.losslessModel;
    const bool bound=model&&!model->empty()&&model->front()=='/';
    cached=graphicsConfig([packet,bound](const char *key){
        auto value=environmentValue(packet,key);
        // New controls can precede the activation-last ordered plan. Keep
        // independent shaders/scalers usable while its resource owner arrives.
        if(!bound&&((!std::strcmp(key,"RESHADE_FRAME_GENERATION"))||
            (!std::strcmp(key,"RESHADE_SPATIAL_METHOD")&&value=="ls1")))return std::string("off");
        return value;
    });
    if(state){applied=state->generation;parsed=nullptr;}else{parsed=launch;applied=~uint64_t(0);}return cached;
}

bool macfx::graphicsRequested() noexcept {
    const auto &config=nativeConfig();
    if(config.render.variables||config.effectPlanFile)return true;
    if(config.liveEffects()){thread_local bool used=false;const auto p=livePacket();used|=p&&(p->spatial||(p->flags&1));return used;}
    return config.graphics.spatialRequested||config.graphics.generationRequested;
}

namespace {
bool legacyPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight) {
    using namespace macfx;
    if(liveEffects()){const auto p=livePacket();if(!p)return false;if(p->flags&9)return true;if(!p->spatial)return false;}
    if(legacyEffectRequested()||(!liveEffects()&&nativeConfig().graphics.generationRequested))return true;
    return sourceWidth==0||sourceHeight==0||outputWidth==0||outputHeight==0||sourceWidth!=outputWidth||sourceHeight!=outputHeight;
}
bool legacyNativeFxOnly()noexcept{try{
    using namespace macfx;
    if(legacyEffectRequested()){
        bool otherProcessing=false;
        if(liveEffects()){const auto p=livePacket();otherProcessing=!p||p->spatial||(p->flags&1);}
        else otherProcessing=nativeConfig().graphics.spatialRequested||nativeConfig().graphics.generationRequested;
        const auto &file=effectSelection().file;
        if(!otherProcessing&&file.size()>=3&&file.compare(file.size()-3,3,".fx")==0)return true;
    }
    return false;
}catch(...){return false;}}
}
bool macfx::automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight) noexcept {
    if(nativeConfig().effectPlanFile){
        const auto mode=effectPlanMode();if(mode)return mode==1;
        if(!legacyEffectRequested()&&!legacyGraphicsRequested())return false;
    }
    return legacyPresentationNeeded(sourceWidth,sourceHeight,outputWidth,outputHeight);
}
bool macfx::automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight,AutomaticPresentationCapabilities capabilities) noexcept {
    if(capabilities.sameSizeNativeFxInPlace&&sourceWidth&&sourceHeight&&outputWidth&&outputHeight){
        const auto mode=nativeConfig().effectPlanFile?effectPlanMode():0;
        if((mode==1&&effectPlanNativeFxOnly())||(!mode&&legacyNativeFxOnly()))return false;
    }
    return automaticPresentationNeeded(sourceWidth,sourceHeight,outputWidth,outputHeight);
}
bool macfx::automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight,AutomaticPresentationCapabilities capabilities,const EffectPlanSnapshot &selected) noexcept {
    const bool inPlace=capabilities.sameSizeNativeFxInPlace&&sourceWidth&&sourceHeight&&outputWidth&&outputHeight;
    if(selected.mode=="advanced")return std::any_of(selected.nodes.begin(),selected.nodes.end(),[](const auto &node){return node.enabled;})&&
        !(inPlace&&effectPlanNativeFxOnly(selected));
    if(inPlace&&legacyNativeFxOnly())return false;
    if(!legacyEffectRequested()&&!legacyGraphicsRequested())return false;
    return legacyPresentationNeeded(sourceWidth,sourceHeight,outputWidth,outputHeight);
}
bool macfx::imageProcessingRequested(bool activePresentation) noexcept {
    return activePresentation||effectRequested()||(graphicsRequested()&&automaticPresentationNeeded(0,0,0,0));
}
