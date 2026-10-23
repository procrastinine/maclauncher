#include "diagnostics.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>

namespace macfx {
namespace {
constexpr unsigned stageCount=unsigned(DiagnosticStage::Count),slotCount=64,queueCount=256;
const char *names[]={"hooks","window-resolve","window-publish","window-surface","window-selected",
    "metal-frame","metal-ownership","metal-runtime-lock","metal-encode",
    "metal-queue","metal-commit","metal-producer-wait","metal-effect-wait","metal-drawable",
    "opengl-frame","opengl-ownership","opengl-context-lock","opengl-context-bind",
    "opengl-runtime-lock","opengl-state","opengl-effects","opengl-source-copy",
    "opengl-source-wait","opengl-copy-back","opengl-copy-wait","opengl-flush","opengl-cleanup","presented-real","presented-generated"};
static_assert(sizeof(names)/sizeof(*names)==stageCount);
uint64_t now() {return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();}
uint64_t option(const char *name,uint64_t fallback,uint64_t minimum,uint64_t maximum) {
    const char *value=std::getenv(name);if(!value || !*value) return fallback;
    char *end=nullptr;const auto n=std::strtoull(value,&end,10);
    if(end==value || *end || *value=='-') return fallback;
    return n<minimum?minimum:n>maximum?maximum:n;
}
struct Statistics {
    std::atomic<uint64_t> starts{0},count{0},total{0},maximum{0},lastSlow{0};
};
struct Event {const char *kind=nullptr;DiagnosticSnapshot snapshot;uint64_t elapsed=0,time=0;unsigned thread=0;};
}
struct DiagnosticSlot {
    unsigned index=0;
    uint64_t nextToken=0;
    std::atomic<uint64_t> sequence{0},token{0},started{0},object{0};
    std::atomic<unsigned> stage{stageCount},width{0},height{0};
    DiagnosticSnapshot read() const {
        for(unsigned attempt=0;attempt<3;++attempt) {
            const auto before=sequence.load(std::memory_order_acquire);if(before&1) continue;
            DiagnosticSnapshot result{token.load(std::memory_order_relaxed),started.load(std::memory_order_relaxed),object.load(std::memory_order_relaxed),
                stage.load(std::memory_order_relaxed),width.load(std::memory_order_relaxed),height.load(std::memory_order_relaxed)};
            if(before==sequence.load(std::memory_order_acquire)) return result;
        }
        return {};
    }
    void write(const DiagnosticSnapshot &value) {
        sequence.fetch_add(1,std::memory_order_acq_rel);
        token.store(value.token,std::memory_order_relaxed);started.store(value.started,std::memory_order_relaxed);object.store(value.object,std::memory_order_relaxed);
        stage.store(value.stage,std::memory_order_relaxed);width.store(value.width,std::memory_order_relaxed);height.store(value.height,std::memory_order_relaxed);
        sequence.fetch_add(1,std::memory_order_release);
    }
};
namespace {
struct State {
    std::array<DiagnosticSlot,slotCount> slots;
    std::array<Statistics,stageCount> statistics;
    std::atomic<unsigned> nextSlot{0};
    std::atomic<bool> active{true};
    std::atomic<uint64_t> dropped{0};
    std::mutex queueMutex;
    std::array<Event,queueCount> events;
    unsigned count=0;
    const uint64_t started=now();
    const uint64_t limit=option("RESHADE_DIAGNOSTICS_LIMIT",512,2,4096);
    const uint64_t duration=option("RESHADE_DIAGNOSTICS_DURATION_MS",180000,100,600000)*1000000;
    const uint64_t slow=option("RESHADE_DIAGNOSTICS_SLOW_MS",25,1,10000)*1000000;
    const std::string path=std::string(std::getenv("RESHADE_DIAGNOSTICS"))+"."+std::to_string(getpid())+".jsonl";
    State() {for(unsigned i=0;i<slotCount;++i) slots[i].index=i;std::thread([this]{run();}).detach();}
    void enqueue(const Event &event) {
        if(!active.load(std::memory_order_relaxed)) return;
        std::unique_lock<std::mutex> lock(queueMutex,std::try_to_lock);
        if(!lock || count==queueCount) {dropped.fetch_add(1,std::memory_order_relaxed);return;}
        events[count++]=event;
    }
    void run() noexcept {try {
        std::ofstream output(path,std::ios::app);
        if(!output) {active=false;return;}
        uint64_t records=1,lastAggregate=started;
        std::array<uint64_t,slotCount> pendingToken{},pendingAt{};
        output<<"{\"kind\":\"session\",\"pid\":"<<getpid()<<",\"max_records\":"<<limit<<",\"duration_ms\":"<<duration/1000000
            <<",\"slow_ms\":"<<slow/1000000<<",\"clock\":\"monotonic\",\"elapsed_scope\":\"cpu-inclusive\"}\n";
        auto write=[&](const Event &event) {
            if(records>=limit-1 || event.snapshot.stage>=stageCount) return;
            output<<"{\"kind\":\""<<event.kind<<"\",\"pid\":"<<getpid()<<",\"thread_slot\":"<<event.thread
                <<",\"stage\":\""<<names[event.snapshot.stage]<<"\",\"token\":"<<event.snapshot.token
                <<",\"object\":"<<event.snapshot.object<<",\"width\":"<<event.snapshot.width<<",\"height\":"<<event.snapshot.height
                <<",\"at_ms\":"<<double(event.time-started)/1e6<<",\"cpu_ms\":"<<double(event.elapsed)/1e6<<"}\n";
            ++records;
        };
        while(active.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::array<Event,queueCount> batch;unsigned length;
            {std::lock_guard<std::mutex> lock(queueMutex);length=count;for(unsigned i=0;i<count;++i) batch[i]=events[i];count=0;}
            for(unsigned i=0;i<length;++i) write(batch[i]);
            const auto time=now();
            for(unsigned i=0;i<slotCount;++i) {
                const auto snapshot=slots[i].read();
                if(snapshot.stage>=stageCount || !snapshot.started) continue;
                const auto elapsed=time-snapshot.started;
                if(elapsed>=200000000 && (pendingToken[i]!=snapshot.token || time-pendingAt[i]>=1000000000)) {
                    write({"pending",snapshot,elapsed,time,i});pendingToken[i]=snapshot.token;pendingAt[i]=time;
                }
            }
            if(time-lastAggregate>=1000000000 && records<limit-1) {
                output<<"{\"kind\":\"aggregate\",\"pid\":"<<getpid()<<",\"at_ms\":"<<double(time-started)/1e6
                    <<",\"dropped_events\":"<<dropped.load()<<",\"stages\":[";
                bool first=true;
                for(unsigned i=0;i<stageCount;++i) {
                    auto &stats=statistics[i];const auto samples=stats.count.load();if(!samples) continue;
                    if(!first) output<<',';first=false;
                    output<<"{\"stage\":\""<<names[i]<<"\",\"count\":"<<samples<<",\"cpu_total_ms\":"<<double(stats.total.load())/1e6
                        <<",\"cpu_max_ms\":"<<double(stats.maximum.load())/1e6<<'}';
                }
                output<<"]}\n";++records;lastAggregate=time;
            }
            output.flush();
            if(records>=limit-1 || time-started>=duration) {
                active=false;
                output<<"{\"kind\":\"stopped\",\"pid\":"<<getpid()<<",\"reason\":\""<<(records>=limit-1?"record-limit":"duration")
                    <<"\",\"records\":"<<records+1<<",\"dropped_events\":"<<dropped.load()<<"}\n";
            }
        }
    } catch(...) {active=false;}}
};
State &state() {static auto *value=new State;return *value;}
DiagnosticSlot *threadSlot(State &value) {
    static thread_local DiagnosticSlot *slot=[&] {
        const auto index=value.nextSlot.fetch_add(1);return index<slotCount?&value.slots[index]:nullptr;
    }();
    return slot;
}
}
bool diagnosticsEnabled() noexcept {
    static const bool enabled=[] {const char *path=std::getenv("RESHADE_DIAGNOSTICS");return path && *path;}();
    return enabled;
}
namespace {
struct GpuSample {const char *scope=nullptr;unsigned width=0,height=0;double milliseconds=0;bool valid=false;uint64_t sample=0,completed=0;};
struct GpuOutput {
    std::mutex mutex;
    std::array<GpuSample,256> pending;
    unsigned count=0;
    std::atomic<uint64_t> observed{0},dropped{0};
    std::atomic<bool> active{true};
    const uint64_t warmup=option("RESHADE_GPU_TIMING_WARMUP",30,0,100000);
    const uint64_t limit=option("RESHADE_GPU_TIMING_LIMIT",2000,1,20000);
    const std::string path=std::string(std::getenv("RESHADE_GPU_TIMING"))+"."+std::to_string(getpid())+".jsonl";
    GpuOutput() {std::thread([this] {try {
        std::ofstream output(path,std::ios::app);if(!output) {active=false;return;}
        const auto started=now();
        while(active.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::array<GpuSample,256> batch;unsigned length;
            {std::lock_guard<std::mutex> lock(mutex);length=count;for(unsigned i=0;i<count;++i) batch[i]=pending[i];count=0;}
            for(unsigned i=0;i<length;++i) {
                const auto &sample=batch[i];
                output<<"{\"pid\":"<<getpid()<<",\"sample\":"<<sample.sample<<",\"scope\":\""<<sample.scope
                    <<"\",\"width\":"<<sample.width<<",\"height\":"<<sample.height<<",\"completed_at_ms\":"<<sample.completed
                    <<",\"gpu_ms\":"<<sample.milliseconds<<",\"valid\":"<<(sample.valid?"true":"false")
                    <<",\"dropped_samples\":"<<dropped.load()<<"}\n";
            }
            output.flush();
            if(observed.load()>=warmup+limit || now()-started>=600000000000) active=false;
        }
    } catch(...) {active=false;}}).detach();}
    void record(const char *scope,unsigned width,unsigned height,double milliseconds,bool valid) {
        if(!active.load(std::memory_order_relaxed)) return;
        const auto sample=observed.fetch_add(1,std::memory_order_relaxed);
        if(sample<warmup || sample-warmup>=limit) return;
        const auto completed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        std::unique_lock<std::mutex> lock(mutex,std::try_to_lock);
        if(!lock || count==pending.size()) {dropped.fetch_add(1,std::memory_order_relaxed);return;}
        pending[count++]={scope,width,height,milliseconds,valid,sample,uint64_t(completed)};
    }
};
GpuOutput &gpuOutput() {static auto *output=new GpuOutput;return *output;}
}
bool gpuTimingEnabled() noexcept {
    static const bool enabled=[] {const char *path=std::getenv("RESHADE_GPU_TIMING");return path && *path;}();
    if(!enabled) return false;
    try {auto &output=gpuOutput();return output.active.load(std::memory_order_relaxed) && output.observed.load(std::memory_order_relaxed)<output.warmup+output.limit;} catch(...) {return false;}
}
void recordGpuDuration(const char *scope,unsigned width,unsigned height,double milliseconds,bool valid) noexcept {
    if(!gpuTimingEnabled()) return;
    try {gpuOutput().record(scope,width,height,milliseconds,valid);} catch(...) {}
}
void diagnosticEvent(DiagnosticStage stage,uintptr_t object,unsigned width,unsigned height) noexcept {
    if(!diagnosticsEnabled()) return;
    try {
        auto &value=state();if(!value.active.load(std::memory_order_relaxed)) return;
        auto *slot=threadSlot(value);if(!slot) return;
        DiagnosticSnapshot snapshot{++slot->nextToken,now(),object,unsigned(stage),width,height};
        value.enqueue({"state",snapshot,0,snapshot.started,slot->index});
    } catch(...) {}
}
DiagnosticScope::DiagnosticScope(DiagnosticStage stage,uintptr_t object,unsigned width,unsigned height) noexcept {
    if(!diagnosticsEnabled()) return;
    try {
        auto &value=state();if(!value.active.load(std::memory_order_relaxed)) return;
        slot_=threadSlot(value);if(!slot_) return;
        previous_=slot_->read();
        current_={++slot_->nextToken,now(),object,unsigned(stage),width,height};
        slot_->write(current_);
        transition_=value.statistics[unsigned(stage)].starts.fetch_add(1,std::memory_order_relaxed)<2;
        if(transition_) value.enqueue({"begin",current_,0,current_.started,slot_->index});
    } catch(...) {slot_=nullptr;}
}
DiagnosticScope::~DiagnosticScope() {
    if(!slot_) return;
    const auto time=now(),elapsed=time-current_.started;slot_->write(previous_);
    auto &value=state();auto &stats=value.statistics[current_.stage];
    stats.total.fetch_add(elapsed,std::memory_order_relaxed);stats.count.fetch_add(1,std::memory_order_relaxed);
    auto maximum=stats.maximum.load(std::memory_order_relaxed);
    while(maximum<elapsed && !stats.maximum.compare_exchange_weak(maximum,elapsed,std::memory_order_relaxed)) {}
    if(transition_) value.enqueue({"end",current_,elapsed,time,slot_->index});
    else if(elapsed>=value.slow) {
        auto previous=stats.lastSlow.load(std::memory_order_relaxed);
        if(time-previous>=1000000000 && stats.lastSlow.compare_exchange_strong(previous,time,std::memory_order_relaxed))
            value.enqueue({"slow",current_,elapsed,time,slot_->index});
    }
}
}
