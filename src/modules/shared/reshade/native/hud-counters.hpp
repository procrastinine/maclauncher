#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Performance overlay counters. Plain C++ so the assembly is testable without
// Metal; the presenter fills a sample from counters it already keeps.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace macfx {
// Monotonic presenter counters. Passthrough images are presented real source
// images; generated images come from frame generation. `presented` is counted
// separately at the display callback so the sum can be checked.
struct HudCounters {uint64_t captured=0,passthrough=0,generated=0,presented=0,dropped=0;};
// A negative duration means the value is not measurable for this source. A
// shared row reports the command buffer of its section, as Details does.
struct HudRow {std::string id,method;double gpuMs=-1;bool shared=false;uint32_t section=0;};
struct HudSample {
    double time=0;                     // host seconds
    HudCounters counters;
    double refreshHz=0,targetFps=0,captureIntervalMs=0;
    double gpuMs=-1,budgetMs=0;        // per presented image; budget from refresh or adaptive quality
    double captureLatencyMs=-1,presentationLatencyMs=-1,endToEndLatencyMs=-1;
    std::vector<double> displayTimes;  // recent displayed timestamps, any order
    uint64_t residentBytes=0,gpuBytes=0;
    std::vector<HudRow> rows;
    std::string provider,providerReason;
};
struct HudReport {
    double captureFps=0,outputFps=0,generatedFps=0,targetFps=0,refreshHz=0,captureIntervalMs=0;
    double gpuMs=-1,budgetMs=0,captureLatencyMs=-1,presentationLatencyMs=-1,endToEndLatencyMs=-1;
    double pacingScore=-1;             // 0 to 100; negative until enough images were displayed
    uint64_t residentBytes=0,gpuBytes=0;
    HudCounters counters;
    bool invariantHolds=true;          // generated + passthrough == presented
    std::vector<HudRow> rows;
    std::string provider,providerReason;
};

inline bool hudInvariantHolds(const HudCounters &counters){return counters.generated+counters.passthrough==counters.presented;}

// Evenness of display intervals: 100 means every interval matched the mean.
inline double hudPacingScore(std::vector<double> times){
    times.erase(std::remove_if(times.begin(),times.end(),[](double value){return !std::isfinite(value)||value<=0;}),times.end());
    std::sort(times.begin(),times.end());times.erase(std::unique(times.begin(),times.end()),times.end());
    if(times.size()<5)return -1;
    double sum=0;std::vector<double> intervals;
    for(size_t i=1;i<times.size();++i){intervals.push_back(times[i]-times[i-1]);sum+=intervals.back();}
    const double mean=sum/intervals.size();if(mean<=0)return -1;
    double variance=0;for(const double value:intervals)variance+=(value-mean)*(value-mean);
    const double deviation=std::sqrt(variance/intervals.size());
    return std::clamp(100*(1-deviation/mean),0.,100.);
}

// Rates come from counter differences between two samples. A counter that
// went backwards belongs to a restarted presenter and contributes no rate.
inline HudReport assembleHud(const HudSample &previous,const HudSample &current){
    HudReport report;
    const double elapsed=current.time-previous.time;
    const auto rate=[&](uint64_t before,uint64_t after){return elapsed>0&&after>=before?double(after-before)/elapsed:0.;};
    report.captureFps=rate(previous.counters.captured,current.counters.captured);
    report.outputFps=rate(previous.counters.presented,current.counters.presented);
    report.generatedFps=rate(previous.counters.generated,current.counters.generated);
    report.refreshHz=current.refreshHz;report.captureIntervalMs=current.captureIntervalMs;
    report.targetFps=current.targetFps>0?current.targetFps:report.captureFps;
    if(report.refreshHz>0)report.targetFps=std::min(report.targetFps,report.refreshHz);
    report.gpuMs=current.gpuMs;report.budgetMs=current.budgetMs>0?current.budgetMs:current.refreshHz>0?1000/current.refreshHz:0;
    report.captureLatencyMs=current.captureLatencyMs;report.presentationLatencyMs=current.presentationLatencyMs;report.endToEndLatencyMs=current.endToEndLatencyMs;
    report.pacingScore=hudPacingScore(current.displayTimes);
    report.residentBytes=current.residentBytes;report.gpuBytes=current.gpuBytes;
    report.counters=current.counters;report.invariantHolds=hudInvariantHolds(current.counters);
    report.rows=current.rows;report.provider=current.provider;report.providerReason=current.providerReason;
    return report;
}

inline std::string hudNumber(double value,int precision=0){
    if(!std::isfinite(value)||value<0)return "–";
    char text[32];std::snprintf(text,sizeof(text),"%.*f",precision,value);return text;
}
inline std::string hudBytes(uint64_t bytes){
    if(!bytes)return "–";
    const double megabytes=double(bytes)/(1024*1024);
    return megabytes>=1024?hudNumber(megabytes/1024,2)+" GB":hudNumber(megabytes,0)+" MB";
}
// One string per overlay line. Compact shows rates, GPU time, latency and
// pacing; detailed adds intervals, latency parts, memory, counters, rows and
// the active provider.
inline std::vector<std::string> hudLines(const HudReport &report,bool detailed){
    std::vector<std::string> lines;
    lines.push_back(hudNumber(report.outputFps)+" fps out · "+hudNumber(report.captureFps)+" captured · "+hudNumber(report.generatedFps)+" generated");
    lines.push_back("Target "+hudNumber(report.targetFps)+" fps · display "+hudNumber(report.refreshHz>0?report.refreshHz:-1)+" Hz");
    lines.push_back("GPU "+hudNumber(report.gpuMs,1)+" / "+hudNumber(report.budgetMs>0?report.budgetMs:-1,1)+" ms · latency "+hudNumber(report.endToEndLatencyMs)+" ms · pacing "+hudNumber(report.pacingScore));
    if(detailed){
        lines.push_back("Capture interval "+hudNumber(report.captureIntervalMs,1)+" ms");
        lines.push_back("Latency: capture "+hudNumber(report.captureLatencyMs,1)+" ms, presentation "+hudNumber(report.presentationLatencyMs,1)+" ms, end to end "+hudNumber(report.endToEndLatencyMs,1)+" ms");
        lines.push_back("Memory "+hudBytes(report.residentBytes)+" · GPU memory "+hudBytes(report.gpuBytes));
        const auto&c=report.counters;
        lines.push_back("Captured "+std::to_string(c.captured)+" · Presented "+std::to_string(c.presented)+" · Generated "+std::to_string(c.generated)+
            " · Passthrough "+std::to_string(c.passthrough)+" · Dropped "+std::to_string(c.dropped));
        for(const auto&row:report.rows)lines.push_back("  "+(row.method.empty()?row.id:row.method)+" "+hudNumber(row.gpuMs,2)+" ms"+
            (row.shared?" (section "+std::to_string(row.section)+", shared)":""));
        if(!report.provider.empty())lines.push_back("Provider "+report.provider+(report.providerReason.empty()?"":": "+report.providerReason));
    }
    if(!report.invariantHolds)lines.push_back("Counter mismatch: Generated + Passthrough ≠ Presented");
    return lines;
}
}
