#pragma once
#include <atomic>
#include <functional>
#include <utility>
namespace macfx {
// Completion handlers are also destroyed when an unsubmitted buffer is dropped.
// Release bounded capacity in both cases, with failure semantics on abandonment.
class CompletionLease {
 std::atomic<bool>done{false};std::function<void(bool)>release;
public:
 explicit CompletionLease(std::function<void(bool)>callback):release(std::move(callback)){}
 ~CompletionLease(){finish(false);}
 void finish(bool success){if(!done.exchange(true)){auto callback=std::move(release);callback(success);}}
};
}
