#pragma once
#include "log.hpp"
#include "live-control-diagnostics.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <unistd.h>

namespace macfx::remoteIngressDiagnostics {
// Metadata only. Callers must authenticate an IOSurface before inspecting it.
// Record methods never write logs: publisher/map locks may still be held.
// poll() belongs outside those locks, on the existing window-publication timer.
// The ten-second budget starts at the first contents/context event, not install.
struct Selection {
    bool state=false,stable=false,listed=false,dimensions=false;
    uint32_t window=0,width=0,height=0,pointsWidth=0,pointsHeight=0,count=0;
};
struct Surface {
    uintptr_t layer=0,contents=0,contextLayer=0;
    uint32_t surface=0,format=0,context=0,window=0;
    unsigned width=0,height=0,outputWidth=0,outputHeight=0,ancestors=0;
    bool completeHierarchy=false,graphics=false,effects=false,local=false,replay=false;
    Selection selected;
};
namespace detail {
using Clock=std::chrono::steady_clock;
struct State {
    std::mutex mutex;
    std::atomic<bool> finished{false},pending{false},running{false};
    Clock::time_point started{},lastSummary{};
    bool began=false,final=false;
    std::atomic<uint64_t> raw{0},replays{0},surfaces{0},contextCalls{0},owned{0},bitmap{0},other{0},dropped{0};
    uint64_t repeatedSurfaces=0;
    unsigned records=0,details=0,queued=0,classCount=0,surfaceCount=0,contextDetails=0,controlCount=0;
    std::array<std::string,128> queue;
    std::array<std::pair<uintptr_t,uintptr_t>,32> classes{};
    std::array<std::string,64> surfaceKeys;
    std::array<std::string,16> controlKeys;
};
inline State &state(){static auto *value=new State;return *value;}
inline void enqueue(State &value,std::string message,bool summary=false){
    // Reserve one record for the terminal aggregate and fifteen for summaries.
    if(value.records>=127||(!summary&&value.details>=112))return;
    value.queue[value.queued++]="remote-ingress pid="+std::to_string(getpid())+" "+std::move(message);
    ++value.records;if(!summary)++value.details;
    value.pending.store(true,std::memory_order_release);
}
inline std::string counts(const State &value){
    return " raw="+std::to_string(value.raw.load(std::memory_order_relaxed))+" replay="+std::to_string(value.replays.load(std::memory_order_relaxed))+
        " surfaces="+std::to_string(value.surfaces.load(std::memory_order_relaxed))+" setContextLayer="+std::to_string(value.contextCalls.load(std::memory_order_relaxed))+
        " surfaceTuples="+std::to_string(value.surfaceCount)+" repeatedSurfaceTuples="+std::to_string(value.repeatedSurfaces)+
        " controlStates="+std::to_string(value.controlCount)+
        " owned="+std::to_string(value.owned.load(std::memory_order_relaxed))+" bitmap="+std::to_string(value.bitmap.load(std::memory_order_relaxed))+
        " other="+std::to_string(value.other.load(std::memory_order_relaxed))+" dropped="+std::to_string(value.dropped.load(std::memory_order_relaxed));
}
inline void finish(State &value,Clock::time_point now){
    if(value.final)return;
    enqueue(value,"summary final=1 elapsedMs="+std::to_string(
        std::chrono::duration_cast<std::chrono::milliseconds>(now-value.started).count())+counts(value),true);
    value.final=true;value.finished.store(true,std::memory_order_release);
    value.running.store(false,std::memory_order_release);
}
inline bool event(State &value){
    if(value.finished.load(std::memory_order_relaxed))return false;
    const auto now=Clock::now();
    if(!value.began){value.began=true;value.started=value.lastSummary=now;value.running.store(true,std::memory_order_release);}
    if(now-value.started>=std::chrono::seconds(10)||value.records>=126){finish(value,now);return false;}
    return true;
}
inline std::string pointer(uintptr_t value){return std::to_string(value);}
}
inline bool enabled(){
    static const bool value=[](){const auto *path=std::getenv("RESHADE_DIAGNOSTICS");return path&&*path;}();
    return value;
}
inline bool active(){return enabled()&&!detail::state().finished.load(std::memory_order_relaxed);}
// Availability alone does not start the ten-second event window.
inline void hooks(bool layerRequested,bool contentsHook,bool contextClass,bool contextHook,
                  const char *surfaceClass,const char *surfaceSuperclass,bool sharedState){
    if(!active())return;auto &value=detail::state();std::unique_lock<std::mutex>lock(value.mutex,std::try_to_lock);
    if(!lock.owns_lock()){value.dropped.fetch_add(1,std::memory_order_relaxed);return;}
    detail::enqueue(value,"hooks layerRequested="+std::to_string(layerRequested)+" contentsHook="+std::to_string(contentsHook)+
        " contextClass="+std::to_string(contextClass)+" contextHook="+std::to_string(contextHook)+
        " surfaceClass="+(surfaceClass?surfaceClass:"nil")+" surfaceSuperclass="+(surfaceSuperclass?surfaceSuperclass:"nil")+
        " sharedState="+std::to_string(sharedState));
}
inline void contents(uintptr_t layer,uintptr_t object,uintptr_t type,uintptr_t superclass,
                     const char *name,const char *superName,bool recognized,bool replay){
    if(!active())return;auto &value=detail::state();
    if(replay)value.replays.fetch_add(1,std::memory_order_relaxed);else value.raw.fetch_add(1,std::memory_order_relaxed);
    std::unique_lock<std::mutex>lock(value.mutex,std::try_to_lock);
    if(!lock.owns_lock()){value.dropped.fetch_add(1,std::memory_order_relaxed);return;}if(!detail::event(value))return;
    const std::pair<uintptr_t,uintptr_t> key{type,superclass};
    for(unsigned i=0;i<value.classCount;++i)if(value.classes[i]==key)return;
    if(value.classCount>=value.classes.size())return;value.classes[value.classCount++]=key;
    detail::enqueue(value,"contents-class layer="+detail::pointer(layer)+" contents="+detail::pointer(object)+
        " class="+(name?name:"nil")+" superclass="+(superName?superName:"nil")+
        " exactSurfaceClass="+std::to_string(recognized)+" replay="+std::to_string(replay));
}
enum class Skip { Owned,Bitmap,Other };
inline void skip(Skip reason){
    if(!active())return;auto &value=detail::state();
    if(reason==Skip::Owned)value.owned.fetch_add(1,std::memory_order_relaxed);
    else if(reason==Skip::Bitmap)value.bitmap.fetch_add(1,std::memory_order_relaxed);
    else value.other.fetch_add(1,std::memory_order_relaxed);
}
inline void surface(const Surface &item){
    if(!active())return;auto &value=detail::state();value.surfaces.fetch_add(1,std::memory_order_relaxed);
    std::unique_lock<std::mutex>lock(value.mutex,std::try_to_lock);
    if(!lock.owns_lock()){value.dropped.fetch_add(1,std::memory_order_relaxed);return;}if(!detail::event(value))return;
    const auto &s=item.selected;
    const char *reason=item.window?(!item.graphics&&!item.effects?"matched-no-demand":"matched"):
        !item.completeHierarchy?"ancestor-limit":!item.contextLayer?"no-mapped-context-or-local-owner":
        !s.state?"no-window-state":!item.context?"zero-context-id":!s.stable?"window-state-changing":
        !s.window?"no-selected-window":!s.listed?"context-not-selected":!s.dimensions?"extent-mismatch":"no-owner";
    std::string key=detail::pointer(item.layer)+":"+std::to_string(item.surface)+":"+std::to_string(item.context)+":"+
        detail::pointer(item.contextLayer)+":"+std::to_string(item.width)+":"+std::to_string(item.height)+":"+std::to_string(item.format)+":"+
        std::to_string(item.window)+":"+std::to_string(s.window)+":"+std::to_string(s.width)+":"+
        std::to_string(s.height)+":"+std::to_string(s.pointsWidth)+":"+std::to_string(s.pointsHeight)+":"+
        std::to_string(item.graphics)+":"+std::to_string(item.effects)+":"+reason;
    for(unsigned i=0;i<value.surfaceCount;++i)if(value.surfaceKeys[i]==key){++value.repeatedSurfaces;return;}
    if(value.surfaceCount>=value.surfaceKeys.size())return;value.surfaceKeys[value.surfaceCount++]=std::move(key);
    detail::enqueue(value,"surface layer="+detail::pointer(item.layer)+" contents="+detail::pointer(item.contents)+
        " id="+std::to_string(item.surface)+" format="+std::to_string(item.format)+
        " extent="+std::to_string(item.width)+"x"+std::to_string(item.height)+
        " ancestors="+std::to_string(item.ancestors)+" contextLayer="+detail::pointer(item.contextLayer)+
        " context="+std::to_string(item.context)+" owner="+std::to_string(item.window)+
        " output="+std::to_string(item.outputWidth)+"x"+std::to_string(item.outputHeight)+
        " selected="+std::to_string(s.window)+" backing="+std::to_string(s.width)+"x"+std::to_string(s.height)+
        " points="+std::to_string(s.pointsWidth)+"x"+std::to_string(s.pointsHeight)+" contexts="+std::to_string(s.count)+
        " stateStable="+std::to_string(s.stable)+" contextListed="+std::to_string(s.listed)+
        " extentMatches="+std::to_string(s.dimensions)+" local="+std::to_string(item.local)+
        " graphics="+std::to_string(item.graphics)+" effects="+std::to_string(item.effects)+
        " replay="+std::to_string(item.replay)+" decision="+reason);
}
inline void context(uintptr_t object,uintptr_t layer,uint32_t identifier,bool replaced){
    if(!active())return;auto &value=detail::state();value.contextCalls.fetch_add(1,std::memory_order_relaxed);
    std::unique_lock<std::mutex>lock(value.mutex,std::try_to_lock);
    if(!lock.owns_lock()){value.dropped.fetch_add(1,std::memory_order_relaxed);return;}if(!detail::event(value))return;
    if(value.contextDetails++>=16)return;
    detail::enqueue(value,"setContextLayer contextObject="+detail::pointer(object)+" layer="+detail::pointer(layer)+
        " context="+std::to_string(identifier)+" replaced="+std::to_string(replaced));
}
inline void control(const LiveControlPollDiagnostic &item){
    if(!active())return;auto &value=detail::state();std::unique_lock<std::mutex>lock(value.mutex,std::try_to_lock);
    if(!lock.owns_lock()){value.dropped.fetch_add(1,std::memory_order_relaxed);return;}
    // Control observation must not start/extend the existing source budget.
    if(!value.began||!detail::event(value))return;
    const auto result=liveControlPollResultName(item.result);
    const std::string key=detail::pointer(item.reader)+":"+std::to_string(item.generation)+":"+
        std::to_string(item.loaded)+":"+std::to_string(item.flags)+":"+result+":"+std::to_string(item.error)+":"+
        std::to_string(item.uniformIndex)+":"+std::to_string(item.planMode)+":"+std::to_string(item.live)+":"+
        std::to_string(item.explicitHost)+":"+std::to_string(item.requested);
    for(unsigned i=0;i<value.controlCount;++i)if(value.controlKeys[i]==key)return;
    if(value.controlCount>=value.controlKeys.size())return;value.controlKeys[value.controlCount++]=key;
    detail::enqueue(value,"controls reader="+detail::pointer(item.reader)+" attempts="+std::to_string(item.attempts)+
        " generation="+std::to_string(item.generation)+" loaded="+std::to_string(item.loaded)+" flags="+std::to_string(item.flags)+
        " result="+result+" errno="+std::to_string(item.error)+" uniformIndex="+std::to_string(item.uniformIndex)+
        " planMode="+std::to_string(item.planMode)+" live="+std::to_string(item.live)+
        " explicitHost="+std::to_string(item.explicitHost)+" requested="+std::to_string(item.requested));
}
inline void poll(){
    if(!enabled())return;auto &value=detail::state();
    if(!value.pending.load(std::memory_order_acquire)&&!value.running.load(std::memory_order_acquire))return;
    std::array<std::string,128> messages;unsigned count=0;
    {std::unique_lock<std::mutex>lock(value.mutex,std::try_to_lock);if(!lock.owns_lock())return;
        if(value.began&&!value.final){const auto now=detail::Clock::now();
            if(now-value.started>=std::chrono::seconds(10)||value.records>=126)detail::finish(value,now);
            else if(now-value.lastSummary>=std::chrono::seconds(1)){
                detail::enqueue(value,"summary final=0 elapsedMs="+std::to_string(
                    std::chrono::duration_cast<std::chrono::milliseconds>(now-value.started).count())+detail::counts(value),true);
                value.lastSummary=now;
            }
        }
        count=value.queued;for(unsigned i=0;i<count;++i)messages[i]=std::move(value.queue[i]);value.queued=0;
        value.pending.store(false,std::memory_order_release);
    }
    for(unsigned i=0;i<count;++i)nativeLog(messages[i]);
}
}
