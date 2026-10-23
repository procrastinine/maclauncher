#include "graphics.hpp"
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
    if(value.spatialMethod!="off"&&value.spatialMethod!="bilinear"&&value.spatialMethod!="metalfx"&&value.spatialMethod!="mako"&&value.spatialMethod!="ls1"&&value.spatialMethod!="fsr1")
        throw std::runtime_error("Unknown spatial scaling method");
    const auto generation=read("RESHADE_FRAME_GENERATION");
    if(!generation.empty()&&generation!="off"&&generation!="lsfg")
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
    if(generation=="lsfg") {
        LsfgConfig graph;graph.modelPath=value.modelPath;
        const double multiplier=number(read,"RESHADE_FRAME_MULTIPLIER",2,2,5);
        if(std::floor(multiplier)!=multiplier)throw std::runtime_error("Frame multiplier must be an integer");
        graph.multiplier=static_cast<unsigned>(multiplier);
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
        }
        value.generation=std::move(graph);
    }
    return value;
}
macfx::GraphicsConfig macfx::graphicsEnvironment() {
    return graphicsConfig([](const char*key){const auto value=std::getenv(key);return value?std::string(value):std::string{};});
}

bool macfx::graphicsRequested() noexcept {
    const auto spatial=std::getenv("RESHADE_SPATIAL_METHOD"),generation=std::getenv("RESHADE_FRAME_GENERATION");
    return (spatial&&*spatial&&std::strcmp(spatial,"off")!=0)||(generation&&*generation&&std::strcmp(generation,"off")!=0);
}

bool macfx::automaticPresentationNeeded(unsigned sourceWidth,unsigned sourceHeight,unsigned outputWidth,unsigned outputHeight) noexcept {
    const auto generation=std::getenv("RESHADE_FRAME_GENERATION");
    if(std::getenv("RESHADE_EFFECT")||(generation&&*generation&&std::strcmp(generation,"off")!=0))return true;
    return sourceWidth==0||sourceHeight==0||outputWidth==0||outputHeight==0||sourceWidth!=outputWidth||sourceHeight!=outputHeight;
}
