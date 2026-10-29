#pragma once
#include <string>
#include "adaptive-quality.hpp"
namespace macfx {
struct ComparisonSettings {
 std::string mode="off";double position=.5,gain=1;
 bool active()const noexcept{return mode!="off";}
};
struct OutputPolicy {
 ComparisonSettings comparison;
 AdaptiveQualitySettings adaptiveQuality;
 std::string toneMapping="auto";
 std::string motionClarity="off";unsigned subframes=2;double duty=.5,brightness=1;
 std::string framePacing="fixed";unsigned targetFps=120;bool smoothCadence=false,hasPacing=false;
 bool active()const noexcept{return motionClarity!="off";}
 bool processing()const noexcept{return active()||comparison.active()||toneMapping!="auto";}
};
}
