#pragma once
#import <QuartzCore/CAMetalLayer.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <utility>

namespace macfx {
// The drawables of an owned output layer that Core Animation has not taken
// back: acquired and not yet presented, queued for display, or displayed until
// a later drawable replaces it. -[CAMetalLayer nextDrawable] blocks its caller,
// for up to one second, while every drawable is in use. Acquisition therefore
// refuses at maximumDrawableCount instead of calling it, so a held output
// never delays the thread that submits the game's frame.
class OverlayDrawables {
    class Hold;
    struct State {std::mutex mutex;unsigned held=0,limit=0;std::shared_ptr<Hold> displayed;std::chrono::steady_clock::time_point refusing{};};
    class Hold {
        std::weak_ptr<State> owner;std::atomic<bool> released{false};
    public:
        explicit Hold(std::weak_ptr<State> value):owner(std::move(value)){}
        Hold(const Hold&)=delete;Hold &operator=(const Hold&)=delete;
        ~Hold(){release();}
        void release(){if(released.exchange(true))return;if(auto state=owner.lock()){std::lock_guard<std::mutex>lock(state->mutex);if(state->held)--state->held;}}
    };
    const std::shared_ptr<State> state=std::make_shared<State>();
public:
    unsigned held()const{std::lock_guard<std::mutex>lock(state->mutex);return state->held;}
    // Duration of the current run of refusals; zero after any admission.
    double refusingSeconds()const{
        std::lock_guard<std::mutex>lock(state->mutex);
        return state->refusing==std::chrono::steady_clock::time_point{}?0:std::chrono::duration<double>(std::chrono::steady_clock::now()-state->refusing).count();
    }
    // The backing pool is fixed before a layer is attached. Live count edits
    // change admission without reconfiguring that attached pool (macOS 27).
    void setCapacity(unsigned count){std::lock_guard lock(state->mutex);state->limit=count;}
    unsigned capacity(CAMetalLayer *layer)const{
        if(!layer)return 0;const unsigned physical=unsigned(layer.maximumDrawableCount);
        std::lock_guard lock(state->mutex);return state->limit?std::min(state->limit,physical):physical;
    }
private:
    std::shared_ptr<Hold> reserve(CAMetalLayer *layer){
        if(!layer)return {};const unsigned physical=unsigned(layer.maximumDrawableCount);
        std::lock_guard lock(state->mutex);const unsigned capacity=state->limit?std::min(state->limit,physical):physical;
        if(state->held>=capacity){if(state->refusing==std::chrono::steady_clock::time_point{})state->refusing=std::chrono::steady_clock::now();return {};}
        ++state->held;state->refusing={};return std::make_shared<Hold>(state);
    }
    id<CAMetalDrawable> track(id<CAMetalDrawable> drawable,std::shared_ptr<Hold> hold){
        if(!drawable)return nil;
        std::weak_ptr<State> weak=state;
        [drawable addPresentedHandler:^(id<MTLDrawable> presented){
            const double time=presented.presentedTime;
            if(!std::isfinite(time)||time<=0){hold->release();return;}
            std::shared_ptr<Hold> replaced;
            if(auto owner=weak.lock()){std::lock_guard<std::mutex>lock(owner->mutex);replaced=std::exchange(owner->displayed,hold);}
            else hold->release();
            if(replaced)replaced->release();
        }];return drawable;
    }
public:
    // CAMetalDisplayLink already acquired its update drawable. Track that exact
    // lease instead of calling nextDrawable a second time for the same tick.
    id<CAMetalDrawable> adopt(CAMetalLayer *layer,id<CAMetalDrawable> drawable){
        if(!drawable)return nil;auto hold=reserve(layer);return hold?track(drawable,std::move(hold)):nil;
    }
    id<CAMetalDrawable> acquire(CAMetalLayer *layer){
        auto hold=reserve(layer);if(!hold)return nil;return track([layer nextDrawable],std::move(hold));
    }
};
}
