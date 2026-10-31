// Copyright (c) MacLauncher contributors. MIT license.
// Performance overlay counter assembly and the source frame-rate cap slots.
#include "../hud-counters.hpp"
#include "../source-frame-cap.hpp"
#include <cstdio>
#include <cstdlib>
#define CHECK(condition) do{if(!(condition)){std::fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#condition);std::exit(1);}}while(0)
using namespace macfx;
int main(){
    HudSample first,second;
    first.time=10;first.counters={100,100,100,200,1};
    second.time=11;second.counters={160,160,180,340,3};second.refreshHz=120;second.captureIntervalMs=16.7;second.gpuMs=4;
    second.displayTimes={11,11.01,11.02,11.03,11.04,11.05};
    const auto report=assembleHud(first,second);
    CHECK(report.captureFps==60);CHECK(report.outputFps==140);CHECK(report.generatedFps==80);
    CHECK(report.invariantHolds);CHECK(report.budgetMs>8.3&&report.budgetMs<8.4);
    CHECK(report.targetFps==60);                       // no pacing target: the capture rate
    CHECK(report.pacingScore>99);
    // No generation is required for a measured 60 Hz display and its budget.
    // The target follows the counter rate, not one irregular capture interval.
    auto plainFirst=first;plainFirst.counters={100,100,0,100,0};
    auto plain=second;plain.counters={160,160,0,160,0};plain.refreshHz=60;plain.captureIntervalMs=40;
    const auto ungenerated=assembleHud(plainFirst,plain);
    CHECK(ungenerated.refreshHz==60&&ungenerated.budgetMs>16.6&&ungenerated.budgetMs<16.7);
    CHECK(ungenerated.targetFps==60&&ungenerated.outputFps==60&&ungenerated.invariantHolds);
    plain.targetFps=30;CHECK(assembleHud(plainFirst,plain).targetFps==30);
    // Missing host timing is unknown, never a zero-Hz display or zero budget.
    plain.refreshHz=0;const auto unknown=hudLines(assembleHud(plainFirst,plain),false);
    CHECK(unknown[1].find("display – Hz")!=std::string::npos);
    CHECK(unknown[2].find(" / – ms")!=std::string::npos);
    // A counter that disagrees with its parts is reported, never hidden.
    HudSample broken=second;broken.counters.presented=339;
    const auto mismatch=assembleHud(first,broken);CHECK(!mismatch.invariantHolds);
    const auto lines=hudLines(mismatch,false);CHECK(lines.back().find("Counter mismatch")!=std::string::npos);
    // A restarted presenter's counters give no negative or huge rates.
    HudSample restarted=second;restarted.time=12;restarted.counters={5,5,0,5,0};
    const auto reset=assembleHud(second,restarted);CHECK(reset.captureFps==0&&reset.outputFps==0);
    // Uneven display intervals lower the pacing score; too few give none.
    CHECK(hudPacingScore({1,1.01,1.03,1.04,1.07,1.08})<80);CHECK(hudPacingScore({1,2})<0);
    // Detailed lines carry every counter; unmeasured values are a dash.
    const auto detailed=hudLines(report,true);bool counters=false;
    for(const auto&line:detailed)counters|=line.find("Captured 160 · Presented 340 · Generated 180 · Passthrough 160 · Dropped 3")!=std::string::npos;
    CHECK(counters);CHECK(hudNumber(-1)=="–");
    // Row GPU times are listed with their own interval or their shared section.
    auto withRows=report;withRows.rows={{"bloom","",0.5},{"lut","",1.25,true,2}};bool own=false,shared=false;
    for(const auto&line:hudLines(withRows,true)){own|=line=="  bloom 0.50 ms";shared|=line=="  lut 1.25 ms (section 2, shared)";}
    CHECK(own&&shared);
    // Frame cap slots: the first frame passes, the next waits one interval, and
    // a producer more than one interval late restarts without a burst.
    SourceFrameCap cap;int owner=0;
    CHECK(cap.reserve(&owner,100,1000)==0);
    CHECK(cap.reserve(&owner,100,1010)==1100);
    CHECK(cap.reserve(&owner,100,1200)==0);
    CHECK(cap.reserve(&owner,100,1500)==0);
    CHECK(cap.reserve(&owner,100,1510)==1600);
    CHECK(cap.reserve(nullptr,100,1)==0&&cap.reserve(&owner,0,1)==0);
    std::puts("hud-counters: pass");
}
