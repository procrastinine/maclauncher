#pragma once
#import <QuartzCore/CAMetalLayer.h>
#include <atomic>
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
    struct State {std::mutex mutex;unsigned held=0;std::shared_ptr<Hold> displayed;std::chrono::steady_clock::time_point refusing{};};
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
    // nil, without calling nextDrawable, while every drawable is held; nil as
    // well when Core Animation returns none. Callers treat both as busy.
    id<CAMetalDrawable> acquire(CAMetalLayer *layer){
        if(!layer)return nil;
        const NSUInteger capacity=layer.maximumDrawableCount;
        // Reserve before the call so concurrent producers cannot exceed the
        // capacity. The hold returns the reservation when no drawable arrives.
        {std::lock_guard<std::mutex>lock(state->mutex);
         if(state->held>=capacity){if(state->refusing==std::chrono::steady_clock::time_point{})state->refusing=std::chrono::steady_clock::now();return nil;}
         ++state->held;state->refusing={};}
        auto hold=std::make_shared<Hold>(state);
        id<CAMetalDrawable> drawable=[layer nextDrawable];
        if(!drawable)return nil;
        // An unpresented drawable releases this handler, and the hold, with itself.
        std::weak_ptr<State> weak=state;
        [drawable addPresentedHandler:^(id<MTLDrawable> presented){
            const double time=presented.presentedTime;
            if(!std::isfinite(time)||time<=0){hold->release();return;}
            std::shared_ptr<Hold> replaced;
            if(auto owner=weak.lock()){std::lock_guard<std::mutex>lock(owner->mutex);replaced=std::exchange(owner->displayed,hold);}
            else hold->release();
            if(replaced)replaced->release();
        }];
        return drawable;
    }
};
}
